import { cachedPage } from "@/lib/cache";
import Link from "next/link";
import { pageData } from "@/lib/page";
import { listTasks, taskMetrics, type TaskRow } from "@/lib/analytics/management";
import { todayIn } from "@/lib/analytics/context";
import { Badge, Card, PageHeader, Stat, Table, Td, btn, btnPrimary, input, inputInline, label } from "@/components/ui";
import { ActionForm, AutoSelect } from "@/components/client";
import { createTaskAction, updateTaskAction } from "@/app/actions";
import { fmtDate, STATUS_LABEL } from "@/lib/format";

const STATUSES = ["backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled"];
const statusOptions = STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }));
const PRIO: Record<string, string> = { critical: "critical", high: "attention", medium: "neutral", low: "neutral" };

function TaskMeta({ t }: { t: TaskRow }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
      <Badge kind={PRIO[t.priority]}>{t.priority}</Badge>
      {t.ownerName ?? "Unassigned"}
      {t.dueDate && <span className={t.overdue ? "font-medium text-bad" : ""}>· due {fmtDate(t.dueDate)}</span>}
      {t.origin === "ai" && <Badge kind="brand">AI draft, approved</Badge>}
      {t.origin === "seed" && <span className="rounded bg-[#f1f3f6] px-1 text-[10px] uppercase">demo</span>}
    </div>
  );
}

