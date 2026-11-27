import { pageData } from "@/lib/page";
import { Badge, Card, Notice, PageHeader, Table, Td, btn } from "@/components/ui";
import { ActionForm } from "@/components/client";
import { ImportWizard } from "@/components/import-wizard";
import { restoreDemoAction, setActiveDatasetAction } from "@/app/actions";
import { fmtDateTime, fmtInt } from "@/lib/format";

export default async function DatasetsPage() {
  const { s, ctx, data } = await pageData(undefined, (q, _c, s) => q<{ id: string; label: string; source_filename: string; uploaded_at: Date; status: string; is_demo: boolean; row_counts: Record<string, { imported: number; duplicatesRemoved: number; rejected: number }>; quality: { warnings?: string[]; rejected?: number; capabilities?: Record<string, boolean> }; notes: string | null; name: string | null }>(
    "select dv.*, u.display_name name from dataset_versions dv left join app_users u on u.id = dv.uploaded_by where dv.workspace_id = $1 order by dv.uploaded_at desc", [s.workspaceId]));
  const isAdmin = s.role === "admin";
  return (
    <>
      <PageHeader title="Dataset Manager" subtitle="Each import is a separate version. The active version powers every dashboard and the AI analyst. Switching versions changes their scope immediately." />
      {ctx && <div className="mb-4"><Notice kind="info">Active: <b>{ctx.label}</b>. {ctx.warnings.length ? `Warnings: ${ctx.warnings.join(" ")}` : "No import warnings."}</Notice></div>}
      <Card className="mb-6" title="Versions" actions={isAdmin && (
        <ActionForm action={async () => { "use server"; return restoreDemoAction(); }} success="Restored">
          <button className={btn} title="Re-activates the original supplied dataset and restores default planning assumptions. Audit history and other versions are kept.">Restore demo state</button>
        </ActionForm>
      )}>
        <Table head={["Version", "File", "Uploaded", "Status", "Rows imported", "Duplicates removed", "Rejected", ""]}>
          {data.map((v) => {
            const counts = Object.values(v.row_counts ?? {});
            return (
              <tr key={v.id}>
                <Td><span className="font-medium">{v.label}</span>{v.id === ctx?.dv && <> <Badge kind="healthy">Active</Badge></>}{v.is_demo && <> <Badge>Original demo</Badge></>}
                  {v.quality?.warnings?.length ? <div className="mt-1 text-xs text-warn">{v.quality.warnings.length} warning(s)</div> : null}
                  {v.notes && <div className="mt-1 text-xs text-bad">{v.notes}</div>}</Td>
                <Td className="text-xs">{v.source_filename}</Td>
                <Td className="text-xs">{fmtDateTime(v.uploaded_at)} · {v.name ?? "system"}</Td>
                <Td><Badge kind={v.status === "ready" ? "healthy" : v.status === "failed" ? "critical" : "attention"}>{v.status}</Badge></Td>
                <Td className="tabular-nums">{fmtInt(counts.reduce((a, c) => a + c.imported, 0))}</Td>
                <Td className="tabular-nums">{fmtInt(counts.reduce((a, c) => a + c.duplicatesRemoved, 0))}</Td>
                <Td className="tabular-nums">{fmtInt(v.quality?.rejected ?? 0)}</Td>
                <Td>{isAdmin && v.status === "ready" && v.id !== ctx?.dv && (
                  <ActionForm action={setActiveDatasetAction} success="Switched"><input type="hidden" name="datasetVersionId" value={v.id} /><button className={btn}>Make active</button></ActionForm>
                )}</Td>
              </tr>
            );
          })}
        </Table>
      </Card>
      {isAdmin ? (
        <>
          <h2 className="mb-2 text-sm font-semibold">Import a dataset</h2>
          <ImportWizard />
        </>
      ) : <Notice kind="info">Only admins can import or switch datasets.</Notice>}
    </>
  );
}
