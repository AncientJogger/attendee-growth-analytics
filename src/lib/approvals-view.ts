import type { Q } from "./db";

export interface ApprovalView {
  id: string; kind: string; status: string; rationale: string | null; proposedBy: string; requestedBy: string | null; decidedBy: string | null;
  decisionNote: string | null; createdAt: string; decidedAt: string | null; resultEntityId: string | null;
  changes: { field: string; before: string | null; after: string | null }[];
  draft: Record<string, unknown>;
}

/** Loads approvals with human-readable before/after rows (names instead of IDs). */
export async function loadApprovals(q: Q, ws: string, opts: { ids?: string[]; status?: "pending" | "decided" } = {}): Promise<ApprovalView[]> {
  const params: unknown[] = [ws];
  let where = "a.workspace_id = $1";
  if (opts.ids?.length) { params.push(opts.ids); where += ` and a.id = any($${params.length}::uuid[])`; }
  if (opts.status === "pending") where += " and a.status = 'pending'";
  if (opts.status === "decided") where += " and a.status <> 'pending'";
  const rows = await q<Record<string, unknown>>(
    `select a.*, r.display_name requested_name, d.display_name decided_name from approvals a left join app_users r on r.id = a.requested_by left join app_users d on d.id = a.decided_by
     where ${where} order by a.created_at desc limit 100`, params);
  const users = new Map((await q<{ id: string; display_name: string }>("select id, display_name from app_users where workspace_id = $1", [ws])).map((u) => [u.id, u.display_name]));
  const names = new Map<string, string>();
  for (const t of ["initiatives", "campaigns", "team_members"]) {
    (await q<{ id: string; name: string }>(`select id, name from ${t} where workspace_id = $1`, [ws])).forEach((x) => names.set(x.id, x.name));
  }
  const label = (k: string, v: unknown): string | null => {
    if (v === null || v === undefined || v === "") return null;
    if (/UserId$|^owner_user_id$|^reviewer_user_id$/.test(k)) return users.get(String(v)) ?? String(v);
    if (/initiativeId|campaignId|TeamMemberId|initiative_id|owner_team_member_id/.test(k)) return names.get(String(v)) ?? String(v);
    if (/Inr$|_inr$/.test(k)) return `₹${Number(v).toLocaleString("en-IN")}`;
    return String(v);
  };
  const beforeKey: Record<string, string> = { ownerUserId: "owner_user_id", dueDate: "due_date", status: "status", priority: "priority", reviewerUserId: "reviewer_user_id", ownerTeamMemberId: "owner_team_member_id",
    budgetApprovedInr: "budget_approved_inr", notes: "notes", approvedInr: "approved_inr", committedInr: "committed_inr" };
  return rows.map((a) => {
    const p = a.payload as Record<string, unknown>;
    const before = (a.before ?? {}) as Record<string, unknown>;
    const changesObj = (a.kind === "create_task" ? p : (p.changes as Record<string, unknown>)) ?? {};
    const changes = Object.entries(changesObj).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(a.kind === "create_task" && ["status", "progress"].includes(String(v))))
      .map(([k, v]) => ({ field: k, before: a.kind === "create_task" ? null : label(k, before[beforeKey[k] ?? k]), after: label(k, v) }));
    return {
      id: String(a.id), kind: String(a.kind), status: String(a.status), rationale: (a.rationale as string) ?? null,
      proposedBy: a.proposed_by_kind === "ai" ? `AI analyst (asked by ${a.requested_name ?? "unknown"})` : String(a.requested_name ?? "unknown"),
      requestedBy: (a.requested_by as string) ?? null, decidedBy: (a.decided_name as string) ?? null, decisionNote: (a.decision_note as string) ?? null,
      createdAt: new Date(a.created_at as string).toISOString(), decidedAt: a.decided_at ? new Date(a.decided_at as string).toISOString() : null, resultEntityId: (a.result_entity_id as string) ?? null,
      changes, draft: p,
    };
  });
}
