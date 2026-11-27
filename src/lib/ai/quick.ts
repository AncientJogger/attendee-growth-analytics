// Instant answers: common questions answered straight from the data tools, with no AI model call.
//
// The engine recognises a question type from its wording, runs the same read-only tools the AI would
// (cached per data version, so usually a few milliseconds), and writes the answer from a template.
// Every figure comes from a tool result in this turn; nothing is remembered or made up. Questions it
// does not recognise go to the AI, and when the AI is slow or down the closest instant answer is used.
import { runTool, type ToolContext } from "./tools";
import { DECISION_LABEL, fmtInr, fmtInt, fmtPct, STATUS_LABEL } from "../format";

export interface QuickResult {
  intent: string;
  text: string;
  trace: { tool: string; input: unknown; ok: boolean; ms: number; result: unknown }[];
}

/* eslint-disable @typescript-eslint/no-explicit-any -- tool results are plain JSON documented in tools.ts */
type Any = any;

type Run = (tool: string, input?: Record<string, unknown>) => Promise<Any>;

interface Intent {
  key: string;
  /** Score for this question, 0 = not this intent. The best score above the threshold wins. */
  score: (q: string) => number;
  answer: (run: Run, q: string) => Promise<string>;
}

const has = (q: string, ...words: (string | RegExp)[]) => words.some((w) => (typeof w === "string" ? q.includes(w) : w.test(q)));
const count = (q: string, ...words: (string | RegExp)[]) => words.filter((w) => (typeof w === "string" ? q.includes(w) : w.test(q))).length;
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
const label = (s: string | null | undefined) => (s ? STATUS_LABEL[s] ?? s.replace(/_/g, " ") : "–");
const pctNum = (s: string | null | undefined) => (s ? parseFloat(s) : NaN);

/** Asks to create, change or draft something need the AI, which can draft proposals for approval. */
const WRITE_ASK = /\b(draft|create|add|assign|reassign|make a task|new task|update|change|set|move|approve|submit|propose|schedule|write (me )?(an? )?(email|message|post|plan))\b/;

// ---------- entity matching ----------

const INITIATIVE_ALIASES: [RegExp, string][] = [
  [/campus cup|\bcup\b/, "Campus Cup"],
  [/crew ?pass|\bcrew\b/, "CrewPass"],
  [/challenge circuit|national challenge|\bcircuit\b/, "National Challenge Circuit"],
  [/campus network|\bcaptains?\b|campus-to-campus/, "Campus Network"],
  [/student passport|\bpassport\b/, "Student Passport"],
];
const mentionedInitiatives = (q: string) => INITIATIVE_ALIASES.filter(([re]) => re.test(q)).map(([, n]) => n);

const GENERIC = new Set(["campus", "partners", "partner", "groups", "group", "student", "students", "search", "social", "college"]);
function mentionedCampaigns(q: string, names: string[]) {
  const hits = new Set<string>();
  for (const n of names) if (q.includes(n.toLowerCase())) hits.add(n);
  // A distinctive single word also counts: "referrals" → Student Referrals, "creators" → Creator Partners.
  for (const n of names) {
    for (const w of n.toLowerCase().split(/\s+/)) {
      if (w.length < 5 || GENERIC.has(w)) continue;
      const stem = w.replace(/s$/, "");
      const unique = names.filter((m) => m.toLowerCase().includes(stem)).length === 1;
      if (unique && new RegExp(`\\b${stem}`).test(q)) hits.add(n);
    }
  }
  if (/paid social|\bads?\b|instagram|facebook|meta ads/.test(q)) for (const n of names) if (/paid social/i.test(n)) hits.add(n);
  if (/\borganic\b|\bseo\b/.test(q)) for (const n of names) if (/organic/i.test(n)) hits.add(n);
  if (/\bcommunit/.test(q)) for (const n of names) if (/communit/i.test(n)) hits.add(n);
  return [...hits];
}

// ---------- answer builders ----------

function taskLine(t: Any) {
  const bits = [`**${t.title}**`, `${t.owner ?? "unassigned"}`, `due ${t.due ?? "–"}`, label(t.status)];
  if (t.priority) bits.push(`${t.priority} priority`);
  const where = t.initiative ?? t.campaign;
  let s = `- ${bits.join(" · ")}${where ? ` (${where})` : ""}`;
  if (t.blockedBy?.length) s += `\n  - Waiting on: ${t.blockedBy.join("; ")}`;
  return s;
}

