import type { Q } from "../db";
import { attendanceDefinition, externalCond, verifiedCond, type DatasetContext } from "./context";

export const ratio = (n: number, d: number) => (d > 0 ? n / d : null);
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// ---- Attendance -------------------------------------------------------------------
export async function attendanceMetrics(q: Q, ctx: DatasetContext) {
  if (!ctx.caps.checkIns) {
    return { available: false as const, reason: "The selected dataset has no check-in records, so verified attendance cannot be measured." };
  }
  const base = `from check_ins c join people p on p.id = c.person_id
    where c.dataset_version_id = $1 and c.occurred_at <= $2 and ${verifiedCond(ctx)} and ${externalCond(ctx)}`;
  const [tot] = await q<{ people: string; rows: string }>(`select count(distinct c.person_id) people, count(*) rows ${base}`, [ctx.dv, ctx.asOf]);
  const byDay = await q<{ day: string; people: string; rows: string }>(
    `select to_char(c.occurred_at + make_interval(mins => $3), 'YYYY-MM-DD') as day, count(distinct c.person_id) people, count(*) rows ${base} group by 1 order by 1`,
    [ctx.dv, ctx.asOf, ctx.tzOffset]);
  const [multi] = await q<{ n: string }>(
    `select count(*) n from (select c.person_id ${base} group by c.person_id having count(distinct to_char(c.occurred_at + make_interval(mins => $3), 'YYYY-MM-DD')) > 1) x`,
    [ctx.dv, ctx.asOf, ctx.tzOffset]);
  const [excl] = await q<{ total: string; not_verified: string; non_external: string }>(
    `select count(*) total,
            count(*) filter (where not (${verifiedCond(ctx)})) not_verified,
            count(*) filter (where (${verifiedCond(ctx)}) and not (${externalCond(ctx)})) non_external
     from check_ins c join people p on p.id = c.person_id where c.dataset_version_id = $1 and c.occurred_at <= $2`, [ctx.dv, ctx.asOf]);
  const [walk] = ctx.caps.registrations
    ? await q<{ n: string }>(`select count(distinct c.person_id) n ${base} and not exists (select 1 from registrations r where r.person_id = c.person_id and r.dataset_version_id = $1)`, [ctx.dv, ctx.asOf])
    : [{ n: null as unknown as string }];
  return {
    available: true as const,
    uniqueVerifiedAttendees: num(tot.people),
    verifiedAdmissionRows: num(tot.rows),
    byDay: byDay.map((d) => ({ day: d.day, uniquePeople: num(d.people), admissionRows: num(d.rows) })),
    attendedMultipleDays: num(multi.n),
    walkInsWithoutRegistration: walk.n === null ? null : num(walk.n),
    excluded: { checkInRows: num(excl.total), notAdmittedOrUnverified: num(excl.not_verified), verifiedButNotExternal: num(excl.non_external) },
    definition: attendanceDefinition(ctx),
  };
}

// ---- Registration status -------------------------------------------------------------
function latestStatusCte(ctx: DatasetContext) {
  return ctx.caps.statusHistory
    ? `latest as (select distinct on (h.registration_id) h.registration_id, h.status from registration_status_history h
         where h.dataset_version_id = $1 and h.effective_at <= $2 order by h.registration_id, h.effective_at desc, h.source_id desc)`
    : `latest as (select r.id as registration_id, 'registered'::text as status from registrations r where r.dataset_version_id = $1 and r.registered_at <= $2)`;
}

