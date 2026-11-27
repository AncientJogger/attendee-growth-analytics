import type { Q } from "../db";
import { getStrategy, todayIn, type DatasetContext } from "./context";
import { attendanceMetrics, campaignPerformance, ratio, registrationMetrics } from "./metrics";
import { thresholdVerdict } from "../strategy";

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

// ---- Tasks ---------------------------------------------------------------------------------------
export interface TaskRow {
  id: string; title: string; description: string | null; status: string; priority: string; progress: number;
  startDate: string | null; dueDate: string | null; effortHours: number | null; origin: string;
  initiativeId: string | null; initiativeName: string | null; campaignId: string | null; campaignName: string | null;
  ownerId: string | null; ownerName: string | null; reviewerId: string | null; reviewerName: string | null;
  overdue: boolean; dueSoon: boolean; blockedBy: { id: string; title: string; status: string }[]; updatedAt: string;
}

export async function listTasks(q: Q, ws: string, f: { initiativeId?: string; campaignId?: string; ownerId?: string; status?: string; onlyOpen?: boolean } = {}): Promise<TaskRow[]> {
  const today = todayIn(330);
  const params: unknown[] = [ws];
  const where = ["t.workspace_id = $1"];
  if (f.initiativeId) { params.push(f.initiativeId); where.push(`t.initiative_id = $${params.length}`); }
  if (f.campaignId) { params.push(f.campaignId); where.push(`t.campaign_id = $${params.length}`); }
  if (f.ownerId) { params.push(f.ownerId); where.push(`t.owner_user_id = $${params.length}`); }
  if (f.status) { params.push(f.status); where.push(`t.status = $${params.length}`); }
  if (f.onlyOpen) where.push("t.status not in ('done','cancelled')");
  const rows = await q<Record<string, unknown>>(
    `select t.*, to_char(t.start_date,'YYYY-MM-DD') sd, to_char(t.due_date,'YYYY-MM-DD') dd, i.name initiative_name, c.name campaign_name, o.display_name owner_name, r.display_name reviewer_name,
       coalesce((select json_agg(json_build_object('id', d.id, 'title', d.title, 'status', d.status)) from task_dependencies td join tasks d on d.id = td.depends_on_id
                 where td.task_id = t.id and d.status not in ('done','cancelled')), '[]') blocked_by
     from tasks t left join initiatives i on i.id = t.initiative_id left join campaigns c on c.id = t.campaign_id
     left join app_users o on o.id = t.owner_user_id left join app_users r on r.id = t.reviewer_user_id
     where ${where.join(" and ")} order by t.due_date nulls last, t.priority desc`, params);
  const soon = new Date(Date.parse(today) + 7 * 86400000).toISOString().slice(0, 10);
  return rows.map((t) => {
    const open = !["done", "cancelled"].includes(String(t.status));
    const due = (t.dd as string) ?? null;
    return {
      id: String(t.id), title: String(t.title), description: (t.description as string) ?? null, status: String(t.status), priority: String(t.priority), progress: num(t.progress),
      startDate: (t.sd as string) ?? null, dueDate: due, effortHours: t.effort_hours === null ? null : Number(t.effort_hours), origin: String(t.origin),
      initiativeId: (t.initiative_id as string) ?? null, initiativeName: (t.initiative_name as string) ?? null, campaignId: (t.campaign_id as string) ?? null, campaignName: (t.campaign_name as string) ?? null,
      ownerId: (t.owner_user_id as string) ?? null, ownerName: (t.owner_name as string) ?? null, reviewerId: (t.reviewer_user_id as string) ?? null, reviewerName: (t.reviewer_name as string) ?? null,
      overdue: open && !!due && due < today, dueSoon: open && !!due && due >= today && due <= soon,
      blockedBy: t.blocked_by as TaskRow["blockedBy"], updatedAt: new Date(t.updated_at as string).toISOString(),
    };
  });
}