async function tasksAnswer(run: Run, q: string) {
  const m = await run("get_task_metrics");
  const overdue: Any[] = m.overdue ?? [];
  const blocked: Any[] = m.blocked ?? [];
  const dueSoon: Any[] = m.dueSoon ?? [];
  const inits = mentionedInitiatives(q);
  const allNames = [...new Set([...overdue, ...blocked, ...dueSoon].map((t) => t.campaign).filter(Boolean))] as string[];
  const camps = mentionedCampaigns(q, allNames);
  const scopes = [...inits, ...camps];
  const inScope = (t: Any) => !scopes.length || scopes.includes(t.initiative) || scopes.includes(t.campaign);
  const wantsBlocked = has(q, "block", "stuck", "waiting", "depend");

  const out: string[] = [];
  const o = overdue.filter(inScope);
  const b = blocked.filter(inScope).filter((t) => !o.some((x) => x.id === t.id));
  const scopeText = scopes.length ? ` for ${scopes.join(" and ")}` : "";

  out.push(`[Observed] **${o.length} overdue task${o.length === 1 ? "" : "s"}${scopeText}** (open, due before today IST):`);
  out.push(o.length ? o.map(taskLine).join("\n") : "- None.");
  if (wantsBlocked || scopes.length) {
    out.push(`\n[Observed] **Also blocked but not yet overdue${scopeText}:**`);
    out.push(b.length ? b.map(taskLine).join("\n") : "- None.");
  }
  if (scopes.length) {
    for (const s of scopes) {
      const any = [...o, ...b].some((t) => t.initiative === s || t.campaign === s);
      if (!any) out.push(`\n[Observed] ${s}: no overdue or blocked tasks.`);
    }
  }
  // What unblocks what: an overdue task that others wait on is the bottleneck.
  const chains = [...o, ...b].flatMap((t) => (t.blockedBy ?? []).map((dep: string) => ({ t, dep: dep.replace(/\s*\([^)]*\)$/, "") })));
  if (chains.length) {
    out.push("\n**What to unblock first**");
    for (const c of chains) out.push(`- [Recommended] Finish "${c.dep}" first: "${c.t.title}" (${c.t.owner}) cannot move until it is done.`);
  }
  const noOwnerDep = [...o, ...b].filter((t) => t.status === "blocked" && !(t.blockedBy ?? []).length);
  for (const t of noOwnerDep) out.push(`- [Recommended] "${t.title}" is marked blocked with no recorded dependency. Ask ${t.owner} what it is waiting on and record it.`);
  out.push(`\n_Totals: ${m.open} open tasks, ${overdue.length} overdue, ${blocked.length} blocked in the workspace._`);
  return out.join("\n");
}

async function workloadAnswer(run: Run) {
  const [w, m] = await Promise.all([run("get_team_workload"), run("get_task_metrics")]);
  const rows: Any[] = [...(w.workload ?? [])].sort((a, b) => b.openEffortHours - a.openEffortHours);
  const out = ["| Owner | Open | Overdue | Blocked | Open effort (h) |", "|---|---:|---:|---:|---:|"];
  for (const r of rows) out.push(`| ${r.owner} | ${r.open} | ${r.overdue} | ${r.blocked} | ${r.openEffortHours} |`);
  const top = rows[0];
  const lines = [`[Observed] **${top?.owner ?? "Nobody"}** has the highest open workload: ${top?.openEffortHours ?? 0} estimated hours across ${top?.open ?? 0} open tasks (${top?.overdue ?? 0} overdue, ${top?.blocked ?? 0} blocked).`, "", out.join("\n")];
  const overdue: Any[] = m.overdue ?? [];
  lines.push("", `[Observed] **Overdue (${overdue.length}):**`, overdue.length ? overdue.map(taskLine).join("\n") : "- None.");
  if (top && rows[1] && top.openEffortHours > 1.5 * rows[1].openEffortHours) {
    const light = rows[rows.length - 1];
    lines.push("", `[Recommended] ${top.owner} carries ${(top.openEffortHours / rows[1].openEffortHours).toFixed(1)}× the next person's load. Consider moving a task to ${light.owner} (${light.openEffortHours} h open).`);
  }
  return lines.join("\n");
}

