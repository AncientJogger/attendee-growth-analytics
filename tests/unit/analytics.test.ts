import { describe, expect, it, afterAll } from "vitest";
import expected from "../fixtures/expected-metrics.json";
import { withUser, closePool } from "@/lib/db";
import { attendanceMetrics, campaignPerformance, funnelMetrics, registrationMetrics, targetsVsActual, attributionViews, compareRanges, weeklyTrend } from "@/lib/analytics/metrics";
import { budgetSummary, forecastAttendance, capacityStatus, taskMetrics } from "@/lib/analytics/management";
import { actor, ctxFor, WS } from "../helpers";

afterAll(() => closePool());

describe("dataset import", () => {
  it("imports every sheet with the documented duplicate removal", async () => {
    const ctx = (await ctxFor())!;
    expect(ctx.rowCounts.check_ins.duplicatesRemoved).toBe(expected.dedup_rows_removed["Check-ins"]);
    expect(ctx.rowCounts.registration_history.duplicatesRemoved).toBe(expected.dedup_rows_removed["Registration History"]);
    expect(ctx.rowCounts.campaign_daily.duplicatesRemoved).toBe(expected.dedup_rows_removed["Daily Marketing"]);
    expect(ctx.rowCounts.people.imported).toBe(expected.people_total);
    expect(ctx.rejected).toBe(0);
    expect(ctx.asOfDate).toBe("2025-04-20");
  });
});

describe("north star and funnel", () => {
  it("counts unique verified external attendees once across both days", async () => {
    const ctx = (await ctxFor())!;
    const a = await withUser(await actor("admin@demo.fest"), (q) => attendanceMetrics(q, ctx));
    if (!a.available) throw new Error("expected attendance");
    expect(a.uniqueVerifiedAttendees).toBe(expected.unique_verified_external_attendees);
    expect(a.attendedMultipleDays).toBe(expected.attendees_both_days);
    expect(a.walkInsWithoutRegistration).toBe(expected.walk_in_attendees_without_registration);
    expect(Object.fromEntries(a.byDay.map((d) => [d.day, d.uniquePeople]))).toEqual(expected.verified_external_attendees_by_day);
  });

  it("uses the latest status version per registration", async () => {
    const ctx = (await ctxFor())!;
    const r = await withUser(await actor("admin@demo.fest"), (q) => registrationMetrics(q, ctx));
    if (!r.available) throw new Error("expected registrations");
    expect(r.registeredPeople).toBe(expected.registered_external_people);
    expect(r.latestStatus).toEqual(expected.latest_status_external);
  });

  it("respects the as-of date (no later outcome in an earlier snapshot)", async () => {
    const ctx = (await ctxFor("admin@demo.fest", "2025-03-01"))!;
    const a = await withUser(await actor("admin@demo.fest"), (q) => attendanceMetrics(q, ctx));
    expect(a.available && a.uniqueVerifiedAttendees).toBe(0);
    const f = await withUser(await actor("admin@demo.fest"), (q) => funnelMetrics(q, ctx));
    expect(f.stages.find((s) => s.key === "registered")!.value!).toBeLessThan(expected.registered_external_people);
  });

  it("builds a funnel with labelled denominators", async () => {
    const ctx = (await ctxFor())!;
    const f = await withUser(await actor("admin@demo.fest"), (q) => funnelMetrics(q, ctx));
    expect(f.stages.map((s) => s.key)).toEqual(["identified", "engaged", "registered", "confirmed", "attended"]);
    expect(f.stages[0].value).toBe(expected.identified_external_people);
    expect(f.anonymous?.impressions).toBeGreaterThan(0);
  });
});

