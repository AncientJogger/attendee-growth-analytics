// Tools the AI Growth Analyst can call. Each one validates its input, runs inside the
// requesting user's RLS-scoped transaction and returns compact JSON. No free-form SQL.
import { z } from "zod";
import { withUser, type Actor, type Q } from "../db";
import { getDatasetContext, getStrategy, type DatasetContext } from "../analytics/context";
import { attendanceMetrics, attributionViews, campaignPerformance, compareRanges, funnelMetrics, registrationMetrics, targetsVsActual, weeklyTrend } from "../analytics/metrics";
import { budgetSummary, capacityStatus, dataQualityReport, forecastAttendance, initiativeOverview, listTasks, taskMetrics } from "../analytics/management";
import { propose } from "../approvals";

export interface ToolContext {
  actor: Actor;
  threadId: string | null;
  defaultAsOfDate?: string | null;
  proposals: string[];
}

type JsonSchema = Record<string, unknown>;
interface Tool {
  name: string;
  description: string;
  input_schema: JsonSchema;
  parse: z.ZodTypeAny;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool's input is validated by its own zod schema first
  run: (q: Q, ctx: DatasetContext | null, input: any, tc: ToolContext) => Promise<unknown>;
}

const asOf = { as_of_date: { type: "string", description: "Optional snapshot date YYYY-MM-DD (dataset timezone). Omit for the dataset default (end of its records)." } };
const asOfZ = { as_of_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() };

const r = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d);
const pct = (x: number | null | undefined) => (x === null || x === undefined ? null : `${(x * 100).toFixed(1)}%`);

function needDataset(ctx: DatasetContext | null): asserts ctx is DatasetContext {
  if (!ctx) throw new Error("No active dataset is loaded in this workspace. Ask an admin to import or activate one.");
}

async function findCampaigns(q: Q, ctx: DatasetContext, refs: string[] | undefined) {
  if (!refs?.length) return undefined;
  const rows = await q<{ id: string; name: string; source_id: string }>("select id, name, source_id from campaigns where dataset_version_id = $1", [ctx.dv]);
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const ref of refs) {
    const k = ref.trim().toLowerCase();
    const hit = rows.find((c) => c.id === ref || c.source_id.toLowerCase() === k || c.name.toLowerCase() === k) ?? rows.find((c) => c.name.toLowerCase().includes(k));
    if (hit) ids.push(hit.id); else unknown.push(ref);
  }
  if (unknown.length) throw new Error(`No campaign matches: ${unknown.join(", ")}. Available: ${rows.map((c) => c.name).join(", ")}.`);
  return ids;
}

async function findInitiative(q: Q, ws: string, ref: string | undefined) {
  if (!ref) return undefined;
  const rows = await q<{ id: string; key: string; name: string }>("select id, key, name from initiatives where workspace_id = $1", [ws]);
  const k = ref.trim().toLowerCase();
  const hit = rows.find((i) => i.id === ref || i.key === k || i.name.toLowerCase() === k) ?? rows.find((i) => i.name.toLowerCase().includes(k));
  if (!hit) throw new Error(`No initiative matches "${ref}". Available: ${rows.map((i) => i.name).join(", ")}.`);
  return hit.id;
}

async function findUser(q: Q, ws: string, ref: string | undefined) {
  if (!ref) return undefined;
  const rows = await q<{ id: string; display_name: string; email: string }>("select id, display_name, email from app_users where workspace_id = $1", [ws]);
  const k = ref.trim().toLowerCase();
  const hit = rows.find((u) => u.id === ref || u.email.toLowerCase() === k || u.display_name.toLowerCase() === k) ?? rows.find((u) => u.display_name.toLowerCase().includes(k));
  if (!hit) throw new Error(`No team member matches "${ref}". Use list_team_members to see who exists.`);
  return hit.id;
}