async function campaignsRankAnswer(run: Run, q: string) {
  const c = await run("get_campaign_performance");
  const rows: Any[] = (c.campaigns ?? []).filter((x: Any) => x.cost_per_verified_attendee_inr != null);
  const byShow = has(q, "show-up", "show up", "showup", "no-show", "no show", "turnout");
  const byVolume = has(q, "most attendees", "most people", "brought the most", "biggest", "largest", "volume");
  const sorted = byShow ? [...rows].sort((a, b) => pctNum(b.show_up_rate) - pctNum(a.show_up_rate))
    : byVolume ? [...rows].sort((a, b) => b.verified_attendees - a.verified_attendees)
    : [...rows].sort((a, b) => a.cost_per_verified_attendee_inr - b.cost_per_verified_attendee_inr);
  const metric = byShow ? "show-up rate" : byVolume ? "verified attendees" : "cost per verified attendee";
  const val = (x: Any) => (byShow ? x.show_up_rate : byVolume ? fmtInt(x.verified_attendees) : fmtInr(x.cost_per_verified_attendee_inr));
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const out = [
    `[Observed] Ranked by **${metric}** (as of ${c.asOfDate}):`,
    "",
    `- **Best: ${best.campaign}**: ${val(best)} (${fmtInr(best.spend_inr)} spend, ${fmtInt(best.verified_attendees)} verified attendees, ${best.show_up_rate} show-up).`,
    `- **Worst: ${worst.campaign}**: ${val(worst)} (${fmtInr(worst.spend_inr)} spend, ${fmtInt(worst.verified_attendees)} verified attendees, ${worst.show_up_rate} show-up).`,
    "",
    "| Campaign | Spend | Verified attendees | Show-up | Cost / verified attendee | Health |",
    "|---|---:|---:|---:|---:|---|",
    ...sorted.map((x) => `| ${x.campaign} | ${fmtInr(x.spend_inr)} | ${fmtInt(x.verified_attendees)} | ${x.show_up_rate} | ${fmtInr(x.cost_per_verified_attendee_inr)} | ${x.health} |`),
    "",
    `[Calculated] Median cost per verified attendee: ${fmtInr(c.medianCostPerVerifiedAttendee)}; overall show-up rate ${c.overallShowRate}. Cost per verified attendee = spend ÷ verified attendees from that campaign.`,
  ];
  const crit = sorted.filter((x) => x.health === "critical");
  if (crit.length) out.push("", `[Recommended] Review ${crit.map((x) => x.campaign).join(" and ")} (flagged critical) before adding spend; shift budget toward ${sorted.slice(0, 2).map((x) => x.campaign).join(" and ")}, which convert at the lowest cost. This is a correlation in last year's data, not proof of cause.`);
  return out.join("\n");
}

async function campaignDetailAnswer(run: Run, q: string, names: string[]) {
  const [c, tasks] = await Promise.all([run("get_campaign_performance"), run("get_task_metrics")]);
  const rows: Any[] = c.campaigns ?? [];
  const out: string[] = [];
  for (const name of names) {
    const x = rows.find((r) => r.campaign === name);
    if (!x) continue;
    const portfolio = pctNum(c.overallShowRate);
    out.push(`### ${x.campaign} (${x.channel?.replace(/_/g, " ")}, owner ${x.owner ?? "–"})`);
    out.push(`- [Observed] Spend ${fmtInr(x.spend_inr)}; ${fmtInt(x.registered_people)} registered, ${fmtInt(x.confirmed_people)} confirmed, **${fmtInt(x.verified_attendees)} verified attendees**.`);
    out.push(`- [Observed] Show-up rate **${x.show_up_rate}** vs portfolio ${c.overallShowRate}.`);
    out.push(`- [Calculated] Cost per verified attendee **${fmtInr(x.cost_per_verified_attendee_inr)}** vs median ${fmtInr(c.medianCostPerVerifiedAttendee)}${x.cost_per_verified_attendee_inr && c.medianCostPerVerifiedAttendee ? ` (${(x.cost_per_verified_attendee_inr / c.medianCostPerVerifiedAttendee).toFixed(1)}× the median)` : ""}; cost per registration ${fmtInr(x.cost_per_registration_inr)}.`);
    if (x.opted_out_people) out.push(`- [Observed] ${fmtInt(x.opted_out_people)} opted out${x.first_touch_identified_people ? ` (${fmtPct(x.opted_out_people / x.first_touch_identified_people)} of the ${fmtInt(x.first_touch_identified_people)} people it first reached)` : ""}.`);
    out.push(`- Health: **${x.health}**${x.health_reasons?.length ? `: ${x.health_reasons.join("; ")}` : ""}.`);
    if (x.health !== "healthy") {
      out.push("", "**Why it is underperforming (from the data)**");
      if (pctNum(x.show_up_rate) < portfolio) out.push(`- Many people it registers do not turn up: ${x.show_up_rate} show-up vs ${c.overallShowRate} overall, so cost per actual attendee is high even though registrations look fine (${fmtInr(x.cost_per_registration_inr)} each).`);
      if (x.opted_out_people && x.first_touch_identified_people && x.opted_out_people / x.first_touch_identified_people > 0.05) out.push(`- High opt-outs suggest the audience or frequency is off.`);
      out.push("", "**What to do**");
      out.push(`- [Recommended] Cap or pause new spend until show-up improves; move budget to the lowest-cost campaigns.`);
      out.push(`- [Recommended] Add reminders and a confirmation step for its registrants (it is the confirmed→attended step that leaks).`);
      out.push(`- [Recommended] Tighten targeting to students near the venue and exclude opted-out audiences.`);
      out.push(`- These are recommendations from last year's pattern, not proven causes. Ask the AI to draft a task if you want one.`);
    }
    const t = [...(tasks.overdue ?? []), ...(tasks.blocked ?? []), ...(tasks.dueSoon ?? [])].filter((k: Any) => k.campaign === name);
    const uniq = t.filter((k: Any, i: number) => t.findIndex((z: Any) => z.id === k.id) === i);
    if (uniq.length) out.push("", `**Open work on ${name}**`, uniq.map(taskLine).join("\n"));
    out.push("");
  }
  return out.join("\n").trim();
}