export async function taskMetrics(q: Q, ws: string, f: { initiativeId?: string; ownerId?: string } = {}) {
  const tasks = await listTasks(q, ws, f);
  const open = tasks.filter((t) => !["done", "cancelled"].includes(t.status));
  const byStatus: Record<string, number> = {};
  tasks.forEach((t) => (byStatus[t.status] = (byStatus[t.status] ?? 0) + 1));
  const workload = new Map<string, { ownerId: string | null; owner: string; open: number; overdue: number; blocked: number; openEffortHours: number }>();
  for (const t of open) {
    const k = t.ownerId ?? "unassigned";
    const w = workload.get(k) ?? { ownerId: t.ownerId, owner: t.ownerName ?? "Unassigned", open: 0, overdue: 0, blocked: 0, openEffortHours: 0 };
    w.open++; if (t.overdue) w.overdue++; if (t.status === "blocked" || t.blockedBy.length) w.blocked++;
    w.openEffortHours += (t.effortHours ?? 0) * (1 - t.progress / 100);
    workload.set(k, w);
  }
  const done = tasks.filter((t) => t.status === "done").length;
  return {
    total: tasks.length, open: open.length, byStatus,
    overdue: open.filter((t) => t.overdue), dueSoon: open.filter((t) => t.dueSoon), blocked: open.filter((t) => t.status === "blocked" || t.blockedBy.length > 0),
    completionRate: ratio(done, tasks.filter((t) => t.status !== "cancelled").length),
    workload: [...workload.values()].map((w) => ({ ...w, openEffortHours: Math.round(w.openEffortHours * 10) / 10 })).sort((a, b) => b.openEffortHours - a.openEffortHours),
    definitions: ["Overdue = open task whose due date is before today (IST).", "Due soon = due within 7 days.", "Blocked = status blocked, or an unfinished dependency.", "Open effort = estimated hours × (1 − progress)."],
  };
}

// ---- Budget -----------------------------------------------------------------------------------------
export async function budgetSummary(q: Q, ws: string, ctx: DatasetContext | null) {
  const { config } = await getStrategy(q, ws);
  const lines = await q<Record<string, unknown>>(
    `select b.*, i.name initiative_name from budget_lines b left join initiatives i on i.id = b.initiative_id where b.workspace_id = $1 order by b.scenario, b.category, b.label`, [ws]);
  const plan = (["base", "stretch"] as const).map((scenario) => {
    const ls = lines.filter((l) => l.scenario === scenario).map((l) => ({
      id: String(l.id), label: String(l.label), category: String(l.category), initiative: (l.initiative_name as string) ?? null, fundingSource: String(l.funding_source),
      approved: num(l.approved_inr), committed: num(l.committed_inr), spent: num(l.spent_inr), remaining: num(l.approved_inr) - num(l.committed_inr) - num(l.spent_inr), notes: (l.notes as string) ?? null,
    }));
    const festival = ls.filter((l) => l.fundingSource === "festival");
    const sum = (k: "approved" | "committed" | "spent" | "remaining", arr = festival) => arr.reduce((s, l) => s + l[k], 0);
    const ceiling = config.budget[scenario].ceiling;
    return {
      scenario, lines: ls, ceiling,
      festivalFunded: { approved: sum("approved"), committed: sum("committed"), spent: sum("spent"), remaining: sum("remaining") },
      sponsorFunded: { approved: sum("approved", ls.filter((l) => l.fundingSource === "sponsor")) },
      headroomToCeiling: ceiling - sum("approved"),
    };
  });
  let historical: null | { approvedBudget: number | null; netSpend: number | null; remaining: number | null; byCampaign: { campaign: string; spend: number | null; approved: number | null; variance: number | null }[]; note: string } = null;
  if (ctx) {
    const [t] = ctx.caps.targets ? await q<{ budget_inr: string | null }>("select budget_inr from target_versions where dataset_version_id = $1 and effective_at <= $2 order by effective_at desc limit 1", [ctx.dv, ctx.asOf]) : [];
    const [s] = ctx.caps.spend ? await q<{ s: string | null }>("select sum(spend_inr) s from campaign_daily where dataset_version_id = $1 and activity_date <= $2::date", [ctx.dv, ctx.asOfDate]) : [{ s: null }];
    const camps = await q<{ name: string; spend: string | null; approved: string | null }>(
      "select c.name, (select sum(spend_inr) from campaign_daily d where d.campaign_id = c.id and d.activity_date <= $2::date) spend, c.budget_approved_inr approved from campaigns c where c.dataset_version_id = $1 order by 2 desc nulls last", [ctx.dv, ctx.asOfDate]);
    const approved = t?.budget_inr ? Number(t.budget_inr) : null;
    const spend = s?.s !== null && s?.s !== undefined ? Number(s.s) : null;
    historical = {
      approvedBudget: approved, netSpend: ctx.caps.spend ? spend : null, remaining: approved !== null && spend !== null ? approved - spend : null,
      byCampaign: camps.map((c) => ({ campaign: c.name, spend: ctx.caps.spend ? (c.spend === null ? 0 : Number(c.spend)) : null, approved: c.approved === null ? null : Number(c.approved), variance: c.approved !== null && c.spend !== null ? Number(c.approved) - Number(c.spend) : null })),
      note: "Historical = the active dataset's approved marketing budget and net posted spend (debits less vendor credits). Campaign-level approved budgets exist only where someone has entered them.",
    };
  }
  return { plan, historical, definitions: ["Approved = allocated limit. Committed = contracted but not yet paid. Spent = paid. Remaining = approved − committed − spent.", "Sponsor-funded lines are reported separately and excluded from festival totals to avoid double counting."] };
}

