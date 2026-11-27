import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { withSystem, usingEmbeddedDb } from "@/lib/db";
import { modelName } from "@/lib/ai/agent";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Open /api/health in a browser after deploying. The first call creates the tables and demo data
 * in an empty database (can take a while on a remote host); later calls answer straight away.
 * It reports only whether the database works, never connection details.
 */
/** With ?ai=1, also sends a one-word test message to the AI provider and reports the result. */
async function checkAi() {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return { ok: false, error: "ANTHROPIC_API_KEY is not set in this deployment. Add it in Vercel and redeploy." };
  if (!key.startsWith("sk-ant-")) return { ok: false, error: "ANTHROPIC_API_KEY does not start with sk-ant-. Check you pasted the whole key, with no quotes or spaces." };
  const t = Date.now();
  try {
    const r = await new Anthropic({ apiKey: key }).messages.create({ model: modelName(), max_tokens: 5, messages: [{ role: "user", content: "Reply with: ok" }] });
    return { ok: true, model: modelName(), ms: Date.now() - t, reply: r.content.find((c) => c.type === "text")?.text ?? "" };
  } catch (e) {
    return { ok: false, model: modelName(), error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}

export async function GET(req: Request) {
  const t = Date.now();
  const ai = new URL(req.url).searchParams.get("ai") ? await checkAi() : undefined;
  try {
    const [r] = await withSystem((q) => q<{ users: string; workspaces: string }>("select (select count(*) from app_users) users, (select count(*) from workspaces) workspaces"));
    return NextResponse.json(
      { ok: true, database: usingEmbeddedDb() ? "built-in demo database" : "external Postgres", users: Number(r.users), workspaces: Number(r.workspaces), ms: Date.now() - t, ai },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[health] database check failed:", message);
    return NextResponse.json({ ok: false, error: message.slice(0, 300), ms: Date.now() - t, ai }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
