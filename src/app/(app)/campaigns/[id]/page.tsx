import { cachedPage } from "@/lib/cache";
import Link from "next/link";
import { notFound } from "next/navigation";
import { pageData } from "@/lib/page";
import { campaignPerformance } from "@/lib/analytics/metrics";
import { listTasks } from "@/lib/analytics/management";
import { Badge, Card, EvidenceTag, Notice, PageHeader, Stat, Table, Td, btn, btnPrimary, input, label } from "@/components/ui";
import { ActionForm } from "@/components/client";
import { updateCampaignAction } from "@/app/actions";
import { fmtDate, fmtInr, fmtInt, fmtPct, STATUS_LABEL } from "@/lib/format";

export default async function CampaignPage({ params, searchParams }: PageProps<"/campaigns/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const { s, ctx, data } = await cachedPage(["campaigns/[id]", id, sp], () => pageData(sp.asof, async (q, ctx, s) => {
    if (!ctx) return null;
    const perf = await campaignPerformance(q, ctx, { campaignIds: [id] });
    if (!perf.rows[0]) return null;
    const [detail] = await q<Record<string, unknown>>("select target_audience, objective, utm_code, notes, planned_start, planned_end, extra from campaigns where id = $1", [id]);
    const daily = await q<Record<string, string | null>>(
      "select sum(impressions) impressions, sum(reported_reach) reach, sum(clicks) clicks, sum(sessions) sessions, sum(registration_starts) starts, min(activity_date)::text first_day, max(activity_date)::text last_day from campaign_daily where campaign_id = $1 and activity_date <= $2::date", [id, ctx.asOfDate]);
    return {
      c: perf.rows[0], overall: perf.overallShowRate, median: perf.medianCostPerVerified, detail, daily: daily[0],
      tasks: await listTasks(q, s.workspaceId, { campaignId: id }),
      members: await q<{ id: string; name: string }>("select id, name from team_members where workspace_id = $1 order by name", [s.workspaceId]),
      initiatives: await q<{ id: string; name: string }>("select id, name from initiatives where workspace_id = $1 order by name", [s.workspaceId]),
    };
  }));
  if (!ctx || !data) notFound();
  const { c, detail, daily } = data;
  const canEdit = s.role !== "team_member";
  const isAdmin = s.role === "admin";
  const ask = encodeURIComponent(`Why is ${c.name} performing the way it is? Check its show-up, costs, opt-outs and related tasks, and recommend a next step.`);
  return (
    <>
      <PageHeader title={c.name}
        subtitle={<>{c.sourceId} · {c.channel ?? "no channel"} · owner {c.ownerName ?? "unassigned"} · {c.initiativeName ? <>linked to <b>{c.initiativeName}</b> (historical proxy)</> : "no initiative"} · as of {fmtDate(ctx.asOfDate)}</>}
        actions={<><Link className={btn} href={`/analyst?q=${ask}`}>Ask the AI analyst</Link><Link className={btnPrimary} href={`/tasks?new=1&campaignId=${c.id}`}>New task</Link></>} />
      {c.health !== "healthy" && c.healthReasons.length > 0 && (
        <div className="mb-4"><Notice kind={c.health === "critical" ? "bad" : "warn"}><b className="capitalize">{c.health}:</b> {c.healthReasons.join("; ")}.</Notice></div>
      )}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Net spend" tag="observed" value={fmtInr(c.spend)} sub={c.budgetApproved !== null ? `Approved ${fmtInr(c.budgetApproved)}` : "No campaign budget set"} />
        <Stat label="Registered people" tag="observed" value={fmtInt(c.registeredPeople)} sub={c.kpiRegistrations ? `KPI ${fmtInt(c.kpiRegistrations)}` : undefined} />
        <Stat label="Confirmed" tag="observed" value={fmtInt(c.confirmedPeople)} />
        <Stat label="Verified attendees" tag="observed" value={fmtInt(c.verifiedAttendees)} sub={c.kpiAttendees ? `KPI ${fmtInt(c.kpiAttendees)}` : undefined} />
        <Stat label="Show-up rate" tag="calculated" value={fmtPct(c.showRate)} sub={`${fmtInt(c.verifiedAttendees)} ÷ ${fmtInt(c.registeredPeople)} · portfolio ${fmtPct(data.overall)}`} />
        <Stat label="Cost per verified attendee" tag="calculated" value={fmtInr(c.costPerVerifiedAttendee)} sub={`Median ${fmtInr(data.median)}`} />
        <Stat label="Opted out" tag="observed" value={fmtInt(c.optedOut)} sub="People who opted out in this campaign's context" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title={<span className="flex items-center gap-2">Anonymous activity <EvidenceTag tag="observed" /></span>}
            note="These are daily event counts, not distinct people, and cannot be joined to registrations. Summed daily reach double-counts people seen on several days.">
            <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
              {[["Impressions", daily.impressions], ["Summed daily reach", daily.reach], ["Clicks", daily.clicks], ["Landing sessions", daily.sessions], ["Form starts", daily.starts]].map(([l, v]) => (
                <div key={l as string}><dt className="text-xs text-muted">{l}</dt><dd className="tabular-nums font-medium">{fmtInt(v === null ? null : Number(v))}</dd></div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-muted">Activity from {fmtDate(daily.first_day)} to {fmtDate(daily.last_day)}.</p>
          </Card>
          <Card title="Linked tasks" actions={<Link href={`/tasks?new=1&campaignId=${c.id}`} className="text-xs text-brand">Add →</Link>}>
            {data.tasks.length === 0 ? <p className="text-sm text-muted">No tasks linked to this campaign.</p> : (
              <Table head={["Task", "Owner", "Status", "Due"]}>
                {data.tasks.map((t) => (
                  <tr key={t.id}>
                    <Td><Link href={`/tasks/${t.id}`} className="text-brand hover:underline">{t.title}</Link>{t.blockedBy.length > 0 && <div className="text-xs text-warn">Blocked by: {t.blockedBy.map((b) => b.title).join(", ")}</div>}</Td>
                    <Td>{t.ownerName ?? "–"}</Td>
                    <Td><Badge kind={t.status === "blocked" ? "critical" : t.status === "done" ? "healthy" : "neutral"}>{STATUS_LABEL[t.status]}</Badge></Td>
                    <Td className={t.overdue ? "font-medium text-bad" : ""}>{fmtDate(t.dueDate)}{t.overdue && " · overdue"}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <Card title="Brief">
            <p className="text-sm"><span className="text-muted">Audience:</span> {String(detail.target_audience ?? "–")}</p>
            <p className="mt-1 text-sm"><span className="text-muted">Objective:</span> {String(detail.objective ?? "–")}</p>
            <p className="mt-1 text-xs text-muted">Planned {fmtDate(detail.planned_start ? new Date(detail.planned_start as string).toISOString() : null)} – {fmtDate(detail.planned_end ? new Date(detail.planned_end as string).toISOString() : null)}. Audience and objective describe intent, not outcomes.</p>
          </Card>
        </div>
        <Card title="Edit campaign" note={isAdmin ? "Changes are saved to the active dataset version and recorded in the audit log." : canEdit ? "Managers can edit campaigns they own or that sit in their initiatives. Budget and initiative changes need an admin." : "Team members can view campaigns but not edit them."}>
          <ActionForm action={updateCampaignAction} className="space-y-3">
            <input type="hidden" name="campaignId" value={c.id} />
            <div><label className={label}>Status</label>
              <select name="status" defaultValue={c.status} className={input} disabled={!canEdit}>
                {["planned", "active", "paused", "completed", "cancelled"].map((x) => <option key={x} value={x}>{x}</option>)}
              </select></div>
            <div><label className={label}>Owner</label>
              <select name="ownerTeamMemberId" defaultValue={c.ownerTeamMemberId ?? ""} className={input} disabled={!canEdit}>
                <option value="">Unassigned</option>
                {data.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select></div>
            {isAdmin && (
              <div><label className={label}>Initiative</label>
                <select name="initiativeId" defaultValue={c.initiativeId ?? ""} className={input}>
                  <option value="">None</option>
                  {data.initiatives.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select></div>
            )}
            <div className="grid grid-cols-2 gap-2">
              {isAdmin && <div><label className={label}>Approved budget (₹)</label><input name="budgetApprovedInr" type="number" min={0} defaultValue={c.budgetApproved ?? ""} className={input} /></div>}
              <div><label className={label}>Committed (₹)</label><input name="budgetCommittedInr" type="number" min={0} defaultValue={c.budgetCommitted ?? ""} className={input} disabled={!canEdit} /></div>
              <div><label className={label}>KPI: registrations</label><input name="kpiRegistrations" type="number" min={0} defaultValue={c.kpiRegistrations ?? ""} className={input} disabled={!canEdit} /></div>
              <div><label className={label}>KPI: verified attendees</label><input name="kpiAttendees" type="number" min={0} defaultValue={c.kpiAttendees ?? ""} className={input} disabled={!canEdit} /></div>
            </div>
            <div><label className={label}>UTM / referral code</label><input name="utmCode" defaultValue={String(detail.utm_code ?? "")} className={input} disabled={!canEdit} /></div>
            <div><label className={label}>Notes</label><textarea name="notes" rows={3} defaultValue={String(detail.notes ?? "")} className={input} disabled={!canEdit} /></div>
            {canEdit && <button className={btnPrimary}>Save changes</button>}
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
