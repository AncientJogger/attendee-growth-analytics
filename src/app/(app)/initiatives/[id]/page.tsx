import { cachedPage } from "@/lib/cache";
import Link from "next/link";
import { notFound } from "next/navigation";
import { pageData } from "@/lib/page";
import { initiativeOverview, listTasks } from "@/lib/analytics/management";
import { Badge, Card, EvidenceTag, Notice, PageHeader, Stat, Table, Td, btn, btnPrimary, input, label } from "@/components/ui";
import { ActionForm } from "@/components/client";
import { updateInitiativeAction } from "@/app/actions";
import { DECISION_LABEL, fmtDate, fmtInr, fmtInt, fmtLakh, fmtPct, STATUS_LABEL } from "@/lib/format";

export default async function InitiativePage({ params, searchParams }: PageProps<"/initiatives/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const { s, data } = await cachedPage(["initiatives/[id]", id, sp], () => pageData(sp.asof, async (q, ctx, s) => {
    const [i] = await initiativeOverview(q, s.workspaceId, ctx, id).catch(() => []);
    if (!i) return null;
    return {
      i, tasks: await listTasks(q, s.workspaceId, { initiativeId: id }),
      users: await q<{ id: string; display_name: string }>("select id, display_name from app_users where workspace_id = $1 order by display_name", [s.workspaceId]),
      team: await q<{ display_name: string; role: string }>("select u.display_name, u.role from initiative_assignments ia join app_users u on u.id = ia.user_id where ia.initiative_id = $1", [id]),
    };
  }));
  if (!data) notFound();
  const { i } = data;
  const canEdit = s.role === "admin" || (s.role === "campaign_manager" && data.team.some((t) => t.display_name === s.name));
  const ask = encodeURIComponent(`How is ${i.name} set up to perform? Summarise its plan, the historical evidence, open and overdue tasks, and what we should do next.`);
  return (
    <>
      <PageHeader title={i.name} subtitle={i.mechanism}
        actions={<><Link className={btn} href={`/analyst?q=${ask}`}>Ask the AI analyst</Link><Link className={btnPrimary} href={`/tasks?new=1&initiativeId=${i.id}`}>New task</Link></>} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Decision" value={<Badge kind="brand">{DECISION_LABEL[i.decision]}</Badge>} sub={`Status: ${i.status.replace("_", " ")}`} />
        <Stat label="Base contribution" tag="assumption" value={`+${fmtInt(i.plan.baseTarget)}`} sub={`Stretch +${fmtInt(i.plan.stretchTarget)}`} />
        <Stat label="Base budget" tag="assumption" value={fmtLakh(i.plan.baseBudget)} sub={`Stretch ${fmtLakh(i.plan.stretchBudget)} · ${fmtInr(i.plan.baseBudget / Math.max(1, i.plan.baseTarget))} per planned attendee`} />
        <Stat label="Open tasks" value={fmtInt(i.tasks.open)} sub={`${i.tasks.overdue} overdue · ${i.tasks.blocked} blocked`} />
        <Stat label="Owner" value={<span className="text-base">{i.ownerName ?? "–"}</span>} sub={data.team.map((t) => t.display_name).join(", ")} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Scale / change / stop rule" note={i.thresholdNote ?? "Verdict computed from recorded experiment results."}>
            {i.threshold ? (
              <>
                <p className="text-sm"><b>{i.threshold.metric}</b></p>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center text-sm">
                  <div className="rounded-lg bg-good-soft p-2 text-good">Scale ≥ {i.threshold.scaleAt}</div>
                  <div className="rounded-lg bg-warn-soft p-2 text-warn">Change {i.threshold.changeFrom}–{i.threshold.scaleAt - 1}</div>
                  <div className="rounded-lg bg-bad-soft p-2 text-bad">Stop &lt; {i.threshold.stopBelow}</div>
                </div>
                {i.threshold.extra && <p className="mt-2 text-xs text-muted">{i.threshold.extra}</p>}
                <p className="mt-3 text-sm">Current verdict: <Badge kind={i.thresholdVerdict}>{i.thresholdVerdict === "insufficient" ? "Insufficient data" : i.thresholdVerdict}</Badge></p>
              </>
            ) : <p className="text-sm text-muted">No threshold configured.</p>}
          </Card>
          <Card title={<span className="flex items-center gap-2">Historical proxy evidence <EvidenceTag tag="observed" /></span>}
            note="A 2025 campaign with a similar mechanism. It is evidence about the mechanism, not a measurement of this initiative.">
            {i.historicalProxy.length === 0 ? <p className="text-sm text-muted">No comparable historical campaign. This initiative has no prior evidence; treat it as a pilot.</p> : (
              <Table head={["Campaign", "Registered", "Verified", "Show-up", "Cost / verified", "Health"]}>
                {i.historicalProxy.map((p) => (
                  <tr key={p.campaign}><Td>{p.campaign}</Td><Td>{fmtInt(p.registered)}</Td><Td>{fmtInt(p.verified)}</Td><Td>{fmtPct(p.showRate)}</Td><Td>{fmtInr(p.costPerVerified)}</Td><Td><Badge kind={p.health}>{p.health}</Badge></Td></tr>
                ))}
              </Table>
            )}
          </Card>
          <Card title="Tasks">
            {data.tasks.length === 0 ? <p className="text-sm text-muted">No tasks yet.</p> : (
              <Table head={["Task", "Owner", "Status", "Due"]}>
                {data.tasks.map((t) => (
                  <tr key={t.id}>
                    <Td><Link href={`/tasks/${t.id}`} className="text-brand hover:underline">{t.title}</Link></Td>
                    <Td>{t.ownerName ?? "–"}</Td>
                    <Td>{STATUS_LABEL[t.status]}</Td>
                    <Td className={t.overdue ? "text-bad" : ""}>{fmtDate(t.dueDate)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <Card title="Experiments">
            {i.experiments.length === 0 ? <p className="text-sm text-muted">None yet. <Link className="text-brand" href="/experiments">Create one</Link>.</p> :
              <ul className="space-y-1 text-sm">{i.experiments.map((e) => <li key={e.id}><Link href="/experiments" className="text-brand">{e.name}</Link> · {e.status}{e.decisionRule && <span className="text-muted"> · {e.decisionRule}</span>}</li>)}</ul>}
          </Card>
        </div>
        <Card title="Update initiative" note="Planning targets can only be changed by an admin. Every change is audited.">
          {!canEdit && <Notice kind="info">Only the assigned manager or an admin can edit this initiative.</Notice>}
          <ActionForm action={updateInitiativeAction} className="mt-2 space-y-3">
            <input type="hidden" name="initiativeId" value={i.id} />
            <div><label className={label}>Status</label>
              <select name="status" defaultValue={i.status} className={input} disabled={!canEdit}>
                {["not_started", "pilot", "scale", "change", "stop"].map((x) => <option key={x} value={x}>{x.replace("_", " ")}</option>)}
              </select></div>
            <div><label className={label}>Owner</label>
              <select name="ownerUserId" defaultValue={i.ownerUserId ?? ""} className={input} disabled={!canEdit}>
                <option value="">Unassigned</option>
                {data.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
              </select></div>
            {s.role === "admin" && (
              <div className="grid grid-cols-2 gap-2">
                <div><label className={label}>Base target</label><input name="baseTarget" type="number" min={0} defaultValue={i.plan.baseTarget} className={input} /></div>
                <div><label className={label}>Stretch target</label><input name="stretchTarget" type="number" min={0} defaultValue={i.plan.stretchTarget} className={input} /></div>
              </div>
            )}
            {canEdit && <button className={btnPrimary}>Save</button>}
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
