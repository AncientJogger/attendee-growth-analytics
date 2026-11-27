import { cachedPage } from "@/lib/cache";
import Link from "next/link";
import { pageData } from "@/lib/page";
import { initiativeOverview } from "@/lib/analytics/management";
import { getStrategy } from "@/lib/analytics/context";
import { Badge, Card, EvidenceTag, PageHeader, Table, Td } from "@/components/ui";
import { DECISION_LABEL, fmtInr, fmtInt, fmtLakh, fmtPct } from "@/lib/format";

export default async function InitiativesPage({ searchParams }: PageProps<"/initiatives">) {
  const sp = await searchParams;
  const { data } = await cachedPage(["initiatives", sp], () => pageData(sp.asof, async (q, ctx, s) => ({ inits: await initiativeOverview(q, s.workspaceId, ctx), strategy: await getStrategy(q, s.workspaceId) })));
  const { inits, strategy } = data;
  const tot = inits.reduce((a, i) => ({ base: a.base + i.plan.baseTarget, stretch: a.stretch + i.plan.stretchTarget, bb: a.bb + i.plan.baseBudget, sb: a.sb + i.plan.stretchBudget }), { base: 0, stretch: 0, bb: 0, sb: 0 });
  const cfg = strategy.config;
  return (
    <>
      <PageHeader title="Initiatives" subtitle="The five growth bets for the upcoming fest. Targets and budgets are planning allocations, not achieved results. Linked 2025 campaigns are shown only as historical proxies for evidence." />
      <Card className="mb-4" title={<span className="flex items-center gap-2">Plan contributions <EvidenceTag tag="assumption" /></span>}
        note={`Required growth over the ${fmtInt(cfg.planningBaseline)} baseline: ${fmtInt(cfg.baseTarget - cfg.planningBaseline)} (base) / ${fmtInt(cfg.stretchTarget - cfg.planningBaseline)} (stretch). An attendee is counted once even if several initiatives touched them, so contributions must be measured as uplift, never summed from touches.`}>
        <Table head={["Initiative", "Decision", "Status", "Owner", "Base +", "Stretch +", "Base budget", "Stretch budget", "Tasks (open / overdue)", "Historical proxy", "Threshold check"]}>
          {inits.map((i) => (
            <tr key={i.id}>
              <Td><Link href={`/initiatives/${i.id}`} className="font-medium text-brand hover:underline">{i.name}</Link></Td>
              <Td><Badge kind="brand">{DECISION_LABEL[i.decision]}</Badge></Td>
              <Td className="capitalize">{i.status.replace("_", " ")}</Td>
              <Td>{i.ownerName ?? "–"}</Td>
              <Td className="tabular-nums">{fmtInt(i.plan.baseTarget)}</Td>
              <Td className="tabular-nums">{fmtInt(i.plan.stretchTarget)}</Td>
              <Td className="tabular-nums">{fmtLakh(i.plan.baseBudget)}</Td>
              <Td className="tabular-nums">{fmtLakh(i.plan.stretchBudget)}</Td>
              <Td className="tabular-nums">{i.tasks.open} / <span className={i.tasks.overdue ? "font-medium text-bad" : ""}>{i.tasks.overdue}</span></Td>
              <Td className="text-xs">{i.historicalProxy.length ? i.historicalProxy.map((p) => <div key={p.campaign}>{p.campaign}: {fmtPct(p.showRate, 0)} show-up, {fmtInr(p.costPerVerified)}/verified</div>) : <span className="text-muted">None</span>}</Td>
              <Td><Badge kind={i.thresholdVerdict}>{i.thresholdVerdict === "insufficient" ? "No pilot data yet" : i.thresholdVerdict}</Badge></Td>
            </tr>
          ))}
          <tr className="font-medium">
            <Td>Total</Td><Td /><Td /><Td />
            <Td className="tabular-nums">{fmtInt(tot.base)}</Td><Td className="tabular-nums">{fmtInt(tot.stretch)}</Td>
            <Td className="tabular-nums">{fmtLakh(tot.bb)}</Td><Td className="tabular-nums">{fmtLakh(tot.sb)}</Td><Td /><Td /><Td />
          </tr>
        </Table>
      </Card>
    </>
  );
}
