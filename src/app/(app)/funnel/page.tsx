import { cachedPage } from "@/lib/cache";
import { Suspense } from "react";
import { pageDataPar } from "@/lib/page";
import { attributionViews, compareRanges, funnelMetrics, targetsVsActual } from "@/lib/analytics/metrics";
import { Bar, Card, Empty, EvidenceTag, PageHeader, Table, Td, btn, inputInline } from "@/components/ui";
import { AsOfPicker } from "@/components/client";
import { fmtDate, fmtInr, fmtInt, fmtPct } from "@/lib/format";

export default async function FunnelPage({ searchParams }: PageProps<"/funnel">) {
  const sp = await searchParams;
  const g = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const ranges = g("af") && g("at") && g("bf") && g("bt") ? { a: { from: g("af"), to: g("at") }, b: { from: g("bf"), to: g("bt") } } : null;
  const { ctx, data } = await cachedPage(["funnel", sp], () => pageDataPar(sp.asof, async (run, ctx) => {
    if (!ctx) return null;
    const [funnel, attr, tgt, cmp] = await Promise.all([
      run((q) => funnelMetrics(q, ctx)), run((q) => attributionViews(q, ctx)), run((q) => targetsVsActual(q, ctx)),
      ranges ? run((q) => compareRanges(q, ctx, ranges.a, ranges.b)) : Promise.resolve(null),
    ]);
    return { funnel, attr, tgt, cmp };
  }));
  if (!ctx || !data) return <><PageHeader title="Funnel & Attribution" /><Empty>No active dataset.</Empty></>;
  const top = data.funnel.stages.find((s) => s.available)?.value ?? 1;
  return (
    <>
      <PageHeader title="Funnel & Attribution" subtitle={<>From {ctx.label}, as of {fmtDate(ctx.asOfDate)}. Only stages supported by fields in the selected dataset are shown.</>}
        actions={<Suspense><AsOfPicker value={ctx.asOfDate} min={ctx.event?.historyStart} max={ctx.event?.historyEnd} /></Suspense>} />
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title={<span className="flex items-center gap-2">Identified-person funnel <EvidenceTag tag="observed" /></span>} note={data.funnel.notes.join(" ")}>
          <Table head={["Stage", "People", "", "Conversion", "Denominator"]}>
            {data.funnel.stages.map((s) => (
              <tr key={s.key}>
                <Td className="font-medium">{s.label}</Td>
                <Td className="tabular-nums">{s.available ? fmtInt(s.value) : <span className="text-xs text-muted">{s.note}</span>}</Td>
                <Td className="w-48">{s.available && <Bar value={s.value ?? 0} max={top} />}</Td>
                <Td className="tabular-nums">{fmtPct(s.fromPrevious)}</Td>
                <Td className="text-xs text-muted">{s.previousLabel ?? "–"}</Td>
              </tr>
            ))}
          </Table>
          {data.funnel.walkIns !== null && <p className="mt-2 text-sm text-ink-2">Walk-ins (verified attendees with no registration): <b>{fmtInt(data.funnel.walkIns)}</b>.</p>}
        </Card>
        <Card title={<span className="flex items-center gap-2">Anonymous activity <EvidenceTag tag="observed" /></span>} note="Event counts from campaign platforms. Not people, so they cannot be placed on the same funnel or divided into person-level conversions.">
          {data.funnel.anonymous ? (
            <dl className="space-y-2 text-sm">
              {[["Impressions", data.funnel.anonymous.impressions], ["Summed daily reach", data.funnel.anonymous.summedDailyReach], ["Clicks", data.funnel.anonymous.clicks], ["Landing sessions", data.funnel.anonymous.sessions], ["Form starts", data.funnel.anonymous.registrationStarts]].map(([l, v]) => (
                <div key={l as string} className="flex justify-between"><dt className="text-muted">{l}</dt><dd className="tabular-nums">{v === null ? <span className="text-xs text-muted">Not present in selected dataset</span> : fmtInt(v as number)}</dd></div>
              ))}
              {data.funnel.anonymous.impressions && data.funnel.anonymous.clicks ? <p className="pt-2 text-xs text-muted">Click-through (clicks ÷ impressions): {fmtPct(data.funnel.anonymous.clicks / data.funnel.anonymous.impressions)}</p> : null}
            </dl>
          ) : <p className="text-sm text-muted">Not present in selected dataset.</p>}
        </Card>
      </div>
      {data.tgt.available && (
        <Card className="mb-4" title={<span className="flex items-center gap-2">Targets vs actuals · {data.tgt.version} <EvidenceTag tag="observed" /></span>} note={`Target version effective ${fmtDate(data.tgt.effectiveAt)}. These are the dataset's own targets for its event, not the upcoming fest's planning targets.`}>
          <Table head={["Metric", "Target", "Actual", "Attainment"]}>
            {data.tgt.rows.map((r) => (
              <tr key={r.metric}><Td>{r.metric}</Td><Td className="tabular-nums">{r.metric.includes("spend") ? fmtInr(r.target) : fmtInt(r.target)}</Td>
                <Td className="tabular-nums">{r.metric.includes("spend") ? fmtInr(r.actual) : fmtInt(r.actual)}</Td><Td className="tabular-nums">{fmtPct(r.attainment, 0)}</Td></tr>
            ))}
          </Table>
        </Card>
      )}
      <Card className="mb-4" title="Attribution (descriptive, not causal)" note={data.attr.available ? data.attr.definitions.join(" ") : undefined}>
        {data.attr.available ? (
          <Table head={["Campaign", "First touch", "Registration source", "Last interaction before admission"]}>
            {data.attr.rows.map((r) => <tr key={r.campaign}><Td>{r.campaign}</Td><Td className="tabular-nums">{fmtInt(r.firstTouch)}</Td><Td className="tabular-nums">{fmtInt(r.registrationSource)}</Td><Td className="tabular-nums">{fmtInt(r.lastInteraction)}</Td></tr>)}
          </Table>
        ) : <p className="text-sm text-muted">{data.attr.reason}</p>}
      </Card>
      <Card title="Compare two periods" note={data.cmp?.note ?? "Pick two inclusive date ranges to see what changed."}>
        <form action="/funnel" className="flex flex-wrap items-end gap-2 text-sm">
          {typeof sp.asof === "string" && <input type="hidden" name="asof" value={sp.asof} />}
          <span className="text-xs text-muted">Period A</span><input type="date" name="af" defaultValue={g("af")} className={`${inputInline} w-40`} aria-label="Period A from" /><input type="date" name="at" defaultValue={g("at")} className={`${inputInline} w-40`} aria-label="Period A to" />
          <span className="text-xs text-muted">Period B</span><input type="date" name="bf" defaultValue={g("bf")} className={`${inputInline} w-40`} aria-label="Period B from" /><input type="date" name="bt" defaultValue={g("bt")} className={`${inputInline} w-40`} aria-label="Period B to" />
          <button className={btn}>Compare</button>
        </form>
        {data.cmp && (
          <div className="mt-4"><Table head={["Metric", "Period A", "Period B", "Change"]}>
            {(["registrations", "identified", "spend", "interactions", "cancellations", "verifiedAttendees"] as const).map((k) => {
              const d = data.cmp!.delta[k];
              const f = k === "spend" ? fmtInr : fmtInt;
              return <tr key={k}><Td className="capitalize">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</Td><Td className="tabular-nums">{f(data.cmp!.a[k] as number | null)}</Td><Td className="tabular-nums">{f(data.cmp!.b[k] as number | null)}</Td>
                <Td className="tabular-nums">{d ? `${d.change >= 0 ? "+" : ""}${f(d.change)} (${d.pctChange === null ? "n/a" : fmtPct(d.pctChange)})` : "–"}</Td></tr>;
            })}
          </Table></div>
        )}
      </Card>
    </>
  );
}
