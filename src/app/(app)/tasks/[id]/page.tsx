import { cachedPage } from "@/lib/cache";
import Link from "next/link";
import { notFound } from "next/navigation";
import { pageData } from "@/lib/page";
import { listTasks } from "@/lib/analytics/management";
import { Badge, Card, Notice, PageHeader, btn, btnPrimary, input, label } from "@/components/ui";
import { ActionForm } from "@/components/client";
import { commentAction, dependencyAction, updateTaskAction } from "@/app/actions";
import { fmtDate, fmtDateTime, STATUS_LABEL } from "@/lib/format";

export default async function TaskPage({ params }: PageProps<"/tasks/[id]">) {
  const { id } = await params;
  const { s, data } = await cachedPage(["tasks/[id]", id], () => pageData(undefined, async (q, ctx, s) => {
    const all = await listTasks(q, s.workspaceId);
    const t = all.find((x) => x.id === id);
    if (!t) return null;
    return {
      t, all,
      deps: await q<{ id: string; title: string; status: string }>("select d.id, d.title, d.status from task_dependencies td join tasks d on d.id = td.depends_on_id where td.task_id = $1", [id]),
      blocks: await q<{ id: string; title: string }>("select t.id, t.title from task_dependencies td join tasks t on t.id = td.task_id where td.depends_on_id = $1", [id]),
      comments: await q<{ body: string; created_at: Date; name: string | null }>("select c.body, c.created_at, u.display_name name from task_comments c left join app_users u on u.id = c.user_id where c.task_id = $1 order by c.created_at", [id]),
      history: await q<{ action: string; actor_kind: string; name: string | null; before: unknown; after: unknown; reason: string | null; created_at: Date }>(
        "select a.action, a.actor_kind, u.display_name name, a.before, a.after, a.reason, a.created_at from audit_logs a left join app_users u on u.id = a.actor_user_id where a.entity = 'task' and a.entity_id = $1 order by a.id desc limit 30", [id]),
      users: await q<{ id: string; display_name: string }>("select id, display_name from app_users where workspace_id = $1 order by display_name", [s.workspaceId]),
      initiatives: await q<{ id: string; name: string }>("select id, name from initiatives where workspace_id = $1 order by name", [s.workspaceId]),
      campaigns: ctx ? await q<{ id: string; name: string }>("select id, name from campaigns where dataset_version_id = $1 order by name", [ctx.dv]) : [],
    };
  }));
  if (!data) notFound();
  const { t } = data;
  const isMember = s.role === "team_member";
  const canEditAll = !isMember;
  const ownTask = t.ownerId === s.userId;
  return (
    <>
      <PageHeader title={t.title}
        subtitle={<>{t.initiativeName ?? "No initiative"}{t.campaignName && <> · campaign <b>{t.campaignName}</b></>} · created via {t.origin === "ai" ? "approved AI draft" : t.origin === "seed" ? "demo seed" : "the app"}</>}
        actions={<Link href="/tasks" className={btn}>← All tasks</Link>} />
      {t.overdue && <div className="mb-4"><Notice kind="bad">Overdue since {fmtDate(t.dueDate)}.</Notice></div>}
      {t.blockedBy.length > 0 && <div className="mb-4"><Notice kind="warn">Waiting on: {t.blockedBy.map((b) => `${b.title} (${STATUS_LABEL[b.status]})`).join(", ")}</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Details">
            {isMember && !ownTask && <Notice kind="info">You can view this task. Only its owner, a manager or an admin can change it.</Notice>}
            {isMember && ownTask && <Notice kind="info">As the owner you can update status and progress.</Notice>}
            <ActionForm action={updateTaskAction} className="mt-2 grid gap-3 md:grid-cols-2">
              <input type="hidden" name="taskId" value={t.id} />
              {canEditAll && <div className="md:col-span-2"><label className={label}>Title</label><input name="title" defaultValue={t.title} className={input} /></div>}
              <div><label className={label}>Status</label><select name="status" defaultValue={t.status} className={input} disabled={isMember && !ownTask}>{Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
              <div><label className={label}>Progress (%)</label><input name="progress" type="number" min={0} max={100} defaultValue={t.progress} className={input} disabled={isMember && !ownTask} /></div>
              {canEditAll && <>
                <div><label className={label}>Owner</label><select name="ownerUserId" defaultValue={t.ownerId ?? ""} className={input}><option value="">Unassigned</option>{data.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></div>
                <div><label className={label}>Reviewer</label><select name="reviewerUserId" defaultValue={t.reviewerId ?? ""} className={input}><option value="">None</option>{data.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></div>
                <div><label className={label}>Priority</label><select name="priority" defaultValue={t.priority} className={input}>{["low", "medium", "high", "critical"].map((p) => <option key={p}>{p}</option>)}</select></div>
                <div><label className={label}>Effort (hours)</label><input name="effortHours" type="number" min={0} step="0.5" defaultValue={t.effortHours ?? ""} className={input} /></div>
                <div><label className={label}>Start</label><input name="startDate" type="date" defaultValue={t.startDate ?? ""} className={input} /></div>
                <div><label className={label}>Deadline</label><input name="dueDate" type="date" defaultValue={t.dueDate ?? ""} className={input} /></div>
                <div><label className={label}>Initiative</label><select name="initiativeId" defaultValue={t.initiativeId ?? ""} className={input}><option value="">None</option>{data.initiatives.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
                <div><label className={label}>Campaign</label><select name="campaignId" defaultValue={t.campaignId ?? ""} className={input}><option value="">None</option>{data.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
                <div className="md:col-span-2"><label className={label}>Description</label><textarea name="description" rows={3} defaultValue={t.description ?? ""} className={input} /></div>
              </>}
              {(!isMember || ownTask) && <div><button className={btnPrimary}>Save</button></div>}
            </ActionForm>
          </Card>
          <Card title="Comments and evidence">
            <ul className="mb-3 space-y-2">
              {data.comments.map((c, i) => <li key={i} className="rounded-lg bg-[#f4f6fa] p-2 text-sm"><span className="text-xs text-muted">{c.name ?? "Someone"} · {fmtDateTime(c.created_at)}</span><p className="whitespace-pre-wrap">{c.body}</p></li>)}
              {data.comments.length === 0 && <li className="text-sm text-muted">No comments yet.</li>}
            </ul>
            <ActionForm action={commentAction} resetOnSuccess success="Comment added">
              <input type="hidden" name="taskId" value={t.id} />
              <textarea name="body" required rows={2} placeholder="Add progress, a link to evidence or a question" className={input} />
              <button className={`${btn} mt-2`}>Comment</button>
            </ActionForm>
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Dependencies">
            <p className="mb-1 text-xs text-muted">This task waits on:</p>
            <ul className="space-y-1 text-sm">
              {data.deps.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2">
                  <Link href={`/tasks/${d.id}`} className="text-brand">{d.title}</Link>
                  <span className="flex items-center gap-1"><Badge kind={d.status === "done" ? "healthy" : "attention"}>{STATUS_LABEL[d.status]}</Badge>
                    {canEditAll && <ActionForm action={dependencyAction} success="Removed"><input type="hidden" name="taskId" value={t.id} /><input type="hidden" name="dependsOnId" value={d.id} /><input type="hidden" name="op" value="remove" /><button className="text-xs text-bad" aria-label={`Remove dependency on ${d.title}`}>✕</button></ActionForm>}</span>
                </li>
              ))}
              {data.deps.length === 0 && <li className="text-muted">Nothing</li>}
            </ul>
            {data.blocks.length > 0 && <><p className="mb-1 mt-3 text-xs text-muted">Blocks:</p><ul className="text-sm">{data.blocks.map((b) => <li key={b.id}><Link href={`/tasks/${b.id}`} className="text-brand">{b.title}</Link></li>)}</ul></>}
            {canEditAll && (
              <ActionForm action={dependencyAction} className="mt-3 flex gap-2" success="Dependency added">
                <input type="hidden" name="taskId" value={t.id} />
                <select name="dependsOnId" className={input} aria-label="Add a dependency">{data.all.filter((x) => x.id !== t.id).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select>
                <button className={btn}>Add</button>
              </ActionForm>
            )}
          </Card>
          <Card title="Activity">
            <ul className="space-y-2 text-xs">
              {data.history.map((h, i) => (
                <li key={i} className="border-l-2 border-line pl-2">
                  <span className="font-medium text-ink">{h.name ?? h.actor_kind}</span> {h.action} · {fmtDateTime(h.created_at)}
                  {h.reason && <div className="text-muted">{h.reason}</div>}
                  {h.action === "update" && h.before && h.after ? <div className="text-muted">{diff(h.before as Record<string, unknown>, h.after as Record<string, unknown>)}</div> : null}
                </li>
              ))}
              {data.history.length === 0 && <li className="text-muted">No changes recorded yet (seeded tasks start without history).</li>}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

function diff(b: Record<string, unknown>, a: Record<string, unknown>) {
  return Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]) && k !== "updated_at").map((k) => `${k}: ${fmtVal(b[k])} → ${fmtVal(a[k])}`).join("; ");
}
function fmtVal(v: unknown) {
  if (v === null || v === undefined) return "–";
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s.length > 40 ? s.slice(0, 40) + "…" : s;
}