// ---- Initiatives ----------------------------------------------------------------------------------------
export async function initiativeOverview(q: Q, ws: string, ctx: DatasetContext | null, initiativeId?: string) {
  const { config } = await getStrategy(q, ws);
  const inits = await q<Record<string, unknown>>(
    `select i.*, u.display_name owner_name from initiatives i left join app_users u on u.id = i.owner_user_id where i.workspace_id = $1 ${initiativeId ? "and i.id = $2" : ""} order by i.base_target desc`,
    initiativeId ? [ws, initiativeId] : [ws]);
  const camps = ctx ? (await campaignPerformance(q, ctx)).rows : [];
  const tasks = await q<{ initiative_id: string; open: string; overdue: string; blocked: string }>(
    `select initiative_id, count(*) filter (where status not in ('done','cancelled')) open,
       count(*) filter (where status not in ('done','cancelled') and due_date < (now() + interval '330 minutes')::date) overdue,
       count(*) filter (where status = 'blocked') blocked from tasks where workspace_id = $1 and initiative_id is not null group by 1`, [ws]);
  const exps = await q<Record<string, unknown>>("select * from experiments where workspace_id = $1", [ws]);
  return inits.map((i) => {
    const rule = config.thresholds[String(i.key)] ?? null;
    const linked = camps.filter((c) => c.initiativeId === i.id);
    const t = tasks.find((x) => x.initiative_id === i.id);
    const iexps = exps.filter((e) => e.initiative_id === i.id);
    const completed = iexps.find((e) => e.status === "completed" && e.treatment_n && e.control_n);
    // A threshold verdict needs pilot/experiment data; historical proxy campaigns do not qualify.
    let observedMetric: number | null = null;
    if (completed && rule) {
      const tr = num(completed.treatment_conversions) / num(completed.treatment_n);
      observedMetric = rule.unit === "%" ? tr * 100 : null;
    }
    return {
      id: String(i.id), key: String(i.key), name: String(i.name), mechanism: (i.mechanism as string) ?? null, decision: String(i.decision), status: String(i.status),
      ownerName: (i.owner_name as string) ?? null, ownerUserId: (i.owner_user_id as string) ?? null,
      plan: { baseTarget: num(i.base_target), stretchTarget: num(i.stretch_target), baseBudget: num(i.base_budget_inr), stretchBudget: num(i.stretch_budget_inr), label: "Planning allocation, not an achieved result" },
      historicalProxy: linked.map((c) => ({ campaign: c.name, registered: c.registeredPeople, verified: c.verifiedAttendees, showRate: c.showRate, costPerVerified: c.costPerVerifiedAttendee, health: c.health })),
      tasks: { open: num(t?.open), overdue: num(t?.overdue), blocked: num(t?.blocked) },
      experiments: iexps.map((e) => ({ id: String(e.id), name: String(e.name), status: String(e.status), decisionRule: (e.decision_rule as string) ?? null })),
      threshold: rule, thresholdVerdict: rule ? thresholdVerdict(rule, observedMetric) : "insufficient",
      thresholdNote: observedMetric === null ? "No pilot or experiment results recorded yet, so the scale/change/stop rule cannot be applied." : undefined,
    };
  });
}

