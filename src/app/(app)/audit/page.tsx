import { pageData } from "@/lib/page";
import { Card, Notice, PageHeader, Table, Td } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export default async function AuditPage() {
  const { s, data } = await pageData(undefined, (q, _c, s) => q<{ id: number; created_at: Date; actor_kind: string; name: string | null; action: string; entity: string; entity_id: string | null; before: unknown; after: unknown; reason: string | null }>(
    "select a.*, u.display_name name from audit_logs a left join app_users u on u.id = a.actor_user_id where a.workspace_id = $1 order by a.id desc limit 300", [s.workspaceId]));
  if (s.role !== "admin") return <><PageHeader title="Audit log" /><Notice kind="info">Only admins can view the full audit log. Task pages show each task&apos;s own history.</Notice></>;
  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only record of every change, proposal and decision (latest 300). Rows cannot be edited or deleted, including by a workspace reset." />
      <Card>
        <Table head={["When", "Who", "Action", "Entity", "Reason", "Details"]} dense>
          {data.map((a) => (
            <tr key={a.id}>
              <Td className="whitespace-nowrap text-xs">{fmtDateTime(a.created_at)}</Td>
              <Td className="text-xs">{a.name ?? a.actor_kind}{a.actor_kind === "ai" && " (AI)"}</Td>
              <Td className="text-xs font-medium">{a.action}</Td>
              <Td className="text-xs">{a.entity} <span className="font-mono text-muted">{a.entity_id?.slice(0, 8)}</span></Td>
              <Td className="max-w-64 text-xs text-muted">{a.reason}</Td>
              <Td className="text-xs"><details><summary className="cursor-pointer text-brand">view</summary><pre className="mt-1 max-w-xl overflow-x-auto whitespace-pre-wrap rounded bg-[#f4f6fa] p-2 text-[11px]">{JSON.stringify({ before: a.before, after: a.after }, null, 2)}</pre></details></Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