describe("campaigns, attribution, targets, trends", () => {
  it("matches per-campaign spend, registrations, attendees and show-up", async () => {
    const ctx = (await ctxFor())!;
    const { rows } = await withUser(await actor("admin@demo.fest"), (q) => campaignPerformance(q, ctx));
    for (const r of rows) {
      const e = (expected.per_campaign as Record<string, { spend_inr: number; registered_people: number; verified_attendees_from_registrations: number; first_touch_identified_people: number }>)[r.sourceId];
      expect(r.spend).toBe(e.spend_inr);
      expect(r.registeredPeople).toBe(e.registered_people);
      expect(r.verifiedAttendees).toBe(e.verified_attendees_from_registrations);
      expect(r.firstTouchPeople).toBe(e.first_touch_identified_people);
    }
    const paid = rows.find((r) => r.sourceId === "C02")!;
    // Filtering to one campaign must not change portfolio-relative health.
    const one = await withUser(await actor("admin@demo.fest"), (q) => campaignPerformance(q, ctx, { campaignIds: [paid.id] }));
    expect(one.rows.length).toBe(1);
    expect(one.rows[0].health).toBe("critical");
    expect(one.overallShowRate).toBeCloseTo(2050 - 125 === 1925 ? 1925 / 2800 : 0, 5);
    expect(paid.showRate).toBeCloseTo(0.5, 5);
    expect(paid.health).toBe("critical");
  });

  it("returns three attribution views that each sum to attendees", async () => {
    const ctx = (await ctxFor())!;
    const a = await withUser(await actor("admin@demo.fest"), (q) => attributionViews(q, ctx));
    if (!a.available) throw new Error("expected attribution");
    const sum = (k: "firstTouch" | "registrationSource" | "lastInteraction") => a.rows.reduce((s, r) => s + r[k], 0);
    expect(sum("firstTouch")).toBe(expected.unique_verified_external_attendees);
    expect(sum("registrationSource")).toBe(expected.unique_verified_external_attendees);
    expect(sum("lastInteraction")).toBe(expected.unique_verified_external_attendees);
  });

  it("reports targets vs actuals from the latest target version", async () => {
    const ctx = (await ctxFor())!;
    const t = await withUser(await actor("admin@demo.fest"), (q) => targetsVsActual(q, ctx));
    if (!t.available) throw new Error("expected targets");
    expect(t.version).toBe("Attendee revised plan");
    expect(t.rows.find((r) => r.metric.startsWith("Unique verified"))!.actual).toBe(expected.unique_verified_external_attendees);
    expect(t.rows.find((r) => r.metric.startsWith("Marketing spend"))!.actual).toBe(expected.marketing_spend_total_inr);
  });

  it("produces weekly trends and range comparisons", async () => {
    const ctx = (await ctxFor())!;
    const a = await actor("admin@demo.fest");
    const w = await withUser(a, (q) => weeklyTrend(q, ctx));
    expect(w.reduce((s, x) => s + x.registrations, 0)).toBe(expected.registered_external_people);
    expect(w.reduce((s, x) => s + (x.spend ?? 0), 0)).toBe(expected.marketing_spend_total_inr);
    const c = await withUser(a, (q) => compareRanges(q, ctx, { from: "2025-03-01", to: "2025-03-14" }, { from: "2025-03-15", to: "2025-03-28" }));
    expect(c.a.registrations).toBeGreaterThan(0);
  });
});

describe("management metrics", () => {
  it("keeps budget plan totals equal to the strategy", async () => {
    const b = await withUser(await actor("admin@demo.fest"), (q) => budgetSummary(q, WS, null));
    const base = b.plan.find((p) => p.scenario === "base")!;
    const stretch = b.plan.find((p) => p.scenario === "stretch")!;
    const initiativeTotal = (p: typeof base) => p.lines.filter((l) => l.category === "initiative").reduce((s, l) => s + l.approved, 0);
    expect(initiativeTotal(base)).toBe(1_160_000);
    expect(initiativeTotal(stretch)).toBe(1_950_000);
    expect(base.festivalFunded.approved).toBe(1_600_000);
    expect(stretch.festivalFunded.approved).toBe(2_400_000);
  });

  it("reports capacity as unconfirmed until configured", async () => {
    const c = await withUser(await actor("admin@demo.fest"), (q) => capacityStatus(q, WS));
    expect(c.configured).toBe(false);
  });

  it("returns an observed result, not a forecast, after the dataset's event", async () => {
    const ctx = (await ctxFor())!;
    const f = await withUser(await actor("admin@demo.fest"), (q) => forecastAttendance(q, WS, ctx));
    expect(f.status).toBe("observed");
  });

  it("estimates with an explicit method before the event, and abstains when history is short", async () => {
    const a = await actor("admin@demo.fest");
    const early = (await ctxFor("admin@demo.fest", "2025-01-25"))!;
    expect((await withUser(a, (q) => forecastAttendance(q, WS, early))).status).toBe("insufficient");
    const mid = (await ctxFor("admin@demo.fest", "2025-03-31"))!;
    const f = await withUser(a, (q) => forecastAttendance(q, WS, mid));
    expect(f.status).toBe("estimated");
  });

  it("finds overdue and blocked seeded tasks", async () => {
    const t = await withUser(await actor("admin@demo.fest"), (q) => taskMetrics(q, WS));
    expect(t.overdue.length).toBeGreaterThanOrEqual(2);
    expect(t.blocked.some((x) => x.title.startsWith("Audit Paid Social"))).toBe(true);
  });
});
