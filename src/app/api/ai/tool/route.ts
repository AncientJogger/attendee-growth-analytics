import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { runTool, TOOLS } from "@/lib/ai/tools";

export const runtime = "nodejs";

// Lets people run the analyst's read-only tools directly (no model involved). Useful when the
// AI is not configured, and for checking exactly what data the AI sees.
const READ_ONLY = TOOLS.map((t) => t.name).filter((n) => !["draft_task", "submit_change_for_approval"].includes(n));
const body = z.object({ tool: z.enum(READ_ONLY as [string, ...string[]]), input: z.record(z.string(), z.unknown()).default({}) });

export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const parsed = body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Unknown or write tool." }, { status: 400 });
  const out = await runTool(parsed.data.tool, parsed.data.input, { actor: s, threadId: null, proposals: [] });
  return NextResponse.json(out, { status: out.ok ? 200 : 400 });
}