export default async function TasksPage({ searchParams }: PageProps<"/tasks">) {
  const sp = await searchParams;
  const view = (sp.view as string) || "list";
  const f = { initiativeId: (sp.initiativeId as string) || undefined, ownerId: (sp.owner as string) || undefined, status: (sp.status as string) || undefined };
  const { s, data } = await cachedPage(["tasks", sp], () => pageData(undefined, async (q, ctx, s) => ({
    tasks: await listTasks(q, s.workspaceId, f),
    metrics: await taskMetrics(q, s.workspaceId),
    users: await q<{ id: string; display_name: string }>("select id, display_name from app_users where workspace_id = $1 order by display_name", [s.workspaceId]),
    initiatives: await q<{ id: string; name: string }>("select id, name from initiatives where workspace_id = $1 order by name", [s.workspaceId]),
    campaigns: ctx ? await q<{ id: string; name: string }>("select id, name from campaigns where dataset_version_id = $1 order by name", [ctx.dv]) : [],
  })));
  let tasks = data.tasks;
  if (sp.filter === "overdue") tasks = tasks.filter((t) => t.overdue);
  if (sp.filter === "blocked") tasks = tasks.filter((t) => t.status === "blocked" || t.blockedBy.length);
  const canCreate = s.role !== "team_member";
  const qs = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    Object.entries({ view, initiativeId: f.initiativeId, owner: f.ownerId, status: f.status, ...o }).forEach(([k, v]) => v && p.set(k, v));
    return `/tasks?${p.toString()}`;
  };
  const m = data.metrics;
  return (
    <>
      <PageHeader title="Tasks & Calendar" subtitle="One set of task records shown as a list, a board and a calendar. Changes update analytics and the AI's context immediately." />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Open" value={m.open} href={qs({ filter: undefined })} />
        <Stat label="Overdue" value={<span className={m.overdue.length ? "text-bad" : ""}>{m.overdue.length}</span>} href={qs({ filter: "overdue" })} />
        <Stat label="Blocked" value={m.blocked.length} href={qs({ filter: "blocked" })} />
        <Stat label="Due in 7 days" value={m.dueSoon.length} />
        <Stat label="Completion rate" value={m.completionRate === null ? "–" : `${Math.round(m.completionRate * 100)}%`} sub="Done ÷ tasks not cancelled" />
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex rounded-lg border border-line bg-white p-0.5 text-sm">
          {["list", "board", "calendar"].map((v) => <Link key={v} href={qs({ view: v })} className={`rounded-md px-3 py-1 capitalize ${view === v ? "bg-brand text-white" : "text-ink-2"}`}>{v}</Link>)}
        </div>
        <form className="flex flex-wrap items-end gap-2 text-sm" action="/tasks">
          <input type="hidden" name="view" value={view} />
          <select name="initiativeId" defaultValue={f.initiativeId ?? ""} className={`${inputInline} w-48`} aria-label="Initiative"><option value="">All initiatives</option>{data.initiatives.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
          <select name="owner" defaultValue={f.ownerId ?? ""} className={`${inputInline} w-44`} aria-label="Owner"><option value="">All owners</option>{data.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select>
          <select name="status" defaultValue={f.status ?? ""} className={`${inputInline} w-36`} aria-label="Status"><option value="">All statuses</option>{statusOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          <button className={btn}>Filter</button>
          {(f.initiativeId || f.ownerId || f.status || sp.filter) && <Link href={`/tasks?view=${view}`} className="text-xs text-brand">Clear</Link>}
        </form>
      </div>

      {canCreate && (
        <details className="mb-4 rounded-xl border border-line bg-white p-4" open={sp.new === "1"}>
          <summary className="cursor-pointer text-sm font-medium text-brand">New task</summary>
          <ActionForm action={createTaskAction} className="mt-3 grid gap-3 md:grid-cols-4" success="Task created" resetOnSuccess>
            <div className="md:col-span-2"><label className={label}>Title</label><input name="title" required minLength={3} className={input} /></div>
            <div><label className={label}>Owner</label><select name="ownerUserId" className={input}><option value="">Unassigned</option>{data.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></div>
            <div><label className={label}>Reviewer</label><select name="reviewerUserId" className={input}><option value="">None</option>{data.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></div>
            <div><label className={label}>Initiative</label><select name="initiativeId" defaultValue={(sp.initiativeId as string) ?? ""} className={input}><option value="">None</option>{data.initiatives.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
            <div><label className={label}>Campaign</label><select name="campaignId" defaultValue={(sp.campaignId as string) ?? ""} className={input}><option value="">None</option>{data.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div><label className={label}>Priority</label><select name="priority" defaultValue="medium" className={input}>{["low", "medium", "high", "critical"].map((p) => <option key={p}>{p}</option>)}</select></div>
            <div><label className={label}>Status</label><select name="status" defaultValue="todo" className={input}>{statusOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
            <div><label className={label}>Start</label><input type="date" name="startDate" className={input} /></div>
            <div><label className={label}>Deadline</label><input type="date" name="dueDate" className={input} /></div>
            <div><label className={label}>Effort (hours)</label><input type="number" min={0} step="0.5" name="effortHours" className={input} /></div>
            <div className="md:col-span-4"><label className={label}>Description</label><textarea name="description" rows={2} className={input} /></div>
            <div><button className={btnPrimary}>Create task</button></div>
          </ActionForm>
        </details>
      )}

      {view === "list" && (
        <Card>
          <Table head={["Task", "Initiative / campaign", "Owner", "Priority", "Status", "Progress", "Due", "Blocked by"]}>
            {tasks.map((t) => (
              <tr key={t.id}>
                <Td><Link href={`/tasks/${t.id}`} className="font-medium text-brand hover:underline">{t.title}</Link>{t.origin === "ai" && <div><Badge kind="brand">AI draft, approved</Badge></div>}</Td>
                <Td className="text-xs text-ink-2">{t.initiativeName ?? "–"}{t.campaignName && <div className="text-muted">{t.campaignName}</div>}</Td>
                <Td>{t.ownerName ?? "–"}</Td>
                <Td><Badge kind={PRIO[t.priority]}>{t.priority}</Badge></Td>
                <Td><AutoSelect action={updateTaskAction} name="status" value={t.status} options={statusOptions} hidden={{ taskId: t.id }} /></Td>
                <Td className="tabular-nums">{t.progress}%</Td>
                <Td className={t.overdue ? "font-medium text-bad" : t.dueSoon ? "text-warn" : ""}>{fmtDate(t.dueDate)}</Td>
                <Td className="text-xs text-warn">{t.blockedBy.map((b) => b.title).join(", ")}</Td>
              </tr>
            ))}
          </Table>
          {tasks.length === 0 && <p className="py-6 text-center text-sm text-muted">No tasks match these filters.</p>}
        </Card>
      )}

      {view === "board" && (
        <div className="grid gap-3 overflow-x-auto md:grid-cols-3 xl:grid-cols-6">
          {["backlog", "todo", "in_progress", "blocked", "review", "done"].map((col) => {
            const items = tasks.filter((t) => t.status === col || (col === "backlog" && t.status === "cancelled" && false));
            return (
              <section key={col} className="min-w-52 rounded-xl border border-line bg-[#f4f6fa] p-2" aria-label={STATUS_LABEL[col]}>
                <h2 className="mb-2 flex justify-between px-1 text-xs font-semibold uppercase tracking-wide text-muted">{STATUS_LABEL[col]}<span>{items.length}</span></h2>
                <ul className="space-y-2">
                  {items.map((t) => (
                    <li key={t.id} className={`rounded-lg border bg-white p-2.5 text-sm ${t.overdue ? "border-bad/40" : "border-line"}`}>
                      <Link href={`/tasks/${t.id}`} className="font-medium text-ink hover:text-brand">{t.title}</Link>
                      <TaskMeta t={t} />
                      {t.blockedBy.length > 0 && <p className="mt-1 text-xs text-warn">Waiting on: {t.blockedBy.map((b) => b.title).join(", ")}</p>}
                      <div className="mt-2"><AutoSelect action={updateTaskAction} name="status" value={t.status} options={statusOptions} hidden={{ taskId: t.id }} /></div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {view === "calendar" && <Calendar tasks={tasks} month={(sp.month as string) || todayIn(330).slice(0, 7)} qs={qs} today={todayIn(330)} />}
    </>
  );
}

function Calendar({ tasks, month, qs, today }: { tasks: TaskRow[]; month: string; qs: (o: Record<string, string | undefined>) => string; today: string }) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const shift = (d: number) => new Date(Date.UTC(y, m - 1 + d, 1)).toISOString().slice(0, 7);
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const key = (d: number) => `${month}-${String(d).padStart(2, "0")}`;
  return (
    <Card title={first.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" })}
      actions={<div className="flex gap-2"><Link className={btn} href={qs({ month: shift(-1) })}>← Prev</Link><Link className={btn} href={qs({ month: shift(1) })}>Next →</Link></div>}
      note="Tasks appear on their deadline. Starts show as ▸ on their start date.">
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-line bg-line text-xs">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="bg-[#f4f6fa] px-2 py-1 font-medium text-muted">{d}</div>)}
        {cells.map((d, i) => (
          <div key={i} className={`min-h-24 bg-white p-1.5 ${d && key(d) === today ? "ring-2 ring-inset ring-brand" : ""}`}>
            {d && <div className="mb-1 text-[11px] text-muted">{d}</div>}
            {d && tasks.filter((t) => t.dueDate === key(d)).map((t) => (
              <Link key={t.id} href={`/tasks/${t.id}`} className={`mb-1 block truncate rounded px-1 py-0.5 ${t.overdue ? "bg-bad-soft text-bad" : t.status === "done" ? "bg-good-soft text-good line-through" : "bg-brand-soft text-brand"}`} title={t.title}>{t.title}</Link>
            ))}
            {d && tasks.filter((t) => t.startDate === key(d) && t.dueDate !== key(d)).map((t) => (
              <Link key={`s${t.id}`} href={`/tasks/${t.id}`} className="mb-1 block truncate px-1 text-muted" title={`Starts: ${t.title}`}>▸ {t.title}</Link>
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}
