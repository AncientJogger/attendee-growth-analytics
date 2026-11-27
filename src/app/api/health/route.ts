import { NextResponse } from "next/server";
import { withSystem, usingEmbeddedDb } from "@/lib/db";
import { pingAi } from "@/lib/ai/agent";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Open /api/health in a browser after deploying. The first call creates the tables and demo data
 * in an empty database (can take a while on a remote host); later calls answer straight away.
 * It reports only whether the database works, never connection details.
 */
/** With ?ai=1, also sends a one-word test message to the configured AI service and reports the result. */
const checkAi = pingAi;

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
