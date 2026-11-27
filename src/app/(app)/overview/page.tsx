import { cachedPage } from "@/lib/cache";
import Link from "next/link";
import { Suspense } from "react";
import { pageDataPar } from "@/lib/page";
import { attendanceMetrics, campaignPerformance, funnelMetrics, registrationMetrics, targetsVsActual, weeklyTrend } from "@/lib/analytics/metrics";
import { budgetSummary, capacityStatus, initiativeOverview, taskMetrics } from "@/lib/analytics/management";
import { getStrategy } from "@/lib/analytics/context";
import { Badge, Bar, Card, Empty, EvidenceTag, Notice, PageHeader, Stat, Table, Td } from "@/components/ui";
import { AsOfPicker } from "@/components/client";
import { WeeklyTrendChart } from "@/components/charts";
import { DECISION_LABEL, fmtDate, fmtDateTime, fmtInr, fmtInt, fmtLakh, fmtPct } from "@/lib/format";

export default async function OverviewPage({ searchParams }: PageProps<"/overview">) {
  const sp = await searchParams;
  const { ctx, data } = await cachedPage(["overview", sp], () => pageDataPar(sp.asof, async (run, ctx, s) => {
    const [strategy, tasks, budget, capacity, inits, pending, m] = await Promise.all([
      run((q) => getStrategy(q, s.workspaceId)),
      run((q) => taskMetrics(q, s.workspaceId)),
      run((q) => budgetSummary(q, s.workspaceId, ctx)),
      run((q) => capacityStatus(q, s.workspaceId)),
      run((q) => initiativeOverview(q, s.workspaceId, ctx)),
      run((q) => q<{ n: string }>("select count(*) n from approvals where workspace_id = $1 and status = 'pending'", [s.workspaceId])),
      ctx
        ? Promise.all([
            run((q) => attendanceMetrics(q, ctx)), run((q) => registrationMetrics(q, ctx)), run((q) => targetsVsActual(q, ctx)),
            run((q) => funnelMetrics(q, ctx)), run((q) => weeklyTrend(q, ctx)), run((q) => campaignPerformance(q, ctx)),
          ]).then(([att, reg, tgt, funnel, trend, camps]) => ({ att, reg, tgt, funnel, trend, camps }))
        : Promise.resolve(null),
    ]);
    return { strategy, tasks, budget, capacity, inits, pending: Number(pending[0].n), m };
  }));
  const { strategy, tasks, budget, capacity, inits, pending, m } = data;
  const cfg = strategy.config;
  const base = budget.plan.find((p) => p.scenario === "base")!;

  const alerts: { kind: "warn" | "bad" | "info"; text: React.ReactNode }[] = [];
  if (!capacity.configured) alerts.push({ kind: "warn", text: <>Venue capacity is not configured, so no target can be called capacity-safe. <Link className="underline" href="/strategy">Set it in Strategy & Targets</Link>.</> });
  if (tasks.overdue.length) alerts.push({ kind: "bad", text: <>{tasks.overdue.length} overdue task{tasks.overdue.length > 1 ? "s" : ""}, {tasks.blocked.length} blocked. <Link className="underline" href="/tasks?filter=overdue">Review</Link>.</> });
  const critical = m?.camps.rows.filter((c) => c.health === "critical") ?? [];
  if (critical.length) alerts.push({ kind: "bad", text: <>Critical campaigns: {critical.map((c, i) => <span key={c.id}>{i ? ", " : ""}<Link className="underline" href={`/campaigns/${c.id}`}>{c.name}</Link></span>)}.</> });
  if (pending) alerts.push({ kind: "info", text: <>{pending} proposal{pending > 1 ? "s" : ""} waiting for approval. <Link className="underline" href="/approvals">Open the queue</Link>.</> });
  if (base.festivalFunded.approved > base.ceiling) alerts.push({ kind: "bad", text: <>Base plan budget ({fmtLakh(base.festivalFunded.approved)}) is above its ceiling ({fmtLakh(base.ceiling)}).</> });
  ctx?.warnings.slice(0, 2).forEach((w) => alerts.push({ kind: "warn", text: <>Dataset: {w}</> }));

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={ctx ? <>Observed figures come from <b>{ctx.label}</b>{ctx.event?.historyStart && <> (records {fmtDate(ctx.event.historyStart)} – {fmtDate(ctx.event.historyEnd)})</>}, as of the end of {fmtDate(ctx.asOfDate)}. Planning targets for the upcoming fest are shown separately and are not observed results.</> : "No dataset is active."}
        actions={ctx && <Suspense><AsOfPicker value={ctx.asOfDate} min={ctx.event?.historyStart} max={ctx.event?.historyEnd} /></Suspense>}
      />
      {alerts.length > 0 && (
        <div className="mb-6 grid gap-2">{alerts.map((a, i) => <Notice key={i} kind={a.kind}>{a.text}</Notice>)}</div>
      )}

      {!ctx || !m ? (
        <Empty>No active dataset. An admin can import one in the <Link className="text-brand underline" href="/datasets">Dataset Manager</Link>.</Empty>
      ) : (
        <>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Historical dataset · {ctx.event?.name ?? ctx.label}</h2>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Unique verified attendees" tag="observed" href="/funnel"
              value={m.att.available ? fmtInt(m.att.uniqueVerifiedAttendees) : "–"}
              sub={m.tgt.available ? <>Target {fmtInt(m.tgt.rows[2].target)} · {fmtPct(m.tgt.rows[2].attainment, 0)}</> : m.att.available ? undefined : "No check-ins in dataset"} />
            <Stat label="Registered people" tag="observed" href="/audience"
              value={m.reg.available ? fmtInt(m.reg.registeredPeople) : "–"}
              sub={m.tgt.available ? <>Target {fmtInt(m.tgt.rows[1].target)} · {fmtPct(m.tgt.rows[1].attainment, 0)}</> : undefined} />
            <Stat label="Show-up rate" tag="calculated" value={m.reg.available ? fmtPct(m.reg.showRate) : "–"} sub="Verified ÷ registered people" />
            <Stat label="Attended both days" tag="observed" value={m.att.available ? fmtInt(m.att.attendedMultipleDays) : "–"} sub={m.att.available ? <>{fmtInt(m.att.walkInsWithoutRegistration)} walk-ins without registration</> : undefined} />
            <Stat label="Net marketing spend" tag="observed" href="/budget"
              value={budget.historical?.netSpend !== null && budget.historical ? fmtInr(budget.historical.netSpend) : "–"}
              sub={budget.historical?.approvedBudget ? <>of {fmtInr(budget.historical.approvedBudget)} approved</> : "No approved budget in dataset"} />
            <Stat label="Cost per verified attendee" tag="calculated"
              value={budget.historical?.netSpend && m.att.available && m.att.uniqueVerifiedAttendees ? fmtInr(budget.historical.netSpend / m.att.uniqueVerifiedAttendees) : "–"}
              sub="All spend ÷ all verified attendees" />
          </div>

          <div className="mb-6 grid gap-4 xl:grid-cols-3">
            <Card title="Weekly registrations and spend" className="xl:col-span-2" note="Registrations by external people by week registered (IST). Spend is net posted spend including vendor credits.">
              <WeeklyTrendChart data={m.trend} />
            </Card>
            <Card title={<span className="flex items-center gap-2">Funnel <EvidenceTag tag="observed" /></span>} actions={<Link href="/funnel" className="text-xs text-brand">Details →</Link>}>
              <ul className="space-y-3">
                {m.funnel.stages.map((st) => (
                  <li key={st.key}>
                    <div className="flex justify-between text-sm">
                      <span className="text-ink-2">{st.label}</span>
                      <span className="tabular-nums font-medium">{st.available ? fmtInt(st.value) : <span className="text-xs text-muted">{st.note}</span>}</span>
                    </div>
                    {st.available && <Bar value={st.value ?? 0} max={m.funnel.stages[0].value ?? 1} />}
                    {st.fromPrevious !== null && <div className="mt-0.5 text-[11px] text-muted">{fmtPct(st.fromPrevious)} of {st.previousLabel?.toLowerCase()}</div>}
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <Card title="Campaign health" className="mb-6" actions={<Link href="/campaigns" className="text-xs text-brand">All campaigns →</Link>}
            note={m.camps.definitions[4]}>
            <Table head={["Campaign", "Owner", "Registered", "Verified", "Show-up", "Cost / verified", "Health"]}>
              {m.camps.rows.map((c) => (
                <tr key={c.id}>
                  <Td><Link href={`/campaigns/${c.id}`} className="font-medium text-brand hover:underline">{c.name}</Link></Td>
                  <Td className="text-ink-2">{c.ownerName ?? "–"}</Td>
                  <Td className="tabular-nums">{fmtInt(c.registeredPeople)}</Td>
                  <Td className="tabular-nums">{fmtInt(c.verifiedAttendees)}</Td>
                  <Td className="tabular-nums">{fmtPct(c.showRate)}</Td>
                  <Td className="tabular-nums">{fmtInr(c.costPerVerifiedAttendee)}</Td>
                  <Td><Badge kind={c.health}>{c.health}</Badge></Td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}

      <h2 className="mb-2 mt-2 text-xs font-semibold uppercase tracking-wide text-muted">Upcoming fest · planning and execution</h2>
      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card title={<span className="flex items-center gap-2">Targets <EvidenceTag tag="assumption" /></span>} actions={<Link href="/strategy" className="text-xs text-brand">Edit →</Link>}
          note={`North star: ${cfg.northStar} Strategy version ${strategy.version}.`}>
          <dl className="grid grid-cols-3 gap-3 text-center">
            {[["Baseline", cfg.planningBaseline], ["Base", cfg.baseTarget], ["Stretch", cfg.stretchTarget]].map(([l, v]) => (
              <div key={l as string} className="rounded-lg bg-brand-soft p-3"><dt className="text-xs text-muted">{l}</dt><dd className="text-xl font-semibold tabular-nums">{fmtInt(v as number)}</dd></div>
            ))}
          </dl>
          <p className="mt-3 text-sm text-ink-2">Required growth: <b>{fmtInt(cfg.baseTarget - cfg.planningBaseline)}</b> (base) / <b>{fmtInt(cfg.stretchTarget - cfg.planningBaseline)}</b> (stretch).</p>
          <p className="mt-1 text-sm">{capacity.configured ? <>Capacity confirmed: {fmtInt(capacity.dailyLimit)} per day</> : <span className="text-warn">Capacity not configured</span>}</p>
        </Card>
        <Card title="Initiatives" actions={<Link href="/initiatives" className="text-xs text-brand">All →</Link>}>
          <ul className="divide-y divide-line">
            {inits.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <Link href={`/initiatives/${i.id}`} className="font-medium text-brand hover:underline">{i.name}</Link>
                <span className="flex items-center gap-2 text-xs">
                  <Badge kind="brand">{DECISION_LABEL[i.decision]}</Badge>
                  {i.tasks.overdue > 0 && <Badge kind="critical">{i.tasks.overdue} overdue</Badge>}
                  <span className="tabular-nums text-muted">+{fmtInt(i.plan.baseTarget)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Execution" actions={<Link href="/tasks" className="text-xs text-brand">Tasks →</Link>}>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-bad-soft p-2"><div className="text-xl font-semibold text-bad">{tasks.overdue.length}</div><div className="text-xs text-muted">Overdue</div></div>
            <div className="rounded-lg bg-warn-soft p-2"><div className="text-xl font-semibold text-warn">{tasks.blocked.length}</div><div className="text-xs text-muted">Blocked</div></div>
            <div className="rounded-lg bg-brand-soft p-2"><div className="text-xl font-semibold text-brand">{tasks.dueSoon.length}</div><div className="text-xs text-muted">Due in 7 days</div></div>
          </div>
          <ul className="mt-3 space-y-1.5 text-sm">
            {tasks.overdue.slice(0, 4).map((t) => (
              <li key={t.id}><Link href={`/tasks/${t.id}`} className="text-ink hover:text-brand">{t.title}</Link> <span className="text-xs text-bad">due {fmtDate(t.dueDate)} · {t.ownerName}</span></li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">Base budget: {fmtLakh(base.festivalFunded.approved)} approved, {fmtLakh(base.festivalFunded.committed)} committed, {fmtLakh(base.festivalFunded.spent)} spent (ceiling {fmtLakh(base.ceiling)}).</p>
        </Card>
      </div>
      {ctx && <p className="text-xs text-muted">Data freshness: dataset imported {fmtDateTime(ctx.uploadedAt)} · workspace data version {ctx.dataVersion} · this page refreshes automatically when records change.</p>}
    </>
  );
}
