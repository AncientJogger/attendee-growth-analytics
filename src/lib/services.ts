// All mutations go through here: validate, check permission, write inside an RLS-scoped
// transaction, record an audit entry and bump the workspace data version.
import { z } from "zod";
import { audit, bumpVersion, withUser, type Actor, type Q } from "./db";
import { DEFAULT_STRATEGY, type StrategyConfig } from "./strategy";

export class PermissionError extends Error {}
export class ValidationError extends Error {}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const TASK_STATUS = ["backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled"] as const;
const PRIORITY = ["low", "medium", "high", "critical"] as const;

const taskFields = {
  title: z.string().trim().min(3).max(200),
  description: z.string().max(4000).optional().nullable(),
  initiativeId: z.string().uuid().optional().nullable(),
  campaignId: z.string().uuid().optional().nullable(),
  ownerUserId: z.string().uuid().optional().nullable(),
  reviewerUserId: z.string().uuid().optional().nullable(),
  startDate: dateStr.optional().nullable(),
  dueDate: dateStr.optional().nullable(),
  effortHours: z.coerce.number().min(0).max(1000).optional().nullable(),
};
export const taskInput = z.object({
  ...taskFields,
  priority: z.enum(PRIORITY).default("medium"),
  status: z.enum(TASK_STATUS).default("todo"),
  progress: z.coerce.number().int().min(0).max(100).default(0),
});
export type TaskInput = z.infer<typeof taskInput>;

function denyIfEmpty<T>(rows: T[], what: string): T {
  if (!rows[0]) throw new PermissionError(`You don't have permission to change this ${what}, or it no longer exists.`);
  return rows[0];
}

async function assertUserInWorkspace(q: Q, ws: string, userId: string | null | undefined, label: string) {
  if (!userId) return;
  const r = await q("select 1 from app_users where id = $1 and workspace_id = $2", [userId, ws]);
  if (!r.length) throw new ValidationError(`${label} is not a member of this workspace.`);
}