export async function registrationMetrics(q: Q, ctx: DatasetContext) {
  if (!ctx.caps.registrations) return { available: false as const, reason: "The selected dataset has no registrations sheet." };
  const [r] = await q<{ regs: string; people: string }>(
    `select count(*) regs, count(distinct r.person_id) people from registrations r join people p on p.id = r.person_id
     where r.dataset_version_id = $1 and r.registered_at <= $2 and ${externalCond(ctx)}`, [ctx.dv, ctx.asOf]);
  const status = await q<{ status: string; n: string }>(
    `with ${latestStatusCte(ctx)}
     select l.status, count(*) n from latest l join registrations r on r.id = l.registration_id join people p on p.id = r.person_id
     where r.registered_at <= $2 and ${externalCond(ctx)} group by 1 order by 2 desc`, [ctx.dv, ctx.asOf]);
  let showRate: number | null = null;
  let registeredAttendees = 0;
  if (ctx.caps.checkIns) {
    const [s] = await q<{ n: string }>(
      `select count(distinct r.person_id) n from registrations r join people p on p.id = r.person_id
       where r.dataset_version_id = $1 and r.registered_at <= $2 and ${externalCond(ctx)}
         and exists (select 1 from check_ins c where c.person_id = r.person_id and c.dataset_version_id = $1 and c.occurred_at <= $2 and ${verifiedCond(ctx)})`,
      [ctx.dv, ctx.asOf]);
    registeredAttendees = num(s.n);
    showRate = ratio(registeredAttendees, num(r.people));
  }
  return {
    available: true as const,
    registrations: num(r.regs),
    registeredPeople: num(r.people),
    latestStatus: Object.fromEntries(status.map((s) => [s.status, num(s.n)])),
    statusDefinition: ctx.caps.statusHistory ? "Latest status version per registration effective on or before the as-of date." : "No status history in this dataset; every registration counts as 'registered'.",
    registeredPeopleWhoAttended: registeredAttendees,
    showRate,
    showRateDefinition: "Show-up rate = registered external people with a verified admission ÷ registered external people.",
  };
}

// ---- Funnel -----------------------------------------------------------------------------
export async function funnelMetrics(q: Q, ctx: DatasetContext) {
  const stages: { key: string; label: string; value: number | null; available: boolean; note?: string }[] = [];
  const add = (key: string, label: string, value: number | null, available: boolean, note?: string) => stages.push({ key, label, value, available, note });

  if (ctx.caps.people) {
    const [p] = await q<{ n: string }>(`select count(*) n from people p where p.dataset_version_id = $1 and ${externalCond(ctx)} and (p.first_seen_at is null or p.first_seen_at <= $2)`, [ctx.dv, ctx.asOf]);
    add("identified", "Identified external people", num(p.n), true);
  } else add("identified", "Identified people", null, false, "Not present in selected dataset");

  if (ctx.caps.interactions) {
    const [e] = await q<{ n: string }>(`select count(distinct i.person_id) n from interactions i join people p on p.id = i.person_id where i.dataset_version_id = $1 and i.occurred_at <= $2 and ${externalCond(ctx)}`, [ctx.dv, ctx.asOf]);
    add("engaged", "Engaged (any identified interaction)", num(e.n), true);
  } else add("engaged", "Engaged", null, false, "Not present in selected dataset");

  const reg = await registrationMetrics(q, ctx);
  if (reg.available) {
    add("registered", "Registered people", reg.registeredPeople, true);
    if (ctx.caps.statusHistory) add("confirmed", "Confirmed (latest status)", reg.latestStatus["confirmed"] ?? 0, true, "Counts registrations whose latest status is confirmed");
    else add("confirmed", "Confirmed", null, false, "No status history in selected dataset");
  } else {
    add("registered", "Registered", null, false, "Not present in selected dataset");
    add("confirmed", "Confirmed", null, false, "Not present in selected dataset");
  }
  const att = await attendanceMetrics(q, ctx);
  add("attended", "Unique verified attendees", att.available ? att.uniqueVerifiedAttendees : null, att.available, att.available ? undefined : "Not present in selected dataset");

  const withConv = stages.map((s, i) => {
    const prev = [...stages.slice(0, i)].reverse().find((x) => x.available && x.value !== null);
    return { ...s, fromPrevious: s.value !== null && prev?.value ? s.value / prev.value : null, previousLabel: prev?.label ?? null };
  });

  let anonymous: Record<string, number | null> | null = null;
  if (ctx.caps.campaignDaily) {
    const [a] = await q<Record<string, string | null>>(
      `select sum(impressions) impressions, sum(reported_reach) reach, sum(clicks) clicks, sum(sessions) sessions, sum(registration_starts) registration_starts
       from campaign_daily where dataset_version_id = $1 and activity_date <= $2::date`, [ctx.dv, ctx.asOfDate]);
    anonymous = {
      impressions: ctx.caps.impressions ? numOrNull(a.impressions) : null,
      summedDailyReach: ctx.caps.reach ? numOrNull(a.reach) : null,
      clicks: ctx.caps.clicks ? numOrNull(a.clicks) : null,
      sessions: ctx.caps.sessions ? numOrNull(a.sessions) : null,
      registrationStarts: numOrNull(a.registration_starts),
    };
  }
  return {
    stages: withConv,
    walkIns: att.available ? att.walkInsWithoutRegistration : null,
    anonymous,
    notes: [
      "Each conversion uses the previous available stage as its denominator.",
      "Walk-ins can attend without registering, so attended is not a strict subset of registered.",
      "Anonymous daily counts (impressions, summed reach, clicks, sessions) are events, not distinct people. They cannot be joined to identified people, so reach→registration per person is not computable.",
    ],
  };
}

