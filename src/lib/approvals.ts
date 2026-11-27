// Proposals (from the AI or a person) become real changes only when an authorised human approves.
import { z } from "zod";
import { audit, bumpVersion, withUser, type Actor, type Q } from "./db";
import { applyBudgetPatch, applyCampaignPatch, applyTaskPatch, budgetPatch, campaignPatch, insertTask, PermissionError, taskInput, taskPatch, ValidationError } from "./services";

export const proposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create_task"), payload: taskInput }),
  z.object({ kind: z.literal("update_task"), payload: z.object({ taskId: z.string().uuid(), changes: taskPatch.pick({ ownerUserId: true, dueDate: true, status: true, priority: true, reviewerUserId: true }) }) }),
  z.object({ kind: z.literal("update_campaign"), payload: z.object({ campaignId: z.string().uuid(), changes: campaignPatch.pick({ status: true, ownerTeamMemberId: true, budgetApprovedInr: true, notes: true }) }) }),
  z.object({ kind: z.literal("budget_change"), payload: z.object({ budgetLineId: z.string().uuid(), changes: budgetPatch.pick({ approvedInr: true, committedInr: true }) }) }),
]);
export type Proposal = z.infer<typeof proposalSchema>;

async function snapshotBefore(q: Q, p: Proposal) {
  switch (p.kind) {
    case "create_task": return null;
    case "update_task": {
      const [t] = await q("select id, title, owner_user_id, due_date::text, status, priority, reviewer_user_id from tasks where id = $1", [p.payload.taskId]);
      if (!t) throw new ValidationError("The task in this proposal does not exist.");
      return t;
    }
    case "update_campaign": {
      const [c] = await q("select id, name, status, owner_team_member_id, budget_approved_inr, notes from campaigns where id = $1", [p.payload.campaignId]);
      if (!c) throw new ValidationError("The campaign in this proposal does not exist.");
      return c;
    }
    case "budget_change": {
      const [b] = await q("select id, label, scenario, approved_inr, committed_inr from budget_lines where id = $1", [p.payload.budgetLineId]);
      if (!b) throw new ValidationError("The budget line in this proposal does not exist.");
      return b;
    }
  }
}

/** Stores a pending proposal. Nothing is changed until approval. */
export async function propose(q: Q, actor: Actor, raw: unknown, meta: { by: "ai" | "user"; rationale: string; evidence?: unknown; threadId?: string | null }) {
  const p = proposalSchema.parse(raw);
  if (p.kind === "create_task") {
    for (const [label, id] of [["Owner", p.payload.ownerUserId], ["Reviewer", p.payload.reviewerUserId]] as const) {
      if (id && !(await q("select 1 from app_users where id = $1", [id])).length) throw new ValidationError(`${label} is not a member of this workspace.`);
    }
  }
  const before = await snapshotBefore(q, p);
  const [row] = await q<{ id: string }>(
    `insert into approvals (workspace_id, kind, payload, before, rationale, evidence, proposed_by_kind, requested_by, thread_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [actor.workspaceId, p.kind, JSON.stringify(p.payload), before ? JSON.stringify(before) : null, meta.rationale, meta.evidence ? JSON.stringify(meta.evidence) : null, meta.by, actor.userId, meta.threadId ?? null]);
  await audit(q, { workspaceId: actor.workspaceId, actorUserId: actor.userId, actorKind: meta.by === "ai" ? "ai" : "user", action: "propose", entity: "approval", entityId: row.id, after: p, reason: meta.rationale });
  await bumpVersion(q, actor.workspaceId);
  return { approvalId: row.id, before };
}

export async function decide(actor: Actor, approvalId: string, decision: "approve" | "reject", opts: { note?: string; edits?: Record<string, unknown> } = {}) {
  if (actor.role === "team_member") throw new PermissionError("Team members cannot approve proposals.");
  return withUser(actor, async (q) => {
    const [a] = await q<{ id: string; kind: Proposal["kind"]; status: string; payload: Record<string, unknown>; requested_by: string | null; proposed_by_kind: string }>(
      "select id, kind, status, payload, requested_by, proposed_by_kind from approvals where id = $1", [approvalId]);
    if (!a) throw new ValidationError("Approval not found.");
    if (a.status !== "pending") throw new ValidationError(`This proposal was already ${a.status}.`);
    if (a.kind === "budget_change" && actor.role !== "admin") throw new PermissionError("Only an admin can decide budget changes.");
    // Claim the proposal first so two people cannot decide it at the same time.
    const claimed = await q("update approvals set decided_by = $2 where id = $1 and status = 'pending' returning id", [approvalId, actor.userId]);
    if (!claimed.length) throw new ValidationError("This proposal was already decided.");

    if (decision === "reject") {
      await q("update approvals set status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1", [approvalId, actor.userId, opts.note ?? null]);
      await audit(q, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "reject", entity: "approval", entityId: approvalId, reason: opts.note ?? null });
      await bumpVersion(q, actor.workspaceId);
      return { status: "rejected" as const, resultId: null };
    }

    if (a.kind === "budget_change" && a.proposed_by_kind === "user" && a.requested_by === actor.userId) throw new PermissionError("You cannot approve a budget change you requested yourself.");
    // The approver may edit the proposal (e.g. owner or deadline) before approving.
    const payload = opts.edits && a.kind === "create_task" ? { ...a.payload, ...opts.edits } : a.payload;
    const p = proposalSchema.parse({ kind: a.kind, payload });
    let resultId: string | null = null;
    const why = `Approved proposal ${approvalId}${opts.note ? `: ${opts.note}` : ""}`;
    if (p.kind === "create_task") resultId = await insertTask(q, actor, p.payload, a.proposed_by_kind === "ai" ? "ai" : "user", approvalId);
    else if (p.kind === "update_task") resultId = await applyTaskPatch(q, actor, p.payload.taskId, p.payload.changes, why);
    else if (p.kind === "update_campaign") resultId = await applyCampaignPatch(q, { ...actor }, p.payload.campaignId, p.payload.changes, why);
    else if (p.kind === "budget_change") { await applyBudgetPatch(q, actor, p.payload.budgetLineId, p.payload.changes, why); resultId = p.payload.budgetLineId; }

    await q("update approvals set status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3, payload = $4, result_entity_id = $5 where id = $1",
      [approvalId, actor.userId, opts.note ?? null, JSON.stringify(p.payload), resultId]);
    await audit(q, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: "approve", entity: "approval", entityId: approvalId, after: { kind: a.kind, resultId, edited: !!opts.edits }, reason: opts.note ?? null });
    await bumpVersion(q, actor.workspaceId);
    return { status: "approved" as const, resultId };
  });
}