async function attendanceAnswer(run: Run) {
  const a = await run("get_attendance_metrics");
  if (!a.available) return "The active dataset has no usable check-in records, so attendance cannot be counted. Upload a Check-ins sheet with result and verification columns.";
  return [
    `[Observed] **${fmtInt(a.uniqueVerifiedAttendees)} unique verified attendees** (as of ${a.asOfDate}).`,
    "",
    ...(a.byDay ?? []).map((d: Any) => `- ${d.day}: ${fmtInt(d.uniquePeople)} unique people (${fmtInt(d.admissionRows)} admissions)`),
    `- Came on more than one day: ${fmtInt(a.attendedMultipleDays)} (counted once in the total)`,
    `- Walk-ins without a registration: ${fmtInt(a.walkInsWithoutRegistration)}`,
    `- Excluded check-ins: ${fmtInt(a.excluded?.notAdmittedOrUnverified)} not admitted or unverified, ${fmtInt(a.excluded?.verifiedButNotExternal)} non-external (staff, volunteers)`,
    "",
    `_${a.definition}_`,
  ].join("\n");
}

async function registrationsAnswer(run: Run) {
  const o = await run("get_overview_metrics");
  const r = o.registrations;
  if (!r?.available) return "The active dataset has no registration records, so this cannot be answered.";
  const st = r.latestStatus ?? {};
  return [
    `[Observed] **${fmtInt(r.registeredPeople)} people registered** (as of ${o.asOfDate}).`,
    "",
    `- Latest status: ${Object.entries(st).map(([k, v]) => `${label(k)} ${fmtInt(v as number)}`).join(", ")}`,
    `- Registered and attended: ${fmtInt(r.registeredPeopleWhoAttended)}`,
    `- [Calculated] Show-up rate **${fmtPct(r.showRate)}**: ${fmtInt(r.registeredPeopleWhoAttended)} ÷ ${fmtInt(r.registeredPeople)}.`,
    `- [Calculated] No-shows among registrants: ${fmtInt(r.registeredPeople - r.registeredPeopleWhoAttended)}.`,
    "",
    `_${r.showRateDefinition}_`,
  ].join("\n");
}

async function funnelAnswer(run: Run) {
  const f = await run("get_funnel_metrics");
  const st: Any[] = f.stages ?? [];
  const worst = st.filter((s) => s.fromPrevious != null).sort((a, b) => a.fromPrevious - b.fromPrevious)[0];
  return [
    `[Observed] Funnel as of ${f.asOfDate}:`,
    "",
    "| Stage | People | From previous stage |",
    "|---|---:|---:|",
    ...st.map((s) => `| ${s.label} | ${s.available ? fmtInt(s.value) : "not in data"} | ${s.fromPrevious == null ? "–" : fmtPct(s.fromPrevious)} |`),
    "",
    worst ? `[Calculated] The biggest drop is **${worst.previousLabel} → ${worst.label}** (${fmtPct(worst.fromPrevious)} carry on).` : "",
    `[Observed] Walk-ins (attended without registering): ${fmtInt(f.walkIns)}.`,
    f.anonymous ? `[Observed] Anonymous marketing counts: ${fmtInt(f.anonymous.impressions)} impressions, ${fmtInt(f.anonymous.clicks)} clicks, ${fmtInt(f.anonymous.registrationStarts)} registration starts. These are events, not people, so they cannot be joined to the funnel above.` : "",
  ].filter(Boolean).join("\n");
}

