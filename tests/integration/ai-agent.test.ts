// Tests the agent loop and tools with a scripted stand-in for the model. This checks the
// plumbing (tool dispatch, permissions, approvals, re-querying), not the model's judgement;
// tests/ai-evals/run.ts evaluates the real model when ANTHROPIC_API_KEY is set.
import { afterAll, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { closePool, withSystem, withUser } from "@/lib/db";
import { runAgent } from "@/lib/ai/agent";
import { runTool } from "@/lib/ai/tools";
import { listTasks } from "@/lib/analytics/management";
import { actor, WS } from "../helpers";

afterAll(() => closePool());

function scripted(steps: { tools?: { name: string; input: unknown }[]; text?: string }[]) {
  let i = 0;
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const create = async (args: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
    seen.push(JSON.parse(JSON.stringify(args)));
    const s = steps[Math.min(i++, steps.length - 1)];
    const content: Anthropic.ContentBlock[] = [];
    if (s.text) content.push({ type: "text", text: s.text, citations: null } as Anthropic.TextBlock);
    (s.tools ?? []).forEach((t, k) => content.push({ type: "tool_use", id: `tu_${i}_${k}`, name: t.name, input: t.input } as Anthropic.ToolUseBlock));
    return { id: "m", type: "message", role: "assistant", model: "test", content, stop_reason: s.tools?.length ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } as unknown as Anthropic.Message;
  };
  return { create, seen };
}

describe("AI tools", () => {
  it("answer from current data and report missing fields", async () => {
    const admin = await actor("admin@demo.fest");
    const tc = { actor: admin, threadId: null, proposals: [] as string[] };
    const prof = await runTool("get_dataset_profile", {}, tc);
    expect(prof.ok).toBe(true);
    const cmp = await runTool("compare_campaigns", { metric: "cost_per_verified_attendee" }, tc);
    const ranking = (cmp.result as { ranking: { campaign: string }[] }).ranking;
    expect(ranking[0].campaign).toBe("Student Referrals");
    expect(ranking.at(-1)!.campaign).toBe("Creator Partners");
    const cap = await runTool("get_capacity_status", {}, tc);
    expect((cap.result as { configured: boolean }).configured).toBe(false);
    const bad = await runTool("get_campaign_performance", { campaigns: ["Nonexistent Campaign"] }, tc);
    expect(bad.ok).toBe(false);
    const invalid = await runTool("compare_campaigns", { metric: "vibes" }, tc);
    expect(invalid.ok).toBe(false);
  });

  it("never returns attendee names", async () => {
    const admin = await actor("admin@demo.fest");
    const tc = { actor: admin, threadId: null, proposals: [] as string[] };
    const [p] = await withSystem((q) => q<{ display_name: string }>("select display_name from people where display_name is not null limit 1"));
    for (const name of ["get_overview_metrics", "get_attendance_metrics", "get_funnel_metrics", "get_campaign_performance", "get_attribution", "get_data_quality_report"]) {
      const out = JSON.stringify((await runTool(name, {}, tc)).result);
      expect(out.includes(p.display_name)).toBe(false);
    }
  });
});

describe("agent loop", () => {
  it("runs tools, drafts a task for approval and never creates it directly", async () => {
    const admin = await actor("admin@demo.fest");
    const before = (await withUser(admin, (q) => listTasks(q, WS))).length;
    const { create } = scripted([
      { tools: [{ name: "get_campaign_performance", input: { campaigns: ["Paid Social"] } }, { name: "get_overdue_tasks", input: { campaign: "Paid Social" } }] },
      { tools: [{ name: "list_team_members", input: {} }] },
      { tools: [{ name: "draft_task", input: { title: "Cut Paid Social prospecting to retargeting", owner: "Arjun Verma", campaign: "Paid Social", due_date: "2026-12-05", priority: "high", rationale: "Show-up 50% vs portfolio 69%" } }] },
      { text: "**Answer** Paid Social is weak. I drafted a task for approval." },
    ]);
    const res = await runAgent({ actor: admin, threadId: null, history: [], message: "Why is Paid Social weak?", system: "test", create });
    expect(res.trace.map((t) => t.tool)).toEqual(["get_campaign_performance", "get_overdue_tasks", "list_team_members", "draft_task"]);
    expect(res.trace.every((t) => t.ok)).toBe(true);
    expect(res.proposals.length).toBe(1);
    expect((await withUser(admin, (q) => listTasks(q, WS))).length).toBe(before);
    const [a] = await withSystem((q) => q<{ status: string; proposed_by_kind: string }>("select status, proposed_by_kind from approvals where id = $1", [res.proposals[0]]));
    expect(a).toEqual({ status: "pending", proposed_by_kind: "ai" });
  });

  it("sends only prior text on follow-ups, so values are re-queried", async () => {
    const admin = await actor("admin@demo.fest");
    const s = scripted([{ tools: [{ name: "get_attendance_metrics", input: {} }] }, { text: "2,050" }]);
    await runAgent({ actor: admin, threadId: null, history: [{ role: "user", text: "How many attended?" }, { role: "assistant", text: "Earlier answer: 2,050" }], message: "And now?", system: "sys", create: s.create });
    const first = s.seen[0];
    expect(first.messages.length).toBe(3);
    expect(first.messages.every((m) => typeof m.content === "string")).toBe(true);
  });

  it("tool errors and permissions come back to the model as errors", async () => {
    const dev = await actor("dev@demo.fest");
    const s = scripted([{ tools: [{ name: "submit_change_for_approval", input: { kind: "budget_change", target_id: "00000000-0000-0000-0000-000000000000", changes: { approved_inr: 1 }, rationale: "x" } }] }, { text: "done" }]);
    const res = await runAgent({ actor: dev, threadId: null, history: [], message: "raise budget", system: "sys", create: s.create });
    expect(res.trace[0].ok).toBe(false);
  });

  it("stops after the maximum number of tool rounds", async () => {
    const admin = await actor("admin@demo.fest");
    const s = scripted([{ tools: [{ name: "get_team_workload", input: {} }] }]);
    const res = await runAgent({ actor: admin, threadId: null, history: [], message: "loop", system: "sys", create: s.create });
    expect(res.text).toMatch(/maximum number of data lookups/);
  });
});
