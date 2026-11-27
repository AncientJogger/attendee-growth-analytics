"use client";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApprovalCard } from "./approval-card";
import type { ApprovalView } from "@/lib/approvals-view";

type Trace = { tool: string; input: unknown; ok: boolean; ms: number; result: unknown };
type Msg = { role: "user" | "assistant"; text: string; trace?: Trace[]; approvals?: ApprovalView[]; error?: boolean };

const SUGGESTIONS = [
  "Which campaigns have the best and worst cost per verified attendee?",
  "Why is Paid Social underperforming, and what should we do about it?",
  "What overdue tasks are blocking the Challenge Circuit and Paid Social work?",
  "Who has the highest workload and what is overdue?",
  "Are we on track for 9,000 attendees?",
  "What is the venue's confirmed daily capacity?",
  "How much sponsor revenue did the fest earn?",
];

const TAG = /\[(Observed|Calculated|Estimated|Recommended|HYPOTHETICAL)\]/g;
const TAG_CLASS: Record<string, string> = { Observed: "bg-brand-soft text-brand", Calculated: "bg-[#eef6f7] text-[#0f6470]", Estimated: "bg-warn-soft text-warn", Recommended: "bg-[#f3effb] text-[#5b3aa3]", HYPOTHETICAL: "bg-bad-soft text-bad" };

function withTags(children: React.ReactNode): React.ReactNode {
  if (typeof children === "string") {
    const parts = children.split(TAG);
    return parts.map((p, i) => (i % 2 === 1 ? <span key={i} className={`mr-1 rounded px-1 py-0.5 text-[10px] font-semibold uppercase ${TAG_CLASS[p]}`}>{p}</span> : p));
  }
  if (Array.isArray(children)) return children.map((c, i) => <span key={i}>{withTags(c)}</span>);
  return children;
}