async function targetAnswer(run: Run, q: string) {
  const [fc, o, s] = await Promise.all([run("forecast_attendance"), run("get_overview_metrics"), run("get_strategy_assumptions")]);
  const cfg = s.config ?? {};
  const stretch = /11[, ]?000|stretch/.test(q);
  const out = [
    `**Short answer:** the data cannot show progress toward the ${fmtInt(stretch ? cfg.stretchTarget : cfg.baseTarget)} target yet.`,
    "",
    `- ${fc.planningNote ?? fc.note}`,
    `- [Observed] Last edition (${o.dataset}) had **${fmtInt(fc.observedAttendees ?? o.attendance?.uniqueVerifiedAttendees)} unique verified attendees**.`,
    `- [Calculated] Reaching ${fmtInt(cfg.baseTarget)} (base) needs ${(cfg.baseTarget / (fc.observedAttendees || 1)).toFixed(1)}× that; ${fmtInt(cfg.stretchTarget)} (stretch) needs ${(cfg.stretchTarget / (fc.observedAttendees || 1)).toFixed(1)}×.`,
    `- [Estimated] Planning assumes a ${fmtPct(cfg.planningShowRate, 0)} show-up rate, so about ${fmtInt(cfg.baseTarget / (cfg.planningShowRate || 1))} confirmed registrations would be needed for the base target. These are planning assumptions, not observations.`,
  ];
  const tg: Any[] = o.targets?.rows ?? [];
  if (tg.length) {
    out.push("", `[Observed] Last edition vs its own targets (${o.targets.version}):`, "", "| Metric | Target | Actual | Attainment |", "|---|---:|---:|---:|");
    for (const t of tg) out.push(`| ${t.metric} | ${/spend/i.test(t.metric) ? fmtInr(t.target) : fmtInt(t.target)} | ${/spend/i.test(t.metric) ? fmtInr(t.actual) : fmtInt(t.actual)} | ${fmtPct(t.attainment)} |`);
  }
  out.push("", "To track the new target, import the upcoming fest's registrations and check-ins as a new dataset.");
  return out.join("\n");
}

async function budgetAnswer(run: Run) {
  const b = await run("get_budget_summary");
  const h = b.historical;
  const out: string[] = [];
  if (h) {
    out.push(`[Observed] **Last edition's marketing:** approved ${fmtInr(h.approvedBudget)}, net spend ${fmtInr(h.netSpend)}, ${fmtInr(h.remaining)} unspent ([Calculated] ${fmtPct(h.netSpend / h.approvedBudget)} used).`, "");
    out.push("| Campaign | Spend |", "|---|---:|", ...(h.byCampaign ?? []).map((c: Any) => `| ${c.campaign} | ${fmtInr(c.spend)} |`));
  }
  for (const p of b.plan ?? []) {
    const lines: Any[] = p.lines ?? [];
    const tot = lines.reduce((a, l) => ({ approved: a.approved + l.approved, committed: a.committed + l.committed, spent: a.spent + l.spent, remaining: a.remaining + l.remaining }), { approved: 0, committed: 0, spent: 0, remaining: 0 });
    out.push("", `[Observed] **Upcoming fest plan (${p.scenario}):** approved ${fmtInr(tot.approved)}, committed ${fmtInr(tot.committed)}, spent ${fmtInr(tot.spent)}, **remaining ${fmtInr(tot.remaining)}**.`);
    out.push("", "| Line | Approved | Committed | Spent | Remaining |", "|---|---:|---:|---:|---:|", ...lines.map((l) => `| ${l.label} | ${fmtInr(l.approved)} | ${fmtInr(l.committed)} | ${fmtInr(l.spent)} | ${fmtInr(l.remaining)} |`));
  }
  out.push("", `_${(b.definitions ?? []).join(" ")}_`);
  return out.join("\n");
}

async function capacityAnswer(run: Run) {
  const c = await run("get_capacity_status");
  if (!c.configured) return `**Not known.** ${c.message} An admin can enter the confirmed daily and total limits under Strategy once campus security confirms them.`;
  return `[Observed] Capacity: ${JSON.stringify(c)}`;
}

async function initiativesAnswer(run: Run, q: string) {
  const r = await run("get_initiative_performance");
  const all: Any[] = r.initiatives ?? [];
  const want = mentionedInitiatives(q);
  const list = want.length ? all.filter((i) => want.includes(i.name)) : all;
  const out: string[] = [];
  if (!want.length) {
    out.push("| Initiative | Decision | Status | Base target | Base budget | Open / overdue / blocked tasks | Scale rule |", "|---|---|---|---:|---:|---|---|");
    for (const i of list) out.push(`| ${i.name} | ${DECISION_LABEL[i.decision] ?? i.decision} | ${label(i.status)} | ${fmtInt(i.plan?.baseTarget)} | ${fmtInr(i.plan?.baseBudget)} | ${i.tasks.open} / ${i.tasks.overdue} / ${i.tasks.blocked} | ${i.thresholdVerdict} |`);
    out.push("", "_Targets and budgets are planning allocations, not results. No initiative has pilot results yet, so none can be judged against its scale/stop rule._");
    return out.join("\n");
  }
  for (const i of list) {
    out.push(`### ${i.name}`, `- What it is: ${i.mechanism}`, `- Decision: **${DECISION_LABEL[i.decision] ?? i.decision}**; status ${label(i.status)}; owner ${i.ownerName ?? "–"}.`);
    out.push(`- [Estimated] Plan: ${fmtInt(i.plan?.baseTarget)} base / ${fmtInt(i.plan?.stretchTarget)} stretch attendees on ${fmtInr(i.plan?.baseBudget)} / ${fmtInr(i.plan?.stretchBudget)}. ${i.plan?.label ?? ""}`);
    if (i.threshold) out.push(`- Rule: scale at ≥${i.threshold.scaleAt} ${i.threshold.unit}, stop below ${i.threshold.stopBelow}. Verdict: **${i.thresholdVerdict}**. ${i.thresholdNote ?? ""}`);
    for (const h of i.historicalProxy ?? []) out.push(`- [Observed] Closest past evidence, ${h.campaign}: ${fmtInt(h.verified)} verified attendees, ${fmtPct(h.showRate)} show-up, ${fmtInr(h.costPerVerified)} per verified attendee.`);
    out.push(`- Tasks: ${i.tasks.open} open, ${i.tasks.overdue} overdue, ${i.tasks.blocked} blocked.`);
    for (const e of i.experiments ?? []) out.push(`- Experiment: ${e.name} (${e.status}). ${e.decisionRule}.`);
    out.push("");
  }
  return out.join("\n").trim();
}