export async function insertTask(q: Q, actor: Actor, input: TaskInput, origin: "user" | "ai" = "user", approvalId: string | null = null) {
  if (actor.role === "team_member") throw new PermissionError("Team members can update their assigned tasks but cannot create tasks.");
  await assertUserInWorkspace(q, actor.workspaceId, input.ownerUserId, "Owner");
  await assertUserInWorkspace(q, actor.workspaceId, input.reviewerUserId, "Reviewer");
  if (input.startDate && input.dueDate && input.startDate > input.dueDate) throw new ValidationError("Start date is after the deadline.");
  const row = denyIfEmpty(await q<{ id: string }>(
    `insert into tasks (workspace_id, title, description, initiative_id, campaign_id, owner_user_id, reviewer_user_id, priority, status, progress, start_date, due_date, effort_hours, origin, created_by, approval_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
    [actor.workspaceId, input.title, input.description ?? null, input.initiativeId ?? null, input.campaignId ?? null, input.ownerUserId ?? null, input.reviewerUserId ?? null,
      input.priority, input.status, input.progress, input.startDate ?? null, input.dueDate ?? null, input.effortHours ?? null, origin, actor.userId, approvalId]).catch(rlsToPermission), "task");
  await audit(q, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "create", entity: "task", entityId: row.id, after: input, reason: origin === "ai" ? "Approved AI draft" : null });
  await bumpVersion(q, actor.workspaceId);
  return row.id;
}

function rlsToPermission(e: unknown): never {
  const msg = String((e as Error)?.message ?? e);
  if (/row-level security|permission denied/i.test(msg)) throw new PermissionError("You don't have permission for this change.");
  throw e;
}

export function createTask(actor: Actor, raw: unknown) {
  const input = taskInput.parse(raw);
  return withUser(actor, (q) => insertTask(q, actor, input));
}

export const taskPatch = z.object({
  ...taskFields,
  priority: z.enum(PRIORITY),
  status: z.enum(TASK_STATUS),
  progress: z.coerce.number().int().min(0).max(100),
}).partial();
export async function applyTaskPatch(q: Q, actor: Actor, taskId: string, raw: unknown, reason?: string | null) {
  const patch = taskPatch.parse(raw);
  const [before] = await q<Record<string, unknown>>("select * from tasks where id = $1", [taskId]);
  if (!before) throw new ValidationError("Task not found.");
  if (actor.role === "team_member") {
    const allowed = ["status", "progress"];
    const extra = Object.keys(patch).filter((k) => !allowed.includes(k));
    if (extra.length) throw new PermissionError(`Team members can update status and progress only (tried: ${extra.join(", ")}).`);
  }
  await assertUserInWorkspace(q, actor.workspaceId, patch.ownerUserId, "Owner");
  await assertUserInWorkspace(q, actor.workspaceId, patch.reviewerUserId, "Reviewer");
  const map: Record<string, string> = { title: "title", description: "description", initiativeId: "initiative_id", campaignId: "campaign_id", ownerUserId: "owner_user_id", reviewerUserId: "reviewer_user_id",
    priority: "priority", status: "status", progress: "progress", startDate: "start_date", dueDate: "due_date", effortHours: "effort_hours" };
  const sets: string[] = [];
  const params: unknown[] = [taskId];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    params.push(v);
    sets.push(`${map[k]} = $${params.length}`);
  }
  if (patch.status === "done" && patch.progress === undefined) sets.push("progress = 100");
  if (!sets.length) return taskId;
  sets.push("updated_at = now()");
  const after = denyIfEmpty(await q<Record<string, unknown>>(`update tasks set ${sets.join(", ")} where id = $1 returning *`, params).catch(rlsToPermission), "task");
  await audit(q, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "update", entity: "task", entityId: taskId, before: pick(before, Object.values(map)), after: pick(after, Object.values(map)), reason: reason ?? null });
  await bumpVersion(q, actor.workspaceId);
  return taskId;
}
export function updateTask(actor: Actor, taskId: string, raw: unknown) {
  return withUser(actor, (q) => applyTaskPatch(q, actor, taskId, raw));
}

export async function addTaskComment(actor: Actor, taskId: string, body: string) {
  const text = z.string().trim().min(1).max(2000).parse(body);
  return withUser(actor, async (q) => {
    const [t] = await q("select 1 from tasks where id = $1", [taskId]);
    if (!t) throw new ValidationError("Task not found.");
    await q("insert into task_comments (workspace_id, task_id, user_id, body) values ($1,$2,$3,$4)", [actor.workspaceId, taskId, actor.userId, text]).catch(rlsToPermission);
    await audit(q, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "comment", entity: "task", entityId: taskId, after: { body: text } });
    await bumpVersion(q, actor.workspaceId);
  });
}

export async function setTaskDependency(actor: Actor, taskId: string, dependsOnId: string, add: boolean) {
  return withUser(actor, async (q) => {
    if (add) {
      if (taskId === dependsOnId) throw new ValidationError("A task cannot depend on itself.");
      const cycle = await q(`with recursive up(id) as (select $2::uuid union select td.depends_on_id from task_dependencies td join up on td.task_id = up.id) select 1 from up where id = $1`, [taskId, dependsOnId]);
      if (cycle.length) throw new ValidationError("That dependency would create a cycle.");
      await q("insert into task_dependencies (task_id, depends_on_id, workspace_id) values ($1,$2,$3) on conflict do nothing", [taskId, dependsOnId, actor.workspaceId]).catch(rlsToPermission);
    } else {
      await q("delete from task_dependencies where task_id = $1 and depends_on_id = $2", [taskId, dependsOnId]).catch(rlsToPermission);
    }
    await audit(q, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: add ? "add_dependency" : "remove_dependency", entity: "task", entityId: taskId, after: { dependsOnId } });
    await bumpVersion(q, actor.workspaceId);
  });
}

// ---- Campaigns --------------------------------------------------------------------------------------------
export const campaignPatch = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  status: z.enum(["planned", "active", "paused", "completed", "cancelled"]).optional(),
  initiativeId: z.string().uuid().nullable().optional(),
  ownerTeamMemberId: z.string().uuid().nullable().optional(),
  budgetApprovedInr: z.coerce.number().int().min(0).nullable().optional(),
  budgetCommittedInr: z.coerce.number().int().min(0).nullable().optional(),
  utmCode: z.string().max(120).nullable().optional(),
  kpiRegistrations: z.coerce.number().int().min(0).nullable().optional(),
  kpiAttendees: z.coerce.number().int().min(0).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});
export async function applyCampaignPatch(q: Q, actor: Actor, campaignId: string, raw: unknown, reason?: string | null) {
  if (actor.role === "team_member") throw new PermissionError("Team members cannot edit campaigns.");
  const patch = campaignPatch.parse(raw);
  const map: Record<string, string> = { name: "name", status: "status", initiativeId: "initiative_id", ownerTeamMemberId: "owner_team_member_id", budgetApprovedInr: "budget_approved_inr",
    budgetCommittedInr: "budget_committed_inr", utmCode: "utm_code", kpiRegistrations: "kpi_registrations", kpiAttendees: "kpi_attendees", notes: "notes" };
  if (actor.role === "campaign_manager" && (patch.budgetApprovedInr !== undefined || patch.initiativeId !== undefined)) {
    throw new PermissionError("Campaign managers request budget or initiative changes through an approval.");
  }
  const [before] = await q<Record<string, unknown>>("select * from campaigns where id = $1", [campaignId]);
  if (!before) throw new ValidationError("Campaign not found.");
  const sets: string[] = [];
  const params: unknown[] = [campaignId];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    params.push(v);
    sets.push(`${map[k]} = $${params.length}`);
  }
  if (!sets.length) return campaignId;
  sets.push("updated_at = now()");
  const after = denyIfEmpty(await q<Record<string, unknown>>(`update campaigns set ${sets.join(", ")} where id = $1 returning *`, params).catch(rlsToPermission), "campaign");
  await audit(q, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "update", entity: "campaign", entityId: campaignId, before: pick(before, Object.values(map)), after: pick(after, Object.values(map)), reason: reason ?? null });
  await bumpVersion(q, actor.workspaceId);
  return campaignId;
}
export function updateCampaign(actor: Actor, campaignId: string, raw: unknown) {
  return withUser(actor, (q) => applyCampaignPatch(q, actor, campaignId, raw));
}

// ---- Registrations and check-ins (data corrections) ----------------------------------------------------------
export async function setRegistrationStatus(actor: Actor, registrationId: string, status: string, reason: string) {
  const s = z.enum(["interested", "confirmed", "cancelled", "waitlisted"]).parse(status);
  const why = z.string().trim().min(3, "Give a reason for the correction").parse(reason);
  return withUser(actor, async (q) => {
    const [r] = await q<{ dataset_version_id: string; source_id: string; current: string | null }>(
      `select r.dataset_version_id, r.source_id, (select h.status from registration_status_history h where h.registration_id = r.id order by h.effective_at desc, h.source_id desc limit 1) current
       from registrations r where r.id = $1`, [registrationId]);
    if (!r) throw new ValidationError("Registration not found.");
    const sid = `APP-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await q(`insert into registration_status_history (workspace_id, dataset_version_id, source_id, registration_id, status, effective_at, edited_by) values ($1,$2,$3,$4,$5, now(), $6)`,
      [actor.workspaceId, r.dataset_version_id, sid, registrationId, s, actor.userId]).catch(rlsToPermission);
    await audit(q, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "status_change", entity: "registration", entityId: r.source_id, before: { status: r.current }, after: { status: s }, reason: why });
    await bumpVersion(q, actor.workspaceId);
  });
}