// ---- Campaigns ------------------------------------------------------------------------------
export interface CampaignRow {
  id: string;
  sourceId: string;
  name: string;
  channel: string | null;
  status: string;
  initiativeId: string | null;
  initiativeName: string | null;
  ownerName: string | null;
  ownerTeamMemberId: string | null;
  budgetApproved: number | null;
  budgetCommitted: number | null;
  kpiRegistrations: number | null;
  kpiAttendees: number | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  sessions: number | null;
  firstTouchPeople: number;
  registeredPeople: number;
  confirmedPeople: number;
  verifiedAttendees: number;
  optedOut: number;
  showRate: number | null;
  costPerRegistration: number | null;
  costPerVerifiedAttendee: number | null;
  health: "healthy" | "attention" | "critical" | "insufficient";
  healthReasons: string[];
}

export async function campaignPerformance(q: Q, ctx: DatasetContext, opts: { campaignIds?: string[] } = {}): Promise<{ rows: CampaignRow[]; overallShowRate: number | null; medianCostPerVerified: number | null; definitions: string[] }> {
  const rows = await q<Record<string, unknown>>(
    `with ext as (select p.id, p.first_campaign_id from people p where p.dataset_version_id = $1 and ${externalCond(ctx)} and (p.first_seen_at is null or p.first_seen_at <= $2)),
     att as (select distinct c.person_id from check_ins c join people p on p.id = c.person_id where c.dataset_version_id = $1 and c.occurred_at <= $2 and ${verifiedCond(ctx)} and ${externalCond(ctx)}),
     regs as (select r.id, r.person_id, r.campaign_id from registrations r join ext on ext.id = r.person_id where r.dataset_version_id = $1 and r.registered_at <= $2),
     ${latestStatusCte(ctx).replace("latest as", "latest as")},
     daily as (select campaign_id, sum(spend_inr) spend, sum(impressions) impressions, sum(clicks) clicks, sum(sessions) sessions
               from campaign_daily where dataset_version_id = $1 and activity_date <= $3::date group by 1),
     opt as (select campaign_id, count(distinct person_id) n from interactions where dataset_version_id = $1 and event_type = 'opted_out' and occurred_at <= $2 group by 1)
     select c.id, c.source_id, c.name, c.channel, c.status, c.initiative_id, i.name initiative_name, tm.name owner_name, c.owner_team_member_id,
            c.budget_approved_inr, c.budget_committed_inr, c.kpi_registrations, c.kpi_attendees,
            d.spend, d.impressions, d.clicks, d.sessions,
            (select count(*) from ext where ext.first_campaign_id = c.id) first_touch,
            (select count(distinct regs.person_id) from regs where regs.campaign_id = c.id) registered,
            (select count(distinct regs.person_id) from regs join latest l on l.registration_id = regs.id where regs.campaign_id = c.id and l.status = 'confirmed') confirmed,
            (select count(distinct regs.person_id) from regs join att on att.person_id = regs.person_id where regs.campaign_id = c.id) verified,
            coalesce(o.n, 0) opted_out
     from campaigns c
     left join initiatives i on i.id = c.initiative_id
     left join team_members tm on tm.id = c.owner_team_member_id
     left join daily d on d.campaign_id = c.id
     left join opt o on o.campaign_id = c.id
     where c.dataset_version_id = $1
     order by c.source_id`,
    [ctx.dv, ctx.asOf, ctx.asOfDate]);

  const base: CampaignRow[] = rows.map((r) => {
    const spend = ctx.caps.spend ? numOrNull(r.spend) : null;
    const registered = num(r.registered);
    const verified = num(r.verified);
    return {
      id: String(r.id), sourceId: String(r.source_id), name: String(r.name), channel: (r.channel as string) ?? null, status: String(r.status),
      initiativeId: (r.initiative_id as string) ?? null, initiativeName: (r.initiative_name as string) ?? null, ownerName: (r.owner_name as string) ?? null,
      ownerTeamMemberId: (r.owner_team_member_id as string) ?? null,
      budgetApproved: numOrNull(r.budget_approved_inr), budgetCommitted: numOrNull(r.budget_committed_inr),
      kpiRegistrations: numOrNull(r.kpi_registrations), kpiAttendees: numOrNull(r.kpi_attendees),
      spend, impressions: ctx.caps.impressions ? numOrNull(r.impressions) : null, clicks: ctx.caps.clicks ? numOrNull(r.clicks) : null, sessions: ctx.caps.sessions ? numOrNull(r.sessions) : null,
      firstTouchPeople: num(r.first_touch), registeredPeople: registered, confirmedPeople: num(r.confirmed), verifiedAttendees: verified, optedOut: num(r.opted_out),
      showRate: ctx.caps.checkIns ? ratio(verified, registered) : null,
      costPerRegistration: spend !== null ? ratio(spend, registered) : null,
      costPerVerifiedAttendee: spend !== null && ctx.caps.checkIns ? ratio(spend, verified) : null,
      health: "insufficient", healthReasons: [],
    };
  });

  // Health compares each campaign with the portfolio, so it is relative, not absolute.
  const totReg = base.reduce((s, r) => s + r.registeredPeople, 0);
  const totVer = base.reduce((s, r) => s + r.verifiedAttendees, 0);
  const overallShowRate = ctx.caps.checkIns ? ratio(totVer, totReg) : null;
  const costs = base.map((r) => r.costPerVerifiedAttendee).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const median = costs.length ? costs[Math.floor((costs.length - 1) / 2)] : null;
  for (const r of base) {
    if (r.registeredPeople < 20 || overallShowRate === null) {
      r.health = "insufficient";
      r.healthReasons.push(r.registeredPeople < 20 ? "Fewer than 20 registered people" : "No attendance data");
      continue;
    }
    let level = 0;
    if (r.showRate !== null) {
      const gap = overallShowRate - r.showRate;
      if (gap > 0.15) { level = 2; r.healthReasons.push(`Show-up ${(r.showRate * 100).toFixed(0)}% vs portfolio ${(overallShowRate * 100).toFixed(0)}%`); }
      else if (gap > 0.05) { level = Math.max(level, 1); r.healthReasons.push(`Show-up ${(r.showRate * 100).toFixed(0)}% is below portfolio ${(overallShowRate * 100).toFixed(0)}%`); }
    }
    if (median && r.costPerVerifiedAttendee !== null) {
      if (r.costPerVerifiedAttendee > 2 * median) { level = 2; r.healthReasons.push(`Cost per verified attendee ₹${Math.round(r.costPerVerifiedAttendee)} is over 2× the median (₹${Math.round(median)})`); }
      else if (r.costPerVerifiedAttendee > 1.3 * median) { level = Math.max(level, 1); r.healthReasons.push(`Cost per verified attendee ₹${Math.round(r.costPerVerifiedAttendee)} is above the median (₹${Math.round(median)})`); }
    }
    if (r.budgetApproved !== null && r.spend !== null && r.spend > r.budgetApproved) { level = Math.max(level, 1); r.healthReasons.push("Spend exceeds the campaign's approved budget"); }
    r.health = level === 2 ? "critical" : level === 1 ? "attention" : "healthy";
  }
  // Portfolio comparisons always use every campaign; filtering happens only after.
  const rowsOut = opts.campaignIds?.length ? base.filter((r) => opts.campaignIds!.includes(r.id)) : base;
  return {
    rows: rowsOut, overallShowRate, medianCostPerVerified: median,
    definitions: [
      "Registered people and verified attendees are attributed by the campaign recorded on the registration (registration source). Walk-ins without a registration are unattributed.",
      "Show-up rate = verified attendees ÷ registered people for that campaign.",
      "Cost per registration = net spend ÷ registered people. Cost per verified attendee = net spend ÷ verified attendees. Attribution is descriptive, not causal.",
      "First-touch people = identified external people whose first recorded campaign is this one.",
      "Health is relative to the portfolio: critical if show-up is >15 pts below the portfolio or cost per verified attendee is >2× the median; attention at >5 pts or >1.3×.",
    ],
  };
}