async function experimentsAnswer(run: Run) {
  const r = await run("compare_experiment_cohorts");
  const ex: Any[] = r.experiments ?? [];
  if (!ex.length) return "No experiments are recorded in this workspace.";
  return ex.map((e) => [
    `### ${e.name} (${e.status})`,
    `- Hypothesis: ${e.hypothesis}`,
    `- Primary metric: ${e.primaryMetric}. Decision rule: ${e.decisionRule}.`,
    e.resultsAvailable ? `- [Observed] Treatment ${fmtPct(e.treatmentRate)} (n=${e.treatment_n}) vs control ${fmtPct(e.controlRate)} (n=${e.control_n}); uplift ${e.upliftPctPoints} pts.` : `- **No results yet**, so no uplift can be stated. ${e.caveats ?? ""}`,
  ].join("\n")).join("\n\n");
}

async function attributionAnswer(run: Run) {
  const a = await run("get_attribution");
  if (!a.available) return "The dataset has no campaign links on people or registrations, so attribution cannot be computed.";
  const rows: Any[] = a.rows ?? [];
  return [
    `[Observed] Verified attendees by recorded campaign (as of ${a.asOfDate}):`,
    "",
    "| Campaign | First touch | Registration source | Last interaction |",
    "|---|---:|---:|---:|",
    ...rows.map((r) => `| ${r.campaign} | ${fmtInt(r.firstTouch)} | ${fmtInt(r.registrationSource)} | ${fmtInt(r.lastInteraction)} |`),
    "",
    `[Observed] Top source: **${rows[0]?.campaign}** (${fmtInt(rows[0]?.firstTouch)} attendees by first touch).`,
    "",
    `_${(a.definitions ?? []).join(" ")}_`,
  ].join("\n");
}

async function trendsAnswer(run: Run) {
  const t = await run("get_trends");
  const w: Any[] = t.weeks ?? [];
  if (!w.length) return "No dated records to build a trend from.";
  const peak = [...w].sort((a, b) => b.registrations - a.registrations)[0];
  const spendPeak = [...w].sort((a, b) => b.spend - a.spend)[0];
  return [
    `[Observed] Weekly trend (as of ${t.asOfDate}):`,
    "",
    "| Week starting | Registrations | Newly identified | Spend | Cancellations | Opt-outs |",
    "|---|---:|---:|---:|---:|---:|",
    ...w.map((x) => `| ${x.weekStarting} | ${fmtInt(x.registrations)} | ${fmtInt(x.identified)} | ${fmtInr(x.spend)} | ${fmtInt(x.cancellations)} | ${fmtInt(x.optOuts)} |`),
    "",
    `[Observed] Registrations peaked in the week of **${peak.weekStarting}** (${fmtInt(peak.registrations)}). Spend peaked in the week of ${spendPeak.weekStarting} (${fmtInr(spendPeak.spend)}).`,
  ].join("\n");
}

async function dataAnswer(run: Run) {
  const d = await run("get_data_quality_report");
  const rc = d.rowCounts ?? {};
  return [
    `**Active dataset:** ${d.datasetVersion}${d.isDemo ? " (demo)" : ""}, uploaded ${String(d.uploadedAt).slice(0, 10)}.`,
    "",
    "| Sheet | Rows read | Imported | Rejected | Duplicates removed |",
    "|---|---:|---:|---:|---:|",
    ...Object.values(rc).map((r: Any) => `| ${r.sheet} | ${fmtInt(r.read)} | ${fmtInt(r.imported)} | ${fmtInt(r.rejected)} | ${fmtInt(r.duplicatesRemoved)} |`),
    "",
    `- Rejected rows: ${fmtInt(d.rejectedRows)}. Warnings: ${d.warnings?.length ? d.warnings.join("; ") : "none"}.`,
    `- Missing fields: ${d.missing?.length ? d.missing.join(", ") : "none; every metric in the app can be computed"}.`,
  ].join("\n");
}