export async function setCheckInVerification(actor: Actor, checkInId: number, verification: "verified" | "unverified", reason: string) {
  const why = z.string().trim().min(3, "Give a reason for the correction").parse(reason);
  return withUser(actor, async (q) => {
    const [before] = await q<{ source_id: string; verification: string | null }>("select source_id, verification from check_ins where id = $1", [checkInId]);
    if (!before) throw new ValidationError("Check-in not found.");
    denyIfEmpty(await q("update check_ins set verification = $2 where id = $1 returning id", [checkInId, verification]).catch(rlsToPermission), "check-in");
    await audit(q, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "verification_change", entity: "check_in", entityId: before.source_id, before: { verification: before.verification }, after: { verification }, reason: why });
    await bumpVersion(q, actor.workspaceId);
  });
}

// ---- Initiatives, budget, strategy ---------------------------------------------------------------------------
export const initiativePatch = z.object({
  status: z.enum(["not_started", "pilot", "scale", "change", "stop"]).optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  baseTarget: z.coerce.number().int().min(0).optional(),
  stretchTarget: z.coerce.number().int().min(0).optional(),
});
export function updateInitiative(actor: Actor, id: string, raw: unknown) {
  const patch = initiativePatch.parse(raw);
  if (actor.role === "team_member") throw new PermissionError("Team members cannot edit initiatives.");
  if (actor.role !== "admin" && (patch.baseTarget !== undefined || patch.stretchTarget !== undefined)) throw new PermissionError("Only admins change planning targets.");
  return withUser(actor, async (q) => {
    const map: Record<string, string> = { status: "status", ownerUserId: "owner_user_id", notes: "notes", baseTarget: "base_target", stretchTarget: "stretch_target" };
    const [before] = await q<Record<string, unknown>>("select * from initiatives where id = $1", [id]);
    if (!before) throw new ValidationError("Initiative not found.");
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      params.push(v);
      sets.push(`${map[k]} = $${params.length}`);
    }
    if (!sets.length) return;
    sets.push("updated_at = now()");
    const after = denyIfEmpty(await q<Record<string, unknown>>(`update initiatives set ${sets.join(", ")} where id = $1 returning *`, params).catch(rlsToPermission), "initiative");
    await audit(q, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "update", entity: "initiative", entityId: id, before: pick(before, Object.values(map)), after: pick(after, Object.values(map)) });
    await bumpVersion(q, actor.workspaceId);
  });
}