// ---- Attribution ----------------------------------------------------------------------------
export async function attributionViews(q: Q, ctx: DatasetContext) {
  if (!ctx.caps.checkIns) return { available: false as const, reason: "No check-ins: attribution of attendees is not possible." };
  const rows = await q<{ campaign: string | null; first_touch: string; registration_source: string; last_interaction: string }>(
    `with att as (select c.person_id, min(c.occurred_at) first_admit from check_ins c join people p on p.id = c.person_id
                  where c.dataset_version_id = $1 and c.occurred_at <= $2 and ${verifiedCond(ctx)} and ${externalCond(ctx)} group by 1),
     ft as (select p.first_campaign_id cid, count(*) n from att join people p on p.id = att.person_id group by 1),
     rs as (select x.cid, count(*) n from (select att.person_id, (select r.campaign_id from registrations r where r.person_id = att.person_id
              and r.dataset_version_id = $1 order by r.registered_at limit 1) cid from att) x group by 1),
     li as (select x.cid, count(*) n from (select att.person_id, (select i.campaign_id from interactions i where i.person_id = att.person_id and i.dataset_version_id = $1
              and i.occurred_at <= att.first_admit and i.event_type <> 'opted_out' order by i.occurred_at desc limit 1) cid from att) x group by 1),
     keys as (select cid from ft union select cid from rs union select cid from li)
     select coalesce(c.name, 'Unattributed') campaign, coalesce(ft.n,0) first_touch, coalesce(rs.n,0) registration_source, coalesce(li.n,0) last_interaction
     from keys left join campaigns c on c.id = keys.cid left join ft on ft.cid is not distinct from keys.cid
     left join rs on rs.cid is not distinct from keys.cid left join li on li.cid is not distinct from keys.cid order by 3 desc`, [ctx.dv, ctx.asOf]);
  return {
    available: true as const,
    rows: rows.map((r) => ({ campaign: r.campaign ?? "Unattributed", firstTouch: num(r.first_touch), registrationSource: num(r.registration_source), lastInteraction: num(r.last_interaction) })),
    definitions: [
      "First touch: the person's first recorded campaign.",
      "Registration source: the campaign recorded on the person's earliest registration.",
      "Last interaction: the campaign of the latest identified interaction before the first verified admission (opt-outs excluded).",
      "All three describe recorded touchpoints. None proves that a campaign caused attendance.",
    ],
  };
}