async function teamAnswer(run: Run) {
  const t = await run("list_team_members");
  return ["| Name | Role | Initiatives |", "|---|---|---|", ...(t.users ?? []).map((u: Any) => `| ${u.name} | ${u.role.replace(/_/g, " ")} | ${u.initiatives.join(", ") || "–"} |`)].join("\n");
}

async function overviewAnswer(run: Run) {
  const [o, c, m] = await Promise.all([run("get_overview_metrics"), run("get_campaign_performance"), run("get_task_metrics")]);
  const a = o.attendance ?? {};
  const r = o.registrations ?? {};
  const camps: Any[] = (c.campaigns ?? []).filter((x: Any) => x.cost_per_verified_attendee_inr != null).sort((x: Any, y: Any) => x.cost_per_verified_attendee_inr - y.cost_per_verified_attendee_inr);
  return [
    `**${o.dataset}**, as of ${o.asOfDate}:`,
    "",
    `- [Observed] **${fmtInt(a.uniqueVerifiedAttendees)} unique verified attendees**; ${fmtInt(r.registeredPeople)} registered; show-up ${fmtPct(r.showRate)}.`,
    ...(o.targets?.rows ?? []).map((t: Any) => `- [Calculated] ${t.metric}: ${fmtPct(t.attainment)} of target.`),
    camps.length ? `- [Calculated] Cheapest campaign per verified attendee: ${camps[0].campaign} (${fmtInr(camps[0].cost_per_verified_attendee_inr)}); most expensive: ${camps[camps.length - 1].campaign} (${fmtInr(camps[camps.length - 1].cost_per_verified_attendee_inr)}).` : "",
    `- [Observed] Workspace: ${m.open} open tasks, ${(m.overdue ?? []).length} overdue, ${(m.blocked ?? []).length} blocked.`,
  ].filter(Boolean).join("\n");
}

const OUT_OF_SCOPE: [RegExp, string][] = [
  [/sponsor(ship)? (revenue|income|money|earn)|revenue|profit|ticket (sales|revenue)|\bearn(ed|ings)?\b/, "revenue or sponsor income"],
  [/weather|rain|temperature/, "weather"],
  [/competitor|other fests?|rival fest/, "competitor fests"],
  [/salary|salaries|payroll/, "staff pay"],
];

const INTENTS: Intent[] = [
  { key: "tasks", score: (q) => has(q, "workload", "busiest") ? 0 : (has(q, "overdue", "blocked", "blocking", "blocker", "stuck", "late task", "pending task", "behind schedule") ? 3 + count(q, "task", "work", "deadline") : has(q, /\btasks?\b/) && !has(q, "workload", "who has") ? 2 : 0), answer: tasksAnswer },
  { key: "workload", score: (q) => (has(q, "workload", "who is busiest", "busiest", "overloaded", "capacity of the team", "who has the most", "who has the highest", "bandwidth") ? 5 : 0), answer: (run) => workloadAnswer(run) },
  { key: "campaigns", score: (q) => (has(q, "best", "worst", "rank", "top", "cheapest", "most expensive", "compare", "efficient", "roi", "return on") && has(q, "campaign", "channel", "marketing", "cost per", "cpa") ? 4 : has(q, "cost per verified", "cost per attendee", "cost per registration", "campaign performance", "all campaigns", "which campaign") ? 3 : 0), answer: campaignsRankAnswer },
  { key: "attendance", score: (q) => (has(q, "attend", "footfall", "turned up", "showed up", "visitors", "check-in", "checkin", "check in", "walk-in", "walk in", "came to") && !has(q, "target", "on track", "9,000", "9000", "11,000", "forecast") ? (has(q, "show-up rate", "show up rate", "no-show") ? 1 : 3) : 0), answer: (run) => attendanceAnswer(run) },
  { key: "registrations", score: (q) => (has(q, "registration", "registered", "sign-up", "signup", "sign up", "show-up rate", "show up rate", "no-show", "no show", "cancel", "waitlist") ? 3 : 0), answer: (run) => registrationsAnswer(run) },
  { key: "funnel", score: (q) => (has(q, "funnel", "conversion", "convert", "drop-off", "drop off", "leak") ? 4 : 0), answer: (run) => funnelAnswer(run) },
  { key: "target", score: (q) => (has(q, "on track", "target", "9,000", "9000", "11,000", "11000", "forecast", "projection", "goal", "will we reach", "hit the") ? 4 : 0), answer: targetAnswer },
  { key: "budget", score: (q) => (has(q, "budget", "spend", "spent", "money left", "remaining money", "how much money", "cost overall", "committed") && !has(q, "cost per") ? 3 : 0), answer: (run) => budgetAnswer(run) },
  { key: "capacity", score: (q) => (has(q, "capacity", "venue limit", "how many people can", "fire limit", "max people") ? 4 : 0), answer: (run) => capacityAnswer(run) },
  { key: "initiatives", score: (q) => (mentionedInitiatives(q).length && !has(q, "overdue", "blocked", "blocking", "task") ? 4 : has(q, "initiative", "growth ideas", "five ideas", "strategy ideas") ? 3 : 0), answer: initiativesAnswer },
  { key: "experiments", score: (q) => (has(q, "experiment", "a/b", "ab test", "pilot result", "uplift", "control group") ? 5 : 0), answer: (run) => experimentsAnswer(run) },
  { key: "attribution", score: (q) => (has(q, "attribution", "where did", "which source", "source of", "first touch", "last touch", "brought in", "came from") ? 4 : 0), answer: (run) => attributionAnswer(run) },
  { key: "trends", score: (q) => (has(q, "trend", "week by week", "weekly", "over time", "peak", "when did", "growth over") ? 4 : 0), answer: (run) => trendsAnswer(run) },
  { key: "data", score: (q) => (has(q, "data quality", "dataset", "rows", "duplicates", "rejected", "what data", "which data", "missing data", "uploaded data", "data issue", "problem with the data", "problems with the data", "clean") || (has(q, /\bdata\b/) && has(q, "problem", "issue", "error", "wrong", "quality")) ? 4 : 0), answer: (run) => dataAnswer(run) },
  { key: "team", score: (q) => (has(q, "team members", "who is on the team", "who owns", "list the team", "who are the") ? 3 : 0), answer: (run) => teamAnswer(run) },
  { key: "overview", score: (q) => (has(q, "overview", "summary", "summarise", "summarize", "how did the fest", "how did we do", "key numbers", "kpi", "headline") ? 3 : 0), answer: (run) => overviewAnswer(run) },
];