// ---- Forecast & capacity ------------------------------------------------------------------------------------
export async function forecastAttendance(q: Q, ws: string, ctx: DatasetContext | null, scenario: "base" | "stretch" = "base") {
  const { config } = await getStrategy(q, ws);
  const planTarget = scenario === "base" ? config.baseTarget : config.stretchTarget;
  if (!ctx) return { status: "insufficient" as const, reason: "No active dataset.", planTarget };
  const eventStart = ctx.event?.startsAt ?? null;
  const eventEnd = ctx.event?.endsAt ?? null;
  const att = await attendanceMetrics(q, ctx);
  const datasetEventName = ctx.event?.name ?? "the dataset's event";
  const planningNote = `The ${scenario} plan target of ${planTarget.toLocaleString("en-IN")} applies to the upcoming fest. The active dataset describes ${datasetEventName}, so it cannot show progress toward that target; only registrations and check-ins for the upcoming fest can.`;
  if (eventEnd && ctx.asOf >= eventEnd) {
    return { status: "observed" as const, observedAttendees: att.available ? att.uniqueVerifiedAttendees : null, asOfDate: ctx.asOfDate, planTarget, planningNote,
      note: `As of ${ctx.asOfDate}, ${datasetEventName} has ended, so attendance is observed, not forecast.` };
  }
  if (!eventStart) return { status: "insufficient" as const, reason: "The dataset has no event start date, so the time remaining cannot be calculated.", planTarget, planningNote };
  if (!ctx.caps.registrations) return { status: "insufficient" as const, reason: "No registrations in the dataset, so there is no series to project.", planTarget, planningNote };
  const daily = await q<{ d: string; n: string }>(
    `select to_char(r.registered_at + make_interval(mins => $3), 'YYYY-MM-DD') d, count(distinct r.person_id) n from registrations r join people p on p.id = r.person_id
     where r.dataset_version_id = $1 and r.registered_at <= $2 and ${ctx.caps.personType ? "p.person_type = 'external'" : "true"} group by 1 order by 1`, [ctx.dv, ctx.asOf, ctx.tzOffset]);
  if (daily.length < 14) return { status: "insufficient" as const, reason: `Only ${daily.length} days with registrations up to ${ctx.asOfDate}; at least 14 are needed for a run-rate projection.`, planTarget, planningNote };
  const reg = await registrationMetrics(q, ctx);
  const registeredSoFar = reg.available ? reg.registeredPeople : 0;
  const cutoff = new Date(Date.parse(ctx.asOfDate) - 13 * 86400000).toISOString().slice(0, 10);
  const last14 = daily.filter((x) => x.d >= cutoff).reduce((s, x) => s + num(x.n), 0);
  const perDay = last14 / 14;
  const daysLeft = Math.max(0, Math.ceil((Date.parse(eventStart) - Date.parse(ctx.asOf)) / 86400000));
  const projectedRegistered = Math.round(registeredSoFar + perDay * daysLeft);
  const showRate = config.planningShowRate;
  return {
    status: "estimated" as const, asOfDate: ctx.asOfDate, registeredSoFar, last14DayRunRate: Math.round(perDay * 10) / 10, daysToEvent: daysLeft, projectedRegistered,
    assumedShowRate: showRate, projectedAttendees: Math.round(projectedRegistered * showRate), planTarget, planningNote,
    method: "Projected registered = registered so far + (registrations in the last 14 days ÷ 14) × days to event. Projected attendees = projected registered × planning show-up rate (a strategy assumption, not observed). Walk-ins are not included.",
  };
}

export async function capacityStatus(q: Q, ws: string, plannedTarget?: number) {
  const { config, version } = await getStrategy(q, ws);
  const c = config.capacity;
  if (!c.dailyLimit && !c.totalLimit) {
    return { configured: false as const, message: "Capacity not configured. No confirmed venue limit has been entered, so no target can be called capacity-safe.", strategyVersion: version };
  }
  const target = plannedTarget ?? config.stretchTarget;
  // Without repeat-visit data for the new fest, assume every attendee may come on any day: the busiest day could see all of them.
  const totalCapacity = c.totalLimit ?? (c.dailyLimit ? c.dailyLimit * config.eventDays : null);
  return {
    configured: true as const, dailyLimit: c.dailyLimit, totalLimit: c.totalLimit, confirmedBy: c.confirmedBy, confirmedAt: c.confirmedAt, strategyVersion: version,
    target, fitsTotal: totalCapacity !== null ? target <= totalCapacity : null,
    note: "A daily limit bounds visits per day. Whether a unique-attendee target fits depends on how many people come on both days.",
  };
}

export function dataQualityReport(ctx: DatasetContext) {
  return {
    datasetVersion: ctx.label, isDemo: ctx.isDemo, uploadedAt: ctx.uploadedAt, rowCounts: ctx.rowCounts, rejectedRows: ctx.rejected, warnings: ctx.warnings, capabilities: ctx.caps,
    missing: Object.entries(ctx.caps).filter(([, v]) => !v).map(([k]) => k),
  };
}
