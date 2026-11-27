import { cachedPage } from "@/lib/cache";
import Link from "next/link";
import { pageData } from "@/lib/page";
import { taskMetrics } from "@/lib/analytics/management";
import { Card, PageHeader, Table, Td } from "@/components/ui";
import { ROLE_LABEL } from "@/lib/auth";

export default async function TeamPage() {
  const { data } = await cachedPage(["team"], () => pageData(undefined, async (q, _ctx, s) => ({
    users: await q<{ id: string; display_name: string; role: keyof typeof ROLE_LABEL; title: string | null; initiatives: string[]; campaigns: string[] }>(
      `select u.id, u.display_name, u.role, tm.title,
         coalesce((select json_agg(i.name order by i.name) from initiative_assignments ia join initiatives i on i.id = ia.initiative_id where ia.user_id = u.id), '[]') initiatives,
         coalesce((select json_agg(c.name order by c.name) from campaigns c join workspaces w on w.active_dataset_version_id = c.dataset_version_id where c.owner_team_member_id = u.team_member_id), '[]') campaigns
       from app_users u left join team_members tm on tm.id = u.team_member_id where u.workspace_id = $1 order by u.role, u.display_name`, [s.workspaceId]),
    m: await taskMetrics(q, s.workspaceId),
  })));
  const w = new Map(data.m.workload.map((x) => [x.ownerId, x]));
  const maxEffort = Math.max(1, ...data.m.workload.map((x) => x.openEffortHours));
  return (
    <>
      <PageHeader title="Team" subtitle="Who owns what, and how loaded each person is. Workload counts open tasks only." />
      <Card note={data.m.definitions.join(" ")}>
        <Table head={["Person", "Role", "Initiatives", "Campaigns owned (active dataset)", "Open tasks", "Overdue", "Blocked", "Open effort (h)"]}>
          {data.users.map((u) => {
            const x = w.get(u.id);
            return (
              <tr key={u.id}>
                <Td><Link href={`/tasks?owner=${u.id}`} className="font-medium text-brand hover:underline">{u.display_name}</Link><div className="text-xs text-muted">{u.title}</div></Td>
                <Td>{ROLE_LABEL[u.role]}</Td>
                <Td className="text-xs">{u.initiatives.join(", ") || "–"}</Td>
                <Td className="text-xs">{u.campaigns.join(", ") || "–"}</Td>
                <Td className="tabular-nums">{x?.open ?? 0}</Td>
                <Td className={`tabular-nums ${x?.overdue ? "font-medium text-bad" : ""}`}>{x?.overdue ?? 0}</Td>
                <Td className="tabular-nums">{x?.blocked ?? 0}</Td>
                <Td><div className="flex items-center gap-2"><span className="w-10 tabular-nums">{x?.openEffortHours ?? 0}</span><div className="h-2 w-32 rounded-full bg-brand-soft"><div className="h-2 rounded-full bg-brand" style={{ width: `${((x?.openEffortHours ?? 0) / maxEffort) * 100}%` }} /></div></div></Td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}
