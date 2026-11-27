import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession, ROLE_LABEL } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { aiConfigured, explainAiError, keyName, runAgent, systemPrompt } from "@/lib/ai/agent";
import { getDatasetContext, todayIn } from "@/lib/analytics/context";
import { loadApprovals } from "@/lib/approvals-view";

export const runtime = "nodejs";
export const maxDuration = 300;

const body = z.object({ threadId: z.string().uuid().nullable().optional(), message: z.string().trim().min(1).max(4000), asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() });

export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!aiConfigured()) return NextResponse.json({ error: `AI unavailable: no AI key is configured on the server (${keyName(null)}). The analytics tools still work from the panel on this page.` }, { status: 503 });
  const parsed = body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const { message, asOfDate } = parsed.data;

  const { threadId, history, ctx } = await withUser(s, async (q) => {
    let threadId = parsed.data.threadId ?? null;
    if (threadId && !(await q("select 1 from ai_threads where id = $1", [threadId])).length) threadId = null;
    if (!threadId) [{ id: threadId }] = await q<{ id: string }>("insert into ai_threads (workspace_id, user_id, title) values ($1,$2,$3) returning id", [s.workspaceId, s.userId, message.slice(0, 80)]);
    const history = await q<{ role: "user" | "assistant"; content: { text: string } }>("select role, content from ai_messages where thread_id = $1 order by created_at", [threadId]);
    await q("insert into ai_messages (workspace_id, thread_id, role, content) values ($1,$2,'user',$3)", [s.workspaceId, threadId, JSON.stringify({ text: message })]);
    const ctx = await getDatasetContext(q, s.workspaceId, { asOfDate });
    return { threadId: threadId!, history: history.map((h) => ({ role: h.role, text: h.content.text })), ctx };
  });

  // Stream newline-delimited JSON: progress steps while the analyst works, then the answer.
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      send({ type: "start", threadId });
      try {
        const res = await runAgent({
          actor: s, threadId, history, message, defaultAsOfDate: asOfDate ?? null,
          system: systemPrompt({ userName: s.name, role: ROLE_LABEL[s.role], today: todayIn(330), datasetLabel: ctx?.label ?? null,
            datasetPeriod: ctx?.event?.historyStart ? `${ctx.event.historyStart} to ${ctx.event.historyEnd} (default as-of ${ctx.asOfDate})` : null }),
          onStep: (step) => send({ type: "step", ...step }),
        });
        const approvals = await withUser(s, async (q) => {
          await q("insert into ai_messages (workspace_id, thread_id, role, content, trace) values ($1,$2,'assistant',$3,$4)",
            [s.workspaceId, threadId, JSON.stringify({ text: res.text, proposals: res.proposals }), JSON.stringify(res.trace)]);
          return res.proposals.length ? loadApprovals(q, s.workspaceId, { ids: res.proposals }) : [];
        });
        send({ type: "done", threadId, text: res.text, trace: res.trace, approvals });
      } catch (e) {
        console.error(e);
        send({ type: "error", threadId, error: explainAiError(e) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