// ---- Trends -----------------------------------------------------------------------------------
export async function weeklyTrend(q: Q, ctx: DatasetContext) {
  const rows = await q<{ week: string; registrations: string; identified: string; spend: string | null; cancellations: string; opt_outs: string }>(
    `with weeks as (
       select distinct to_char(date_trunc('week', ts + make_interval(mins => $3)), 'YYYY-MM-DD') w from (
         select registered_at ts from registrations where dataset_version_id = $1 and registered_at <= $2
         union all select first_seen_at from people where dataset_version_id = $1 and first_seen_at <= $2
         union all select activity_date::timestamp - make_interval(mins => $3) from campaign_daily where dataset_version_id = $1 and activity_date <= $4::date) t)
     select w week,
       (select count(*) from registrations r join people p on p.id = r.person_id where r.dataset_version_id = $1 and r.registered_at <= $2 and ${externalCond(ctx)}
          and to_char(date_trunc('week', r.registered_at + make_interval(mins => $3)), 'YYYY-MM-DD') = w) registrations,
       (select count(*) from people p where p.dataset_version_id = $1 and p.first_seen_at <= $2 and ${externalCond(ctx)}
          and to_char(date_trunc('week', p.first_seen_at + make_interval(mins => $3)), 'YYYY-MM-DD') = w) identified,
       (select sum(spend_inr) from campaign_daily d where d.dataset_version_id = $1 and d.activity_date <= $4::date
          and to_char(date_trunc('week', d.activity_date::timestamp), 'YYYY-MM-DD') = w) spend,
       (select count(*) from registration_status_history h where h.dataset_version_id = $1 and h.status = 'cancelled' and h.effective_at <= $2
          and to_char(date_trunc('week', h.effective_at + make_interval(mins => $3)), 'YYYY-MM-DD') = w) cancellations,
       (select count(*) from interactions i where i.dataset_version_id = $1 and i.event_type = 'opted_out' and i.occurred_at <= $2
          and to_char(date_trunc('week', i.occurred_at + make_interval(mins => $3)), 'YYYY-MM-DD') = w) opt_outs
     from weeks order by 1`, [ctx.dv, ctx.asOf, ctx.tzOffset, ctx.asOfDate]);
  return rows.map((r) => ({ weekStarting: r.week, registrations: num(r.registrations), identified: num(r.identified), spend: ctx.caps.spend ? numOrNull(r.spend) : null, cancellations: num(r.cancellations), optOuts: num(r.opt_outs) }));
}