export const budgetPatch = z.object({
  approvedInr: z.coerce.number().int().min(0).optional(),
  committedInr: z.coerce.number().int().min(0).optional(),
  spentInr: z.coerce.number().int().min(0).optional(),
  fundingSource: z.enum(["festival", "sponsor"]).optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export async function applyBudgetPatch(q: Q, actor: Actor, lineId: string, raw: unknown, reason?: string | null) {
  if (actor.role !== "admin") throw new PermissionError("Only admins change budget lines. Managers can propose a change for approval.");
  const patch = budgetPatch.parse(raw);
  const map: Record<string, string> = { approvedInr: "approved_inr", committedInr: "committed_inr", spentInr: "spent_inr", fundingSource: "funding_source", notes: "notes" };
  const [before] = await q<Record<string, unknown>>("select * from budget_lines where id = $1", [lineId]);
  if (!before) throw new ValidationError("Budget line not found.");
  const sets: string[] = [];
  const params: unknown[] = [lineId];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    params.push(v);
    sets.push(`${map[k]} = $${params.length}`);
  }
  if (!sets.length) return;
  sets.push("updated_at = now()");
  const after = denyIfEmpty(await q<Record<string, unknown>>(`update budget_lines set ${sets.join(", ")} where id = $1 returning *`, params).catch(rlsToPermission), "budget line");
  await audit(q, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "update", entity: "budget_line", entityId: lineId, before: pick(before, Object.values(map)), after: pick(after, Object.values(map)), reason: reason ?? null });
  await bumpVersion(q, actor.workspaceId);
}
export function updateBudgetLine(actor: Actor, lineId: string, raw: unknown) {
  return withUser(actor, (q) => applyBudgetPatch(q, actor, lineId, raw));
}

export function saveStrategyConfig(actor: Actor, config: StrategyConfig, note: string) {
  if (actor.role !== "admin") throw new PermissionError("Only admins change Strategy & Targets.");
  const merged = { ...DEFAULT_STRATEGY, ...config };
  if (merged.capacity.dailyLimit !== null && merged.capacity.dailyLimit <= 0) throw new ValidationError("Daily capacity must be positive.");
  return withUser(actor, async (q) => {
    const [cur] = await q<{ v: number | null; config: StrategyConfig | null }>("select max(version) v, (array_agg(config order by version desc))[1] config from strategy_configs where workspace_id = $1", [actor.workspaceId]);
    const version = (cur?.v ?? 0) + 1;
    await q("insert into strategy_configs (workspace_id, version, config, change_note, created_by) values ($1,$2,$3,$4,$5)", [actor.workspaceId, version, JSON.stringify(merged), note || null, actor.userId]).catch(rlsToPermission);
    await audit(q, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "new_version", entity: "strategy_config", entityId: String(version), before: cur?.config ?? null, after: merged, reason: note || null });
    await bumpVersion(q, actor.workspaceId);
    return version;
  });
}

export function setActiveDataset(actor: Actor, datasetVersionId: string) {
  if (actor.role !== "admin") throw new PermissionError("Only admins switch the active dataset.");
  return withUser(actor, async (q) => {
    const [dv] = await q<{ status: string; label: string }>("select status, label from dataset_versions where id = $1", [datasetVersionId]);
    if (!dv) throw new ValidationError("Dataset version not found.");
    if (dv.status !== "ready") throw new ValidationError("Only a dataset version that finished importing can be activated.");
    const [before] = await q<{ active_dataset_version_id: string | null }>("select active_dataset_version_id from workspaces where id = $1", [actor.workspaceId]);
    denyIfEmpty(await q("update workspaces set active_dataset_version_id = $2 where id = $1 returning id", [actor.workspaceId, datasetVersionId]).catch(rlsToPermission), "workspace");
    await audit(q, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "activate_dataset", entity: "dataset_version", entityId: datasetVersionId, before, after: { label: dv.label } });
    await bumpVersion(q, actor.workspaceId);
  });
}

function pick(o: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
}
