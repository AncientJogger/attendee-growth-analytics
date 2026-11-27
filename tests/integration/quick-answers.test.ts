// Instant answers: common questions are answered from the data tools with no model call.
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@/lib/db";
import { quickAnswer } from "@/lib/ai/quick";
import { actor } from "../helpers";

afterAll(() => closePool());

const ask = async (q: string, loose = false) => quickAnswer(q, { actor: await actor("admin@demo.fest"), threadId: null, proposals: [] }, { loose });

describe("instant answers", () => {
  it.each([
    ["Which campaigns have the best and worst cost per verified attendee?", "campaigns", /Best: Student Referrals/],
    ["Why is Paid Social underperforming, and what should we do about it?", "campaign_detail", /Paid Social[\s\S]*50\.0%/],
    ["What overdue tasks are blocking the Challenge Circuit and Paid Social work?", "tasks", /Audit Paid Social retargeting audiences/],
    ["Who has the highest workload and what is overdue?", "workload", /Arjun Verma/],
    ["Are we on track for 9,000 attendees?", "target", /cannot show progress/],
    ["What is the venue's confirmed daily capacity?", "capacity", /Not known/],
    ["How much sponsor revenue did the fest earn?", "out_of_scope", /cannot answer/],
    ["How many people attended the fest?", "attendance", /2,050 unique verified attendees/],
    ["Where is the biggest drop in the funnel?", "funnel", /biggest drop/],
    ["How much budget is left?", "budget", /remaining/],
    ["When did registrations peak?", "trends", /peaked/],
    ["Any results from the CrewPass experiment?", "experiments", /No results yet/],
    ["Is there any problem with the uploaded data?", "data", /Rejected rows/],
  ])("%s", async (q, intent, re) => {
    const r = await ask(q);
    expect(r?.intent).toBe(intent);
    expect(r?.text).toMatch(re);
    expect(r?.trace.length).toBeGreaterThan(intent === "out_of_scope" ? -1 : 0);
  });

  it("leaves drafting and open-ended questions to the AI", async () => {
    expect(await ask("Draft a task for Nisha to finish the opt-out export by Friday")).toBeNull();
    expect(await ask("What should our Instagram caption say?")).toBeNull();
  });

  it("still gives a data answer when the AI has failed", async () => {
    const r = await ask("What should our Instagram caption say?", true);
    expect(r?.intent).toBe("overview");
  });
});
