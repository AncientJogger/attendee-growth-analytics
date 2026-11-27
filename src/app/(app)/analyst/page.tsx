import { pageData } from "@/lib/page";
import { aiConfigured, modelName } from "@/lib/ai/agent";
import { TOOLS } from "@/lib/ai/tools";
import { PageHeader } from "@/components/ui";
import { AnalystChat } from "@/components/analyst-chat";
import { decideAction } from "@/app/actions";

export default async function AnalystPage({ searchParams }: PageProps<"/analyst">) {
  const sp = await searchParams;
  const { s, ctx, data } = await pageData(undefined, (q, _c, s) => q<{ id: string; name: string }>("select id, display_name name from app_users where workspace_id = $1 order by display_name", [s.workspaceId]));
  const configured = aiConfigured();
  return (
    <>
      <PageHeader title="AI Growth Analyst"
        subtitle={<>Ask in plain language. The analyst answers only from tool calls against <b>{ctx?.label ?? "the active dataset"}</b> and the workspace records, tags each figure as observed, calculated or estimated, says when the data cannot answer, and drafts tasks or changes for your approval. It never applies a change itself.{configured && <span className="text-xs"> Model: {modelName()}.</span>}</>} />
      <AnalystChat configured={configured} users={data} canDecide={s.role !== "team_member"} decide={decideAction} initialQuestion={typeof sp.q === "string" ? sp.q : undefined}
        readTools={TOOLS.filter((t) => !["draft_task", "submit_change_for_approval"].includes(t.name)).map((t) => ({ name: t.name, description: t.description }))} />
    </>
  );
}
