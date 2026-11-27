import { cachedPage } from "@/lib/cache";
import { pageData } from "@/lib/page";
import { loadApprovals } from "@/lib/approvals-view";
import { Card, Empty, PageHeader } from "@/components/ui";
import { ApprovalCard } from "@/components/approval-card";
import { decideAction } from "@/app/actions";

export default async function ApprovalsPage() {
  const { s, data } = await cachedPage(["approvals"], () => pageData(undefined, async (q, _ctx, s) => ({
    pending: await loadApprovals(q, s.workspaceId, { status: "pending" }),
    decided: await loadApprovals(q, s.workspaceId, { status: "decided" }),
    users: await q<{ id: string; name: string }>("select id, display_name name from app_users where workspace_id = $1 order by display_name", [s.workspaceId]),
  })));
  const canDecide = s.role !== "team_member";
  return (
    <>
      <PageHeader title="Approvals" subtitle="Every change the AI analyst proposes, and every budget request from a manager, waits here until an authorised person approves it. Approving applies the change and writes an audit record; rejecting creates nothing." />
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Pending ({data.pending.length})</h2>
      {data.pending.length === 0 ? <Empty>Nothing is waiting for approval.</Empty> : (
        <div className="grid gap-3 md:grid-cols-2">{data.pending.map((a) => <ApprovalCard key={a.id} a={a} users={data.users} canDecide={canDecide} decide={decideAction} />)}</div>
      )}
      <h2 className="mb-2 mt-8 text-xs font-semibold uppercase tracking-wide text-muted">Decided</h2>
      <Card>
        {data.decided.length === 0 ? <p className="text-sm text-muted">No decisions yet.</p> : (
          <ul className="divide-y divide-line text-sm">
            {data.decided.map((a) => (
              <li key={a.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span><b className="capitalize">{a.status}</b> · {a.kind.replace("_", " ")} · {a.changes.find((c) => c.field === "title")?.after ?? a.changes.map((c) => c.field).join(", ")}</span>
                <span className="text-xs text-muted">{a.proposedBy} → {a.decidedBy} · {new Date(a.decidedAt ?? a.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