export async function compareRanges(q: Q, ctx: DatasetContext, a: { from: string; to: string }, b: { from: string; to: string }) {
  const one = async (r: { from: string; to: string }) => {
    const p = [ctx.dv, r.from, r.to, ctx.tzOffset];
    const local = (col: string) => `(${col} + make_interval(mins => $4))::date between $2::date and $3::date`;
    const [x] = await q<Record<string, string | null>>(
      `select
        (select count(*) from registrations r join people p on p.id = r.person_id where r.dataset_version_id = $1 and ${externalCond(ctx)} and ${local("r.registered_at")}) registrations,
        (select count(*) from people p where p.dataset_version_id = $1 and ${externalCond(ctx)} and ${local("p.first_seen_at")}) identified,
        (select sum(spend_inr) from campaign_daily where dataset_version_id = $1 and activity_date between $2::date and $3::date) spend,
        (select count(*) from interactions i where i.dataset_version_id = $1 and ${local("i.occurred_at")}) interactions,
        (select count(*) from registration_status_history h where h.dataset_version_id = $1 and h.status = 'cancelled' and ${local("h.effective_at")}) cancellations,
        (select count(distinct c.person_id) from check_ins c join people p on p.id = c.person_id where c.dataset_version_id = $1 and ${verifiedCond(ctx)} and ${externalCond(ctx)} and ${local("c.occurred_at")}) verified_attendees`, p);
    return { range: r, registrations: num(x.registrations), identified: num(x.identified), spend: ctx.caps.spend ? numOrNull(x.spend) : null, interactions: num(x.interactions), cancellations: num(x.cancellations), verifiedAttendees: num(x.verified_attendees) };
  };
  const [ra, rb] = [await one(a), await one(b)];
  const delta = Object.fromEntries((["registrations", "identified", "spend", "interactions", "cancellations", "verifiedAttendees"] as const).map((k) => {
    const va = ra[k] as number | null, vb = rb[k] as number | null;
    return [k, va === null || vb === null ? null : { change: vb - va, pctChange: va ? (vb - va) / va : null }];
  }));
  return { a: ra, b: rb, delta, note: "Ranges use local dates in the dataset timezone, inclusive. Changes are descriptive; they do not identify causes." };
}

// ---- Targets ------------------------------------------------------------------------------------
export async function targetsVsActual(q: Q, ctx: DatasetContext) {
  if (!ctx.caps.targets) return { available: false as const, reason: "The selected dataset has no targets sheet." };
  const [t] = await q<{ label: string | null; effective_at: Date; identified_goal: number | null; registration_goal: number | null; visitor_goal: number | null; budget_inr: string | null }>(
    "select label, effective_at, identified_goal, registration_goal, visitor_goal, budget_inr from target_versions where dataset_version_id = $1 and effective_at <= $2 order by effective_at desc limit 1", [ctx.dv, ctx.asOf]);
  if (!t) return { available: false as const, reason: `No target version was in effect on ${ctx.asOfDate}.` };
  const f = await funnelMetrics(q, ctx);
  const val = (k: string) => f.stages.find((s) => s.key === k)?.value ?? null;
  const [sp] = await q<{ s: string | null }>("select sum(spend_inr) s from campaign_daily where dataset_version_id = $1 and activity_date <= $2::date", [ctx.dv, ctx.asOfDate]);
  const rows = [
    { metric: "Identified external people", target: t.identified_goal, actual: val("identified") },
    { metric: "Registered external people", target: t.registration_goal, actual: val("registered") },
    { metric: "Unique verified external visitors", target: t.visitor_goal, actual: val("attended") },
    { metric: "Marketing spend vs approved budget", target: numOrNull(t.budget_inr), actual: ctx.caps.spend ? numOrNull(sp.s) : null },
  ].map((r) => ({ ...r, attainment: r.target && r.actual !== null ? r.actual / r.target : null }));
  return { available: true as const, version: t.label, effectiveAt: new Date(t.effective_at).toISOString(), rows };
}
