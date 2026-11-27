"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import type { ApprovalView } from "@/lib/approvals-view";

const KIND: Record<string, string> = { create_task: "Create task", update_task: "Change task", update_campaign: "Change campaign", budget_change: "Change budget line" };

export function ApprovalCard({ a, users, canDecide, decide }: {
  a: ApprovalView;
  users: { id: string; name: string }[];
  canDecide: boolean;
  decide: (fd: FormData) => Promise<{ ok: boolean; error?: string; message?: string; id?: string }>;
}) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [status, setStatus] = useState(a.status);
  const editable = a.kind === "create_task" && status === "pending" && canDecide;
  const submit = (decision: "approve" | "reject", form: HTMLFormElement) => {
    const fd = new FormData(form);
    fd.set("approvalId", a.id);
    fd.set("decision", decision);
    start(async () => {
      const r = await decide(fd);
      if (r.ok) { setStatus(decision === "approve" ? "approved" : "rejected"); setMsg({ ok: true, text: r.message ?? "Done" }); }
      else setMsg({ ok: false, text: r.error ?? "Failed" });
    });
  };
  return (
    <div className="rounded-xl border border-brand/30 bg-white p-4 text-sm shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-ink">{KIND[a.kind] ?? a.kind}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status === "pending" ? "bg-warn-soft text-warn" : status === "approved" ? "bg-good-soft text-good" : "bg-[#f1f3f6] text-muted"}`}>{status === "pending" ? "Waiting for approval" : status}</span>
      </div>
      <p className="mt-1 text-xs text-muted">Proposed by {a.proposedBy} · {new Date(a.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</p>
      {a.rationale && <p className="mt-2 text-ink-2"><span className="text-xs font-medium uppercase text-muted">Why: </span>{a.rationale}</p>}
      <table className="mt-3 w-full text-xs">
        <thead><tr className="text-left text-muted"><th className="py-1 pr-2 font-medium">Field</th>{a.kind !== "create_task" && <th className="pr-2 font-medium">Before</th>}<th className="font-medium">{a.kind === "create_task" ? "Value" : "After"}</th></tr></thead>
        <tbody>{a.changes.map((c) => <tr key={c.field} className="border-t border-line"><td className="py-1 pr-2 text-muted">{c.field}</td>{a.kind !== "create_task" && <td className="pr-2">{c.before ?? "–"}</td>}<td className="font-medium">{c.after ?? "–"}</td></tr>)}</tbody>
      </table>
      {status === "pending" && canDecide && (
        <form className="mt-3 space-y-2" onSubmit={(e) => e.preventDefault()}>
          {editable && (
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-muted">Owner
                <select name="ownerUserId" defaultValue={String(a.draft.ownerUserId ?? "")} className="mt-0.5 w-full rounded border border-line px-1 py-1 text-xs text-ink">
                  <option value="">Unassigned</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select></label>
              <label className="text-xs text-muted">Deadline
                <input type="date" name="dueDate" defaultValue={String(a.draft.dueDate ?? "")} className="mt-0.5 w-full rounded border border-line px-1 py-1 text-xs text-ink" /></label>
            </div>
          )}
          <input name="note" placeholder="Note (optional)" className="w-full rounded border border-line px-2 py-1 text-xs" />
          <div className="flex gap-2">
            <button type="button" disabled={pending} onClick={(e) => submit("approve", e.currentTarget.form!)} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Approve{editable ? " (with edits)" : ""}</button>
            <button type="button" disabled={pending} onClick={(e) => submit("reject", e.currentTarget.form!)} className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium">Reject</button>
          </div>
        </form>
      )}
      {status === "pending" && !canDecide && <p className="mt-3 text-xs text-muted">An admin or campaign manager must approve this.</p>}
      {msg && <p className={`mt-2 text-xs ${msg.ok ? "text-good" : "text-bad"}`}>{msg.text}</p>}
      {(status === "approved" && (a.resultEntityId || msg?.ok) && a.kind.includes("task")) && <Link href="/tasks" className="mt-2 inline-block text-xs text-brand">See it in Tasks →</Link>}
      {a.decidedBy && <p className="mt-2 text-xs text-muted">Decided by {a.decidedBy}{a.decisionNote ? `: ${a.decisionNote}` : ""}</p>}
    </div>
  );
}
