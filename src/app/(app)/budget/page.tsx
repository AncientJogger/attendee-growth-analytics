import { cachedPage } from "@/lib/cache";
import { pageData } from "@/lib/page";
import { budgetSummary } from "@/lib/analytics/management";
import { Card, EvidenceTag, Notice, PageHeader, Stat, Table, Td, btn, inputInline } from "@/components/ui";
import { ActionForm } from "@/components/client";
import { proposeBudgetChangeAction, updateBudgetLineAction } from "@/app/actions";
import { fmtInr, fmtLakh } from "@/lib/format";

export default async function BudgetPage({ searchParams }: PageProps<"/budget">) {
  const sp = await searchParams;
  const { s, ctx, data } = await cachedPage(["budget", sp], () => pageData(sp.asof, (q, ctx, s) => budgetSummary(q, s.workspaceId, ctx)));
  const isAdmin = s.role === "admin";
  return (
    <>
      <PageHeader title="Budget & Resource Allocation" subtitle="Plan budgets for the upcoming fest (base and stretch kept separate) and the active dataset's historical spend. Approved, committed and spent are never mixed." />
      {data.plan.map((p) => (
        <Card key={p.scenario} className="mb-4" title={<span className="flex items-center gap-2 capitalize">{p.scenario} scenario plan <EvidenceTag tag="assumption" /></span>}
          note={<>{data.definitions.join(" ")} {isAdmin ? "Edit a line and press Save." : s.role === "campaign_manager" ? "Managers propose an approved-amount change; an admin who did not request it must approve." : "Read-only for team members."}</>}>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Approved (festival-funded)" value={fmtLakh(p.festivalFunded.approved)} sub={`Ceiling ${fmtLakh(p.ceiling)}`} />
            <Stat label="Committed" value={fmtLakh(p.festivalFunded.committed)} />
            <Stat label="Spent" value={fmtLakh(p.festivalFunded.spent)} />
            <Stat label="Remaining" value={fmtLakh(p.festivalFunded.remaining)} sub="Approved − committed − spent" tag="calculated" />
            <Stat label="Headroom to ceiling" value={<span className={p.headroomToCeiling < 0 ? "text-bad" : ""}>{fmtLakh(p.headroomToCeiling)}</span>} tag="calculated" />
          </div>
          {p.headroomToCeiling < 0 && <div className="mb-3"><Notice kind="bad">Approved lines exceed the {p.scenario} ceiling by {fmtLakh(-p.headroomToCeiling)}.</Notice></div>}
          <Table head={["Line", "Funding", "Approved", "Committed", "Spent", "Remaining", "Notes", ""]}>
            {p.lines.map((l) => (
              <tr key={l.id}>
                <Td><span className="font-medium">{l.label}</span><div className="text-xs text-muted">{l.category.replace("_", " ")}</div></Td>
                <Td className="text-xs">{l.fundingSource}</Td>
                {isAdmin ? (
                  <Td className="py-1" >
                    <ActionForm action={updateBudgetLineAction} className="flex flex-wrap items-center gap-1" success="Saved">
                      <input type="hidden" name="lineId" value={l.id} />
                      <input name="approvedInr" type="number" min={0} defaultValue={l.approved} className={`${inputInline} w-28`} aria-label={`Approved for ${l.label}`} />
                      <input name="committedInr" type="number" min={0} defaultValue={l.committed} className={`${inputInline} w-28`} aria-label={`Committed for ${l.label}`} />
                      <input name="spentInr" type="number" min={0} defaultValue={l.spent} className={`${inputInline} w-28`} aria-label={`Spent for ${l.label}`} />
                      <button className={btn}>Save</button>
                    </ActionForm>
                  </Td>
                ) : <Td className="tabular-nums">{fmtInr(l.approved)}</Td>}
                {!isAdmin && <><Td className="tabular-nums">{fmtInr(l.committed)}</Td><Td className="tabular-nums">{fmtInr(l.spent)}</Td></>}
                {isAdmin && <><Td className="text-xs text-muted">(in form)</Td><Td className="text-xs text-muted">(in form)</Td></>}
                <Td className={`tabular-nums ${l.remaining < 0 ? "text-bad" : ""}`}>{fmtInr(l.remaining)}</Td>
                <Td className="max-w-56 text-xs text-muted">{l.notes}</Td>
                <Td>{s.role === "campaign_manager" && (
                  <ActionForm action={proposeBudgetChangeAction} className="flex items-center gap-1" success="Sent for approval">
                    <input type="hidden" name="lineId" value={l.id} />
                    <input name="approvedInr" type="number" min={0} placeholder="New approved" required className={`${inputInline} w-28`} aria-label="Proposed approved amount" />
                    <input name="rationale" placeholder="Why" className={`${inputInline} w-28`} aria-label="Reason" />
                    <button className={btn}>Propose</button>
                  </ActionForm>
                )}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      ))}
      {data.historical && ctx && (
        <Card title={<span className="flex items-center gap-2">Historical spend · {ctx.label} <EvidenceTag tag="observed" /></span>} note={data.historical.note}>
          <div className="mb-4 grid grid-cols-3 gap-3">
            <Stat label="Approved marketing budget" value={fmtInr(data.historical.approvedBudget)} />
            <Stat label="Net spend" value={fmtInr(data.historical.netSpend)} />
            <Stat label="Remaining" tag="calculated" value={fmtInr(data.historical.remaining)} />
          </div>
          <Table head={["Campaign", "Net spend", "Approved (campaign)", "Variance"]}>
            {data.historical.byCampaign.map((c) => (
              <tr key={c.campaign}><Td>{c.campaign}</Td><Td className="tabular-nums">{fmtInr(c.spend)}</Td><Td className="tabular-nums">{fmtInr(c.approved)}</Td>
                <Td className={`tabular-nums ${c.variance !== null && c.variance < 0 ? "text-bad" : ""}`}>{c.variance === null ? <span className="text-xs text-muted">No campaign budget set</span> : fmtInr(c.variance)}</Td></tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}
