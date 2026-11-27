import { cachedPage } from "@/lib/cache";
import { pageData } from "@/lib/page";
import { getStrategy } from "@/lib/analytics/context";
import { Card, EvidenceTag, Notice, PageHeader, Table, Td, btnPrimary, input, inputInline, label } from "@/components/ui";
import { ActionForm } from "@/components/client";
import { saveStrategyAction } from "@/app/actions";
import { fmtDateTime, fmtInt, fmtLakh, fmtPct } from "@/lib/format";

export default async function StrategyPage() {
  const { s, data } = await cachedPage(["strategy"], () => pageData(undefined, async (q, _ctx, s) => ({
    cur: await getStrategy(q, s.workspaceId),
    history: await q<{ version: number; change_note: string | null; created_at: Date; name: string | null }>(
      "select c.version, c.change_note, c.created_at, u.display_name name from strategy_configs c left join app_users u on u.id = c.created_by where c.workspace_id = $1 order by c.version desc", [s.workspaceId]),
  })));
  const c = data.cur.config;
  const isAdmin = s.role === "admin";
  return (
    <>
      <PageHeader title="Strategy & Targets" subtitle={<>Planning assumptions for the upcoming fest. <EvidenceTag tag="assumption" /> None of these come from the attendee workbook. Every save creates a new version; older versions stay in the history.</>} />
      {!c.capacity.dailyLimit && !c.capacity.totalLimit && <div className="mb-4"><Notice kind="warn">Venue capacity is <b>not configured</b>. The dashboard and the AI will not call any target capacity-safe until an admin enters a confirmed limit here.</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title={`Current version: v${data.cur.version}`} note={c.market.note}>
          <ActionForm action={saveStrategyAction} className="space-y-4" success="Saved as a new version">
            <fieldset disabled={!isAdmin} className="contents">
              <div className="grid gap-3 md:grid-cols-4">
                <div><label className={label}>Planning baseline</label><input name="planningBaseline" type="number" defaultValue={c.planningBaseline} className={input} /></div>
                <div><label className={label}>Base target</label><input name="baseTarget" type="number" defaultValue={c.baseTarget} className={input} /></div>
                <div><label className={label}>Stretch target</label><input name="stretchTarget" type="number" defaultValue={c.stretchTarget} className={input} /></div>
                <div><label className={label}>Planning show-up rate (%)</label><input name="planningShowRate" type="number" step="0.1" defaultValue={Math.round(c.planningShowRate * 1000) / 10} className={input} /></div>
                <div><label className={label}>TAM (students)</label><input name="tamStudents" type="number" defaultValue={c.market.tamStudents} className={input} /></div>
                <div><label className={label}>SAM (students)</label><input name="samStudents" type="number" defaultValue={c.market.samStudents} className={input} /></div>
                <div><label className={label}>Base budget ceiling (₹)</label><input name="baseCeiling" type="number" defaultValue={c.budget.base.ceiling} className={input} /></div>
                <div><label className={label}>Stretch budget ceiling (₹)</label><input name="stretchCeiling" type="number" defaultValue={c.budget.stretch.ceiling} className={input} /></div>
              </div>
              <div className="rounded-lg border border-line p-3">
                <p className="mb-2 text-sm font-medium">Venue capacity (leave blank if not confirmed)</p>
                <div className="grid gap-3 md:grid-cols-3">
                  <div><label className={label}>Confirmed daily limit</label><input name="dailyLimit" type="number" min={1} defaultValue={c.capacity.dailyLimit ?? ""} className={input} /></div>
                  <div><label className={label}>Confirmed total limit</label><input name="totalLimit" type="number" min={1} defaultValue={c.capacity.totalLimit ?? ""} className={input} /></div>
                  <div><label className={label}>Confirmed by</label><input name="confirmedBy" defaultValue={c.capacity.confirmedBy ?? ""} className={input} /></div>
                </div>
              </div>
              <div>
                <p className="mb-2 text-sm font-medium">Scale / change / stop thresholds</p>
                <Table head={["Initiative", "Metric", "Scale at ≥", "Change from (stop below)"]} dense>
                  {Object.entries(c.thresholds).map(([k, t]) => (
                    <tr key={k}><Td className="text-xs font-medium">{k.replace(/_/g, " ")}</Td><Td className="text-xs">{t.metric}</Td>
                      <Td><input name={`th_${k}_scale`} type="number" defaultValue={t.scaleAt} className={`${inputInline} w-24`} aria-label={`${k} scale threshold`} /></Td>
                      <Td><input name={`th_${k}_change`} type="number" defaultValue={t.changeFrom} className={`${inputInline} w-24`} aria-label={`${k} change threshold`} /></Td></tr>
                  ))}
                </Table>
              </div>
              {isAdmin && <div className="flex items-end gap-2"><div className="flex-1"><label className={label}>Change note (required)</label><input name="note" required minLength={3} className={input} placeholder="What changed and why" /></div><button className={btnPrimary}>Save new version</button></div>}
            </fieldset>
            {!isAdmin && <p className="text-xs text-muted">Only admins can change Strategy & Targets.</p>}
          </ActionForm>
        </Card>
        <div className="space-y-4">
          <Card title="Summary">
            <ul className="space-y-1 text-sm">
              <li>Required growth: <b>{fmtInt(c.baseTarget - c.planningBaseline)}</b> base / <b>{fmtInt(c.stretchTarget - c.planningBaseline)}</b> stretch</li>
              <li>Base target = {fmtPct(c.baseTarget / c.market.samStudents)} of SAM; stretch = {fmtPct(c.stretchTarget / c.market.samStudents)}</li>
              <li>Budget ceilings: {fmtLakh(c.budget.base.ceiling)} base / {fmtLakh(c.budget.stretch.ceiling)} stretch</li>
              <li>Capacity: {c.capacity.dailyLimit ? `${fmtInt(c.capacity.dailyLimit)}/day (confirmed by ${c.capacity.confirmedBy ?? "–"})` : "not configured"}</li>
            </ul>
          </Card>
          <Card title="Version history">
            <ul className="space-y-2 text-sm">
              {data.history.map((h) => <li key={h.version}><b>v{h.version}</b> · {h.name ?? "system"} · {fmtDateTime(h.created_at)}<div className="text-xs text-muted">{h.change_note}</div></li>)}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
