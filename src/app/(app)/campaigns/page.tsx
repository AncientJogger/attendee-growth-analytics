import { cachedPage } from "@/lib/cache";
import Link from "next/link";
import { Suspense } from "react";
import { pageData } from "@/lib/page";
import { campaignPerformance } from "@/lib/analytics/metrics";
import { Badge, Card, Empty, PageHeader, Table, Td } from "@/components/ui";
import { AsOfPicker } from "@/components/client";
import { HBarChart } from "@/components/charts";
import { fmtDate, fmtInr, fmtInt, fmtPct } from "@/lib/format";

export default async function CampaignsPage({ searchParams }: PageProps<"/campaigns">) {
  const sp = await searchParams;
  const { ctx, data } = await cachedPage(["campaigns", sp], () => pageData(sp.asof, async (q, ctx) => (ctx ? campaignPerformance(q, ctx) : null)));
  if (!ctx || !data) return <><PageHeader title="Campaigns" /><Empty>No active dataset.</Empty></>;
  const rows = data.rows;
  return (
    <>
      <PageHeader title="Campaigns" subtitle={<>Performance from {ctx.label}, as of {fmtDate(ctx.asOfDate)}. Open a campaign to edit its owner, status, budget and KPI targets.</>}
        actions={<Suspense><AsOfPicker value={ctx.asOfDate} min={ctx.event?.historyStart} max={ctx.event?.historyEnd} /></Suspense>} />
      <Card className="mb-4" note={<>{data.definitions.map((d) => <span key={d} className="block">{d}</span>)}</>}>
        <Table head={["Campaign", "Channel", "Owner", "Initiative", "Spend", "First-touch people", "Registered", "Confirmed", "Verified", "Show-up", "Cost / reg.", "Cost / verified", "Opt-outs", "Health"]}>
          {rows.map((c) => (
            <tr key={c.id}>
              <Td><Link href={`/campaigns/${c.id}`} className="font-medium text-brand hover:underline">{c.name}</Link><div className="text-xs text-muted">{c.sourceId} · {c.status}</div></Td>
              <Td className="text-ink-2">{c.channel ?? "–"}</Td>
              <Td className="text-ink-2">{c.ownerName ?? "–"}</Td>
              <Td className="text-ink-2">{c.initiativeName ?? "–"}</Td>
              <Td className="tabular-nums">{fmtInr(c.spend)}</Td>
              <Td className="tabular-nums">{fmtInt(c.firstTouchPeople)}</Td>
              <Td className="tabular-nums">{fmtInt(c.registeredPeople)}</Td>
              <Td className="tabular-nums">{fmtInt(c.confirmedPeople)}</Td>
              <Td className="tabular-nums">{fmtInt(c.verifiedAttendees)}</Td>
              <Td className="tabular-nums">{fmtPct(c.showRate)}</Td>
              <Td className="tabular-nums">{fmtInr(c.costPerRegistration)}</Td>
              <Td className="tabular-nums">{fmtInr(c.costPerVerifiedAttendee)}</Td>
              <Td className="tabular-nums">{fmtInt(c.optedOut)}</Td>
              <Td><Badge kind={c.health}>{c.health}</Badge></Td>
            </tr>
          ))}
        </Table>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Cost per verified attendee (lower is better)" note="Net spend ÷ verified attendees attributed by registration source.">
          <HBarChart format="inr" valueLabel="Cost per verified attendee" data={rows.filter((r) => r.costPerVerifiedAttendee !== null).sort((a, b) => a.costPerVerifiedAttendee! - b.costPerVerifiedAttendee!).map((r) => ({ name: r.name, value: r.costPerVerifiedAttendee! }))} />
        </Card>
        <Card title="Show-up rate" note={`Portfolio show-up: ${fmtPct(data.overallShowRate)}.`}>
          <HBarChart format="pct" valueLabel="Show-up rate" data={rows.filter((r) => r.showRate !== null).sort((a, b) => b.showRate! - a.showRate!).map((r) => ({ name: r.name, value: r.showRate! }))} />
        </Card>
      </div>
    </>
  );
}