function campaignJson(c: Awaited<ReturnType<typeof campaignPerformance>>["rows"][number]) {
  return {
    id: c.id, campaign: c.name, source_id: c.sourceId, channel: c.channel, status: c.status, owner: c.ownerName, initiative: c.initiativeName,
    spend_inr: c.spend, registered_people: c.registeredPeople, confirmed_people: c.confirmedPeople, verified_attendees: c.verifiedAttendees,
    show_up_rate: pct(c.showRate), cost_per_registration_inr: r(c.costPerRegistration, 0), cost_per_verified_attendee_inr: r(c.costPerVerifiedAttendee, 0),
    first_touch_identified_people: c.firstTouchPeople, opted_out_people: c.optedOut, anonymous_impressions: c.impressions, anonymous_clicks: c.clicks,
    approved_budget_inr: c.budgetApproved, health: c.health, health_reasons: c.healthReasons,
  };
}

export const TOOLS: Tool[] = [
  {
    name: "get_dataset_profile",
    description: "Describe the active dataset: label, event, coverage dates, default as-of date, row counts, which fields exist (capabilities), warnings. Call first when unsure what data exists.",
    input_schema: { type: "object", properties: {} }, parse: z.object({}),
    run: async (_q, ctx) => { needDataset(ctx); return { ...dataQualityReport(ctx), event: ctx.event, defaultAsOfDate: ctx.asOfDate }; },
  },
  {
    name: "get_data_quality_report",
    description: "Duplicates removed, rejected rows with reasons, missing fields and import warnings for the active dataset.",
    input_schema: { type: "object", properties: {} }, parse: z.object({}),
    run: async (q, ctx) => {
      needDataset(ctx);
      const errs = await q<{ reason: string; n: string }>("select reason, count(*) n from import_errors where dataset_version_id = $1 group by 1 order by 2 desc limit 10", [ctx.dv]);
      return { ...dataQualityReport(ctx), rejectedByReason: errs.map((e) => ({ reason: e.reason, rows: Number(e.n) })) };
    },
  },
  {
    name: "get_overview_metrics",
    description: "Headline metrics as of a date: unique verified attendees, registrations and status mix, show-up rate, targets vs actuals, spend.",
    input_schema: { type: "object", properties: { ...asOf } }, parse: z.object(asOfZ),
    run: async (q, ctx) => {
      needDataset(ctx);
      const [att, reg, tgt] = [await attendanceMetrics(q, ctx), await registrationMetrics(q, ctx), await targetsVsActual(q, ctx)];
      return { asOfDate: ctx.asOfDate, dataset: ctx.label, attendance: att, registrations: reg, targets: tgt };
    },
  },
  {
    name: "get_attendance_metrics",
    description: "Verified attendance detail: unique attendees, by day, multi-day visitors, walk-ins, excluded check-in rows and the exact definition.",
    input_schema: { type: "object", properties: { ...asOf } }, parse: z.object(asOfZ),
    run: async (q, ctx) => { needDataset(ctx); return { asOfDate: ctx.asOfDate, ...(await attendanceMetrics(q, ctx)) }; },
  },
  {
    name: "get_funnel_metrics",
    description: "Identified → engaged → registered → confirmed → attended funnel with each conversion's denominator, plus anonymous daily activity totals (not people).",
    input_schema: { type: "object", properties: { ...asOf } }, parse: z.object(asOfZ),
    run: async (q, ctx) => { needDataset(ctx); return { asOfDate: ctx.asOfDate, ...(await funnelMetrics(q, ctx)) }; },
  },
  {
    name: "get_campaign_performance",
    description: "Per-campaign spend, registrations, verified attendees, show-up, cost per registration and per verified attendee, opt-outs and a relative health flag. Optionally filter by campaign names or IDs.",
    input_schema: { type: "object", properties: { ...asOf, campaigns: { type: "array", items: { type: "string" }, description: "Campaign names, source IDs (e.g. C02) or UUIDs" } } },
    parse: z.object({ ...asOfZ, campaigns: z.array(z.string()).optional() }),
    run: async (q, ctx, input) => {
      needDataset(ctx);
      const ids = await findCampaigns(q, ctx, input.campaigns);
      const res = await campaignPerformance(q, ctx, { campaignIds: ids });
      return { asOfDate: ctx.asOfDate, overallShowRate: pct(res.overallShowRate), medianCostPerVerifiedAttendee: r(res.medianCostPerVerified, 0), campaigns: res.rows.map(campaignJson), definitions: res.definitions };
    },
  },
  {
    name: "compare_campaigns",
    description: "Rank campaigns on one metric, best first. Metrics: cost_per_verified_attendee, cost_per_registration, show_up_rate, verified_attendees, registered_people, spend.",
    input_schema: { type: "object", properties: { ...asOf, metric: { type: "string", enum: ["cost_per_verified_attendee", "cost_per_registration", "show_up_rate", "verified_attendees", "registered_people", "spend"] }, campaigns: { type: "array", items: { type: "string" } } }, required: ["metric"] },
    parse: z.object({ ...asOfZ, metric: z.enum(["cost_per_verified_attendee", "cost_per_registration", "show_up_rate", "verified_attendees", "registered_people", "spend"]), campaigns: z.array(z.string()).optional() }),
    run: async (q, ctx, input) => {
      needDataset(ctx);
      const ids = await findCampaigns(q, ctx, input.campaigns);
      const { rows } = await campaignPerformance(q, ctx, { campaignIds: ids });
      const get: Record<string, (c: (typeof rows)[number]) => number | null> = {
        cost_per_verified_attendee: (c) => c.costPerVerifiedAttendee, cost_per_registration: (c) => c.costPerRegistration, show_up_rate: (c) => c.showRate,
        verified_attendees: (c) => c.verifiedAttendees, registered_people: (c) => c.registeredPeople, spend: (c) => c.spend,
      };
      const lowerIsBetter = input.metric.startsWith("cost") || input.metric === "spend";
      const ranked = rows.map((c) => ({ campaign: c.name, value: get[input.metric](c) })).filter((x) => x.value !== null)
        .sort((a, b) => (lowerIsBetter ? a.value! - b.value! : b.value! - a.value!));
      return { asOfDate: ctx.asOfDate, metric: input.metric, order: lowerIsBetter ? "lowest first" : "highest first", ranking: ranked.map((x, i) => ({ rank: i + 1, ...x, value: input.metric === "show_up_rate" ? pct(x.value) : r(x.value, 0) })),
        excluded: rows.filter((c) => get[input.metric](c) === null).map((c) => c.name) };
    },
  },
  {
    name: "get_attribution",
    description: "Verified attendees by campaign under three descriptive models: first touch, registration source, last interaction before first admission.",
    input_schema: { type: "object", properties: { ...asOf } }, parse: z.object(asOfZ),
    run: async (q, ctx) => { needDataset(ctx); return { asOfDate: ctx.asOfDate, ...(await attributionViews(q, ctx)) }; },
  },
  {
    name: "get_trends",
    description: "Weekly series: registrations, newly identified people, spend, cancellations and opt-outs.",
    input_schema: { type: "object", properties: { ...asOf } }, parse: z.object(asOfZ),
    run: async (q, ctx) => { needDataset(ctx); return { asOfDate: ctx.asOfDate, weeks: await weeklyTrend(q, ctx) }; },
  },
  {
    name: "compare_date_ranges",
    description: "Compare two date ranges (inclusive, YYYY-MM-DD): registrations, identified people, spend, interactions, cancellations, verified attendees, with absolute and % change.",
    input_schema: { type: "object", properties: { a_from: { type: "string" }, a_to: { type: "string" }, b_from: { type: "string" }, b_to: { type: "string" } }, required: ["a_from", "a_to", "b_from", "b_to"] },
    parse: z.object({ a_from: z.string(), a_to: z.string(), b_from: z.string(), b_to: z.string() }),
    run: async (q, ctx, i) => { needDataset(ctx); return compareRanges(q, ctx, { from: i.a_from, to: i.a_to }, { from: i.b_from, to: i.b_to }); },
  },
  {
    name: "get_initiative_performance",
    description: "Strategy initiatives: planning targets and budgets (assumptions), linked 2025 proxy campaign evidence, open/overdue/blocked tasks, experiments, and the scale/change/stop threshold and whether it can be applied.",
    input_schema: { type: "object", properties: { initiative: { type: "string", description: "Name or key, e.g. Campus Cup. Omit for all." } } },
    parse: z.object({ initiative: z.string().optional() }),
    run: async (q, ctx, input, tc) => {
      const id = await findInitiative(q, tc.actor.workspaceId, input.initiative);
      return { initiatives: await initiativeOverview(q, tc.actor.workspaceId, ctx, id) };
    },
  },
  {
    name: "get_budget_summary",
    description: "Plan budget lines by scenario (approved, committed, spent, remaining, ceiling headroom; sponsor-funded separate) and the dataset's historical approved budget vs net spend by campaign.",
    input_schema: { type: "object", properties: {} }, parse: z.object({}),
    run: async (q, ctx, _i, tc) => budgetSummary(q, tc.actor.workspaceId, ctx),
  },
  {
    name: "get_task_metrics",
    description: "Task counts by status, overdue, due soon, blocked, completion rate and workload by owner. Optional filters.",
    input_schema: { type: "object", properties: { initiative: { type: "string" }, owner: { type: "string" } } },
    parse: z.object({ initiative: z.string().optional(), owner: z.string().optional() }),
    run: async (q, _ctx, input, tc) => {
      const m = await taskMetrics(q, tc.actor.workspaceId, { initiativeId: await findInitiative(q, tc.actor.workspaceId, input.initiative), ownerId: await findUser(q, tc.actor.workspaceId, input.owner) });
      const slim = (t: (typeof m.overdue)[number]) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, owner: t.ownerName, due: t.dueDate, initiative: t.initiativeName, campaign: t.campaignName, blockedBy: t.blockedBy.map((b) => b.title) });
      return { ...m, overdue: m.overdue.map(slim), dueSoon: m.dueSoon.map(slim), blocked: m.blocked.map(slim) };
    },
  },
  {
    name: "get_overdue_tasks",
    description: "Open tasks past their deadline, with owner, linked initiative/campaign and unfinished dependencies. Optional filter by initiative or campaign.",
    input_schema: { type: "object", properties: { initiative: { type: "string" }, campaign: { type: "string" } } },
    parse: z.object({ initiative: z.string().optional(), campaign: z.string().optional() }),
    run: async (q, ctx, input, tc) => {
      const campaignId = input.campaign && ctx ? (await findCampaigns(q, ctx, [input.campaign]))?.[0] : undefined;
      const tasks = await listTasks(q, tc.actor.workspaceId, { initiativeId: await findInitiative(q, tc.actor.workspaceId, input.initiative), campaignId, onlyOpen: true });
      return { overdue: tasks.filter((t) => t.overdue).map((t) => ({ id: t.id, title: t.title, status: t.status, owner: t.ownerName, due: t.dueDate, initiative: t.initiativeName, campaign: t.campaignName, blockedBy: t.blockedBy.map((b) => `${b.title} (${b.status})`) })) };
    },
  },
  {
    name: "get_team_workload",
    description: "Open tasks, overdue, blocked and remaining estimated effort per owner.",
    input_schema: { type: "object", properties: {} }, parse: z.object({}),
    run: async (q, _c, _i, tc) => { const m = await taskMetrics(q, tc.actor.workspaceId); return { workload: m.workload, definitions: m.definitions }; },
  },
  {
    name: "list_team_members",
    description: "Workspace users who can own tasks (id, name, role) and initiatives they are assigned to. Use before drafting a task with an owner.",
    input_schema: { type: "object", properties: {} }, parse: z.object({}),
    run: async (q, _c, _i, tc) => ({
      users: await q("select u.id, u.display_name name, u.role, coalesce((select json_agg(i.name) from initiative_assignments ia join initiatives i on i.id = ia.initiative_id where ia.user_id = u.id), '[]') initiatives from app_users u where u.workspace_id = $1 order by u.role, u.display_name", [tc.actor.workspaceId]),
    }),
  },
  {
    name: "compare_experiment_cohorts",
    description: "Treatment vs control results for an experiment (conversion rates and percentage-point uplift) if results are recorded.",
    input_schema: { type: "object", properties: { experiment: { type: "string", description: "Experiment name; omit to list all." } } },
    parse: z.object({ experiment: z.string().optional() }),
    run: async (q, _c, input, tc) => {
      const rows = await q<Record<string, unknown>>("select * from experiments where workspace_id = $1", [tc.actor.workspaceId]);
      const sel = input.experiment ? rows.filter((e) => String(e.name).toLowerCase().includes(input.experiment!.toLowerCase())) : rows;
      return {
        experiments: sel.map((e) => {
          const tn = Number(e.treatment_n ?? 0), cn = Number(e.control_n ?? 0);
          const has = tn > 0 && cn > 0 && e.treatment_conversions !== null && e.control_conversions !== null;
          const tr = has ? Number(e.treatment_conversions) / tn : null, cr = has ? Number(e.control_conversions) / cn : null;
          return { name: e.name, status: e.status, hypothesis: e.hypothesis, primaryMetric: e.primary_metric, decisionRule: e.decision_rule, treatment_n: tn || null, control_n: cn || null,
            treatmentRate: pct(tr), controlRate: pct(cr), upliftPctPoints: has ? r((tr! - cr!) * 100, 1) : null, resultsAvailable: has, caveats: e.caveats };
        }),
      };
    },
  },
  {
    name: "forecast_attendance",
    description: "Attendance outlook for the dataset's event as of a date: observed if the event is over; a run-rate estimate with stated assumptions if enough history exists; otherwise insufficient. Also states the upcoming fest's plan target.",
    input_schema: { type: "object", properties: { ...asOf, scenario: { type: "string", enum: ["base", "stretch"] } } },
    parse: z.object({ ...asOfZ, scenario: z.enum(["base", "stretch"]).default("base") }),
    run: async (q, ctx, input, tc) => forecastAttendance(q, tc.actor.workspaceId, ctx, input.scenario),
  },
  {
    name: "get_capacity_status",
    description: "Whether a venue capacity has been confirmed in Strategy & Targets, and if so whether a target fits.",
    input_schema: { type: "object", properties: { target: { type: "number" } } }, parse: z.object({ target: z.number().optional() }),
    run: async (q, _c, input, tc) => capacityStatus(q, tc.actor.workspaceId, input.target),
  },
  {
    name: "get_strategy_assumptions",
    description: "Current Strategy & Targets configuration: baseline, base/stretch targets, TAM/SAM, budget ceilings, planning show-up rate, thresholds. These are planning assumptions, not observations.",
    input_schema: { type: "object", properties: {} }, parse: z.object({}),
    run: async (q, _c, _i, tc) => { const s = await getStrategy(q, tc.actor.workspaceId); return { ...s, label: "Planning assumptions (not observed data)" }; },
  },
  {
    name: "draft_task",
    description: "Draft a task for human approval. Nothing is created until an authorised person approves it in the approval queue. Owner and initiative/campaign can be names.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" }, description: { type: "string" }, owner: { type: "string" }, reviewer: { type: "string" }, initiative: { type: "string" }, campaign: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high", "critical"] }, start_date: { type: "string" }, due_date: { type: "string", description: "YYYY-MM-DD" },
        effort_hours: { type: "number" }, rationale: { type: "string", description: "Why, citing the evidence you retrieved" },
      },
      required: ["title", "rationale"],
    },
    parse: z.object({ title: z.string(), description: z.string().optional(), owner: z.string().optional(), reviewer: z.string().optional(), initiative: z.string().optional(), campaign: z.string().optional(),
      priority: z.enum(["low", "medium", "high", "critical"]).default("medium"), start_date: z.string().optional(), due_date: z.string().optional(), effort_hours: z.number().optional(), rationale: z.string() }),
    run: async (q, ctx, i, tc) => {
      const ws = tc.actor.workspaceId;
      const payload = {
        title: i.title, description: i.description ?? null, ownerUserId: (await findUser(q, ws, i.owner)) ?? null, reviewerUserId: (await findUser(q, ws, i.reviewer)) ?? null,
        initiativeId: (await findInitiative(q, ws, i.initiative)) ?? null, campaignId: i.campaign && ctx ? (await findCampaigns(q, ctx, [i.campaign]))![0] : null,
        priority: i.priority, status: "todo", progress: 0, startDate: i.start_date ?? null, dueDate: i.due_date ?? null, effortHours: i.effort_hours ?? null,
      };
      const res = await propose(q, tc.actor, { kind: "create_task", payload }, { by: "ai", rationale: i.rationale, threadId: tc.threadId });
      tc.proposals.push(res.approvalId);
      return { approvalId: res.approvalId, status: "pending_approval", note: "Draft only. The user must approve it in the approval card or the Approvals page; it is not a task yet.", draft: { ...payload, owner: i.owner ?? null } };
    },
  },
  {
    name: "submit_change_for_approval",
    description: "Propose a change for human approval: update_task (owner, due date, status, priority), update_campaign (status, owner, approved budget, notes) or budget_change (approved/committed on a budget line). Never applied without approval.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["update_task", "update_campaign", "budget_change"] },
        target_id: { type: "string", description: "Task UUID, campaign name/ID, or budget line UUID" },
        changes: { type: "object", description: "update_task: {owner, due_date, status, priority}; update_campaign: {status, budget_approved_inr, notes}; budget_change: {approved_inr, committed_inr}" },
        rationale: { type: "string" },
      },
      required: ["kind", "target_id", "changes", "rationale"],
    },
    parse: z.object({ kind: z.enum(["update_task", "update_campaign", "budget_change"]), target_id: z.string(), changes: z.record(z.string(), z.unknown()), rationale: z.string() }),
    run: async (q, ctx, i, tc) => {
      const ws = tc.actor.workspaceId;
      const c = i.changes as Record<string, unknown>;
      let proposal: unknown;
      if (i.kind === "update_task") {
        proposal = { kind: "update_task", payload: { taskId: i.target_id, changes: { ownerUserId: c.owner ? await findUser(q, ws, String(c.owner)) : undefined, dueDate: c.due_date as string | undefined, status: c.status as string | undefined, priority: c.priority as string | undefined } } };
      } else if (i.kind === "update_campaign") {
        needDataset(ctx);
        const [cid] = (await findCampaigns(q, ctx, [i.target_id]))!;
        proposal = { kind: "update_campaign", payload: { campaignId: cid, changes: { status: c.status as string | undefined, budgetApprovedInr: c.budget_approved_inr as number | undefined, notes: c.notes as string | undefined } } };
      } else {
        proposal = { kind: "budget_change", payload: { budgetLineId: i.target_id, changes: { approvedInr: c.approved_inr as number | undefined, committedInr: c.committed_inr as number | undefined } } };
      }
      const res = await propose(q, tc.actor, proposal, { by: "ai", rationale: i.rationale, threadId: tc.threadId });
      tc.proposals.push(res.approvalId);
      return { approvalId: res.approvalId, status: "pending_approval", before: res.before, note: "Not applied. An authorised person must approve it." };
    },
  },
];

export const TOOL_DEFS = TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

/** Runs one tool call in its own RLS-scoped transaction, so every call reads the latest committed data. */
export async function runTool(name: string, rawInput: unknown, tc: ToolContext): Promise<{ ok: boolean; result: unknown }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, result: { error: `Unknown tool ${name}` } };
  const parsed = tool.parse.safeParse(rawInput ?? {});
  if (!parsed.success) return { ok: false, result: { error: "Invalid input", issues: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`) } };
  try {
    const result = await withUser(tc.actor, async (q) => {
      const ctx = await getDatasetContext(q, tc.actor.workspaceId, { asOfDate: (parsed.data as { as_of_date?: string }).as_of_date ?? tc.defaultAsOfDate ?? null });
      return tool.run(q, ctx, parsed.data, tc);
    });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, result: { error: (e as Error).message } };
  }
}
