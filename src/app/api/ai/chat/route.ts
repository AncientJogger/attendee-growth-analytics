import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession, ROLE_LABEL } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { aiConfigured, explainAiError, keyName, runAgent, systemPrompt } from "@/lib/ai/agent";
import { getDatasetContext, todayIn } from "@/lib/analytics/context";
import { loadApprovals } from "@/lib/approvals-view";
import { quickAnswer } from "@/lib/ai/quick";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Longest the AI may take before the data-only answer is used instead (AI_TOTAL_TIMEOUT_MS overrides). */
const aiBudget = () => Number(process.env.AI_TOTAL_TIMEOUT_MS) || 45_000;

const body = z.object({ forceAi: z.boolean().optional(), threadId: z.string().uuid().nullable().optional(), message: z.string().trim().min(1).max(4000), asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() });

export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const parsed = body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const { message, asOfDate, forceAi } = parsed.data;
  const hasAi = aiConfigured();

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
      const tc = { actor: s, threadId, defaultAsOfDate: asOfDate ?? null, proposals: [] as string[] };
      const finish = async (text: string, trace: unknown[], proposals: string[], mode: "instant" | "ai" | "fallback", note?: string) => {
        const approvals = await withUser(s, async (q) => {
          await q("insert into ai_messages (workspace_id, thread_id, role, content, trace) values ($1,$2,'assistant',$3,$4)",
            [s.workspaceId, threadId, JSON.stringify({ text, proposals, mode }), JSON.stringify(trace)]);
          return proposals.length ? loadApprovals(q, s.workspaceId, { ids: proposals }) : [];
        });
        send({ type: "done", threadId, text, trace, approvals, mode, note, canAskAi: hasAi && mode !== "ai" });
      };
      try {
        // 1. Instant: known question types are answered straight from the data (no model call).
        if (!forceAi || !hasAi) {
          send({ type: "step", kind: "instant" });
          const quick = await quickAnswer(message, tc, { loose: !hasAi }).catch((e) => { console.error(e); return null; });
          if (quick) return await finish(quick.text, quick.trace, [], "instant");
          if (!hasAi) return send({ type: "error", threadId, error: `This question needs the AI, and no AI key is configured on the server (${keyName(null)}). Try one of the suggested questions, which are answered straight from the data.` });
        }
        // 2. The AI, with an overall time limit.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`AI_TOTAL_TIMEOUT did not reply within ${Math.round(aiBudget() / 1000)} s`)), aiBudget()); });
        try {
          const res = await Promise.race([runAgent({
            actor: s, threadId, history, message, defaultAsOfDate: asOfDate ?? null,
            system: systemPrompt({ userName: s.name, role: ROLE_LABEL[s.role], today: todayIn(330), datasetLabel: ctx?.label ?? null,
              datasetPeriod: ctx?.event?.historyStart ? `${ctx.event.historyStart} to ${ctx.event.historyEnd} (default as-of ${ctx.asOfDate})` : null }),
            onStep: (step) => send({ type: "step", ...step }),
          }), timeout]);
          await finish(res.text, res.trace, res.proposals, "ai");
        } catch (e) {
          console.error(e);
          // 3. The AI failed or was too slow: give the closest answer the data supports instead of an error.
          const why = explainAiError(e);
          const quick = await quickAnswer(message, tc, { loose: true }).catch(() => null);
          if (quick) await finish(quick.text, quick.trace, [], "fallback", why);
          else send({ type: "error", threadId, error: why });
        } finally {
          clearTimeout(timer);
        }
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