function makeRun(tc: ToolContext, trace: QuickResult["trace"]): Run {
  return async (tool, input = {}) => {
    const t0 = Date.now();
    const out = await runTool(tool, input, tc);
    trace.push({ tool, input, ok: out.ok, ms: Date.now() - t0, result: out.result });
    if (!out.ok) throw new Error((out.result as Any)?.error ?? `${tool} failed`);
    return out.result;
  };
}

/**
 * Answers the question from the data if it matches a known question type, otherwise returns null.
 * `loose` lowers the bar (used when the AI has failed, so any reasonable data answer beats an error).
 */
export async function quickAnswer(message: string, tc: ToolContext, opts: { loose?: boolean } = {}): Promise<QuickResult | null> {
  const q = norm(message);
  if (!opts.loose && WRITE_ASK.test(q)) return null;
  const trace: QuickResult["trace"] = [];
  const run = makeRun(tc, trace);

  for (const [re, what] of OUT_OF_SCOPE) {
    if (re.test(q) && !has(q, "budget", "spend")) {
      return { intent: "out_of_scope", trace, text: `**The data cannot answer this.** The workspace holds attendance, registrations, campaigns, marketing spend, tasks and budgets. It has no ${what}, so any number would be a guess. To answer it, import a sheet with that data (for example, sponsor contracts with amounts).` };
    }
  }

  // A named campaign plus "why / how is / underperforming" gets the campaign deep-dive.
  if (has(q, "why", "how is", "how's", "how did", "underperform", "doing", "perform", "diagnos", "problem", "issue", "fix", "improve", "what should we do") && !has(q, "overdue", "blocked", "blocking", "task")) {
    const c = await run("get_campaign_performance").catch(() => null);
    const names = c ? mentionedCampaigns(q, (c.campaigns ?? []).map((x: Any) => x.campaign)) : [];
    if (names.length) return { intent: "campaign_detail", text: await campaignDetailAnswer(run, q, names), trace };
    trace.length = 0;
  }

  const ranked = INTENTS.map((i) => ({ i, s: i.score(q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const best = ranked[0];
  const threshold = opts.loose ? 1 : 3;
  if (!best || best.s < threshold) {
    if (!opts.loose) return null;
    return { intent: "overview", text: await overviewAnswer(run), trace };
  }
  // Two strong, different matches ("attendance and budget") are a compound question: answer both.
  const second = ranked[1];
  const parts = [await best.i.answer(run, q)];
  if (second && second.s >= 4 && best.s >= 4 && second.i.key !== best.i.key) parts.push(await second.i.answer(run, q));
  return { intent: best.i.key, text: parts.join("\n\n---\n\n"), trace };
}