export function AnalystChat({ configured, users, canDecide, decide, initialQuestion, readTools }: {
  configured: boolean; users: { id: string; name: string }[]; canDecide: boolean; initialQuestion?: string; readTools: { name: string; description: string }[];
  decide: (fd: FormData) => Promise<{ ok: boolean; error?: string; message?: string }>;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [text, setText] = useState(initialQuestion ?? "");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  // Braces matter: newer browsers return a Promise from scrollIntoView, and React would treat a returned
  // value as a cleanup function and crash the page.
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  const send = async (q: string) => {
    if (!q.trim() || busy) return;
    setMsgs((m) => [...m, { role: "user", text: q }]);
    setText("");
    setBusy(true);
    try {
      const r = await fetch("/api/ai/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, message: q }) });
      const j = await r.json().catch(() => ({ error: r.status === 504 ? "The answer took too long and the server stopped it. Try a narrower question, or check the database region (see /api/health)." : `The server returned an error (${r.status}). Open /api/health?ai=1 to see why.` }));
      if (j.threadId) setThreadId(j.threadId);
      setMsgs((m) => [...m, r.ok ? { role: "assistant", text: j.text, trace: j.trace, approvals: j.approvals } : { role: "assistant", text: j.error ?? "Request failed.", error: true }]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", text: "Network error.", error: true }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <div className="flex min-h-[70vh] flex-col rounded-xl border border-line bg-white">
        <div className="flex items-center justify-between border-b border-line px-4 py-2 text-xs text-muted">
          <span>{configured ? "Answers come from tool calls against the current data. Proposals need approval." : "AI unavailable on this deployment"}</span>
          <button className="text-brand" onClick={() => { setMsgs([]); setThreadId(null); }}>New conversation</button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
          {!configured && (
            <div className="rounded-lg border border-warn/30 bg-warn-soft p-4 text-sm text-[#7a3d06]">
              <b>AI unavailable.</b> The server has no <code>ANTHROPIC_API_KEY</code>, so no model can answer questions here. Nothing on this page pretends otherwise. You can still run every read-only analytics tool from the panel on the right; these are the same functions the AI calls.
            </div>
          )}
          {msgs.length === 0 && configured && (
            <div>
              <p className="mb-2 text-sm text-muted">Try a question:</p>
              <div className="flex flex-wrap gap-2">{SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-line px-3 py-1 text-xs text-ink-2 hover:bg-brand-soft">{s}</button>)}</div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
              {m.role === "user" ? (
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-brand px-4 py-2 text-sm text-white">{m.text}</div>
              ) : (
                <div className="max-w-full space-y-3">
                  <div className={`prose-ai rounded-2xl rounded-bl-sm border px-4 py-3 text-sm ${m.error ? "border-bad/30 bg-bad-soft text-bad" : "border-line bg-[#fbfcfe]"}`}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ li: ({ children }) => <li>{withTags(children)}</li>, p: ({ children }) => <p>{withTags(children)}</p> }}>{m.text}</ReactMarkdown>
                  </div>
                  {m.approvals?.map((a) => <ApprovalCard key={a.id} a={a} users={users} canDecide={canDecide} decide={decide} />)}
                  {m.trace && m.trace.length > 0 && (
                    <details className="text-xs text-muted">
                      <summary className="cursor-pointer">How this was answered: {m.trace.length} data lookup{m.trace.length > 1 ? "s" : ""} ({m.trace.map((t) => t.tool).join(", ")})</summary>
                      <ol className="mt-2 space-y-2">
                        {m.trace.map((t, k) => (
                          <li key={k} className="rounded border border-line bg-white p-2">
                            <div><b className={t.ok ? "text-ink" : "text-bad"}>{t.tool}</b> · {t.ms} ms · input <code>{JSON.stringify(t.input)}</code></div>
                            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[10px]">{JSON.stringify(t.result, null, 1).slice(0, 4000)}</pre>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && <p className="text-sm text-muted">Querying the data…</p>}
          <div ref={end} />
        </div>
        <form className="flex gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); send(text); }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} disabled={!configured || busy} rows={2} placeholder={configured ? "Ask about attendance, campaigns, tasks, budget…" : "AI unavailable"}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }}
            className="flex-1 resize-none rounded-lg border border-line px-3 py-2 text-sm" aria-label="Question for the AI analyst" />
          <button disabled={!configured || busy || !text.trim()} className="rounded-lg bg-brand px-4 text-sm font-medium text-white disabled:opacity-50">Ask</button>
        </form>
      </div>
      <ToolPanel tools={readTools} />
    </div>
  );
}

function ToolPanel({ tools }: { tools: { name: string; description: string }[] }) {
  const [tool, setTool] = useState(tools[0]?.name ?? "");
  const [input, setInput] = useState("{}");
  const [out, setOut] = useState<string>("");
  const [busy, setBusy] = useState(false);
  return (
    <aside className="rounded-xl border border-line bg-white p-4 text-sm">
      <h2 className="font-semibold">Run a data tool directly</h2>
      <p className="mt-1 text-xs text-muted">No AI involved: these are the exact functions the analyst calls, run with your permissions.</p>
      <select className="mt-3 w-full rounded border border-line px-2 py-1 text-xs" value={tool} onChange={(e) => setTool(e.target.value)} aria-label="Tool">
        {tools.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
      </select>
      <p className="mt-1 text-xs text-muted">{tools.find((t) => t.name === tool)?.description}</p>
      <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={2} className="mt-2 w-full rounded border border-line px-2 py-1 font-mono text-xs" aria-label="Tool input as JSON" />
      <button disabled={busy} className="mt-2 rounded-lg border border-line px-3 py-1 text-xs font-medium hover:bg-brand-soft" onClick={async () => {
        setBusy(true);
        let parsed: unknown = {};
        try { parsed = JSON.parse(input || "{}"); } catch { setOut("Input must be JSON, e.g. {\"metric\":\"show_up_rate\"}"); setBusy(false); return; }
        const r = await fetch("/api/ai/tool", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool, input: parsed }) });
        setOut(JSON.stringify(await r.json(), null, 1)); setBusy(false);
      }}>{busy ? "Running…" : "Run"}</button>
      {out && <pre className="mt-2 max-h-[50vh] overflow-auto whitespace-pre-wrap rounded bg-[#f4f6fa] p-2 text-[10px]">{out}</pre>}
    </aside>
  );
}
