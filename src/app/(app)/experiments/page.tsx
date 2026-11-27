import { cachedPage } from "@/lib/cache";
import { pageData } from "@/lib/page";
import { Badge, Card, EvidenceTag, PageHeader, btn, btnPrimary, input, label } from "@/components/ui";
import { ActionForm } from "@/components/client";
import { createExperimentAction, recordExperimentAction } from "@/app/actions";
import { fmtDate, fmtPct } from "@/lib/format";

export default async function ExperimentsPage() {
  const { s, data } = await cachedPage(["experiments"], () => pageData(undefined, async (q, _ctx, s) => ({
    exps: await q<Record<string, unknown>>("select e.*, i.name initiative_name, u.display_name owner_name from experiments e left join initiatives i on i.id = e.initiative_id left join app_users u on u.id = e.owner_user_id where e.workspace_id = $1 order by e.start_date nulls last", [s.workspaceId]),
    initiatives: await q<{ id: string; name: string }>("select id, name from initiatives where workspace_id = $1 order by name", [s.workspaceId]),
  })));
  const canEdit = s.role !== "team_member";
  return (
    <>
      <PageHeader title="Analytics / Experiments" subtitle="Controlled tests for each initiative, with the decision rule written down before results come in. Uplift is computed only when both cohorts have results." />
      <div className="space-y-4">
        {data.exps.map((e) => {
          const tn = Number(e.treatment_n ?? 0), cn = Number(e.control_n ?? 0);
          const has = tn > 0 && cn > 0 && e.treatment_conversions !== null && e.control_conversions !== null;
          const tr = has ? Number(e.treatment_conversions) / tn : null, cr = has ? Number(e.control_conversions) / cn : null;
          const se = has ? Math.sqrt((tr! * (1 - tr!)) / tn + (cr! * (1 - cr!)) / cn) : null;
          return (
            <Card key={String(e.id)} title={<span className="flex items-center gap-2">{String(e.name)} <Badge kind={e.status === "completed" ? "healthy" : "brand"}>{String(e.status)}</Badge>{e.decision ? <Badge kind={String(e.decision)}>{String(e.decision)}</Badge> : null}</span>}
              note={e.caveats ? String(e.caveats) : undefined}>
              <div className="grid gap-4 md:grid-cols-3">
                <dl className="space-y-1 text-sm md:col-span-2">
                  <div><dt className="inline text-muted">Hypothesis: </dt><dd className="inline">{String(e.hypothesis ?? "–")}</dd></div>
                  <div><dt className="inline text-muted">Initiative: </dt><dd className="inline">{String(e.initiative_name ?? "–")} · owner {String(e.owner_name ?? "–")}</dd></div>
                  <div><dt className="inline text-muted">Segment: </dt><dd className="inline">{String(e.segment ?? "–")}</dd></div>
                  <div><dt className="inline text-muted">Treatment / control: </dt><dd className="inline">{String(e.treatment ?? "–")} vs {String(e.control ?? "–")}</dd></div>
                  <div><dt className="inline text-muted">Window: </dt><dd className="inline">{fmtDate(e.start_date as string)} – {fmtDate(e.end_date as string)}</dd></div>
                  <div><dt className="inline text-muted">Primary / guardrail: </dt><dd className="inline">{String(e.primary_metric ?? "–")} / {String(e.guardrail_metric ?? "–")}</dd></div>
                  <div><dt className="inline text-muted">Pre-set decision rule: </dt><dd className="inline font-medium">{String(e.decision_rule ?? "–")}</dd></div>
                </dl>
                <div className="rounded-lg bg-[#f4f6fa] p-3 text-sm">
                  <div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted">Result <EvidenceTag tag="calculated" /></div>
                  {has ? (
                    <>
                      <p>Treatment {fmtPct(tr)} (n={tn}) vs control {fmtPct(cr)} (n={cn})</p>
                      <p className="mt-1 font-semibold">Uplift: {((tr! - cr!) * 100).toFixed(1)} pts</p>
                      <p className="mt-1 text-xs text-muted">≈95% interval ±{(1.96 * se! * 100).toFixed(1)} pts (normal approximation). {Math.abs(tr! - cr!) < 1.96 * se! ? "Not distinguishable from zero at this sample size." : "Distinguishable from zero."}</p>
                    </>
                  ) : <p className="text-muted">No results recorded. No threshold can be applied yet.</p>}
                </div>
              </div>
              {canEdit && (
                <details className="mt-3"><summary className="cursor-pointer text-sm text-brand">Record results / decision</summary>
                  <ActionForm action={recordExperimentAction} className="mt-2 grid gap-2 md:grid-cols-4" success="Results saved">
                    <input type="hidden" name="experimentId" value={String(e.id)} />
                    <div><label className={label}>Treatment n</label><input name="treatmentN" type="number" min={0} defaultValue={e.treatment_n as number ?? ""} className={input} /></div>
                    <div><label className={label}>Treatment conversions</label><input name="treatmentConversions" type="number" min={0} defaultValue={e.treatment_conversions as number ?? ""} className={input} /></div>
                    <div><label className={label}>Control n</label><input name="controlN" type="number" min={0} defaultValue={e.control_n as number ?? ""} className={input} /></div>
                    <div><label className={label}>Control conversions</label><input name="controlConversions" type="number" min={0} defaultValue={e.control_conversions as number ?? ""} className={input} /></div>
                    <div><label className={label}>Status</label><select name="status" defaultValue={String(e.status)} className={input}>{["planned", "running", "completed", "stopped"].map((x) => <option key={x}>{x}</option>)}</select></div>
                    <div><label className={label}>Decision</label><select name="decision" defaultValue={String(e.decision ?? "")} className={input}><option value="">Not decided</option>{["scale", "change", "stop"].map((x) => <option key={x}>{x}</option>)}</select></div>
                    <div className="md:col-span-2"><label className={label}>Caveats</label><input name="caveats" defaultValue={String(e.caveats ?? "")} className={input} /></div>
                    <div><button className={btnPrimary}>Save results</button></div>
                  </ActionForm>
                </details>
              )}
            </Card>
          );
        })}
      </div>
      {canEdit && (
        <Card className="mt-4" title="New experiment">
          <ActionForm action={createExperimentAction} className="grid gap-2 md:grid-cols-3" success="Experiment created" resetOnSuccess>
            <div><label className={label}>Name</label><input name="name" required className={input} /></div>
            <div><label className={label}>Initiative</label><select name="initiativeId" className={input}><option value="">None</option>{data.initiatives.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
            <div><label className={label}>Segment</label><input name="segment" className={input} /></div>
            <div className="md:col-span-3"><label className={label}>Hypothesis</label><input name="hypothesis" className={input} /></div>
            <div><label className={label}>Treatment</label><input name="treatment" className={input} /></div>
            <div><label className={label}>Control</label><input name="control" className={input} /></div>
            <div><label className={label}>Primary metric</label><input name="primaryMetric" className={input} /></div>
            <div><label className={label}>Guardrail metric</label><input name="guardrailMetric" className={input} /></div>
            <div><label className={label}>Start</label><input type="date" name="startDate" className={input} /></div>
            <div><label className={label}>End</label><input type="date" name="endDate" className={input} /></div>
            <div className="md:col-span-3"><label className={label}>Decision rule (set before results)</label><input name="decisionRule" className={input} /></div>
            <div><button className={btn}>Create experiment</button></div>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
