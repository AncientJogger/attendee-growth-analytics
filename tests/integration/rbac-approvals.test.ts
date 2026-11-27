import { afterAll, describe, expect, it } from "vitest";
import { closePool, withSystem, withUser } from "@/lib/db";
import { createTask, updateTask, updateBudgetLine, updateCampaign, setRegistrationStatus, setCheckInVerification, saveStrategyConfig, PermissionError } from "@/lib/services";
import { decide, propose } from "@/lib/approvals";
import { listTasks } from "@/lib/analytics/management";
import { attendanceMetrics, campaignPerformance, registrationMetrics } from "@/lib/analytics/metrics";
import { capacityStatus } from "@/lib/analytics/management";
import { getStrategy, todayIn } from "@/lib/analytics/context";
import { actor, ctxFor, WS } from "../helpers";

afterAll(() => closePool());

const anyId = async (sql: string, p: unknown[] = []) => (await withSystem((q) => q<{ id: string }>(sql, p)))[0].id;

describe("role-based permissions (enforced by Postgres RLS and the service layer)", () => {
  it("team member cannot create tasks or edit budgets", async () => {
    const dev = await actor("dev@demo.fest");
    await expect(createTask(dev, { title: "Should fail" })).rejects.toBeInstanceOf(PermissionError);
    const line = await anyId("select id from budget_lines where workspace_id = $1 limit 1", [WS]);
    await expect(updateBudgetLine(dev, line, { approvedInr: 1 })).rejects.toBeInstanceOf(PermissionError);
  });

  it("team member can update status of their own task but not someone else's", async () => {
    const dev = await actor("dev@demo.fest");
    const own = await anyId("select t.id from tasks t join app_users u on u.id = t.owner_user_id where u.email = 'dev@demo.fest' limit 1");
    await updateTask(dev, own, { status: "in_progress", progress: 30 });
    const other = await anyId("select t.id from tasks t join app_users u on u.id = t.owner_user_id where u.email = 'arjun@demo.fest' limit 1");
    await expect(updateTask(dev, other, { status: "done" })).rejects.toBeInstanceOf(PermissionError);
    await expect(updateTask(dev, own, { ownerUserId: dev.userId })).rejects.toBeInstanceOf(PermissionError);
  });

  it("RLS blocks a direct write even if the service check were bypassed", async () => {
    const dev = await actor("dev@demo.fest");
    const other = await anyId("select t.id from tasks t join app_users u on u.id = t.owner_user_id where u.email = 'arjun@demo.fest' limit 1");
    const rows = await withUser(dev, (q) => q("update tasks set title = 'hacked' where id = $1 returning id", [other]));
    expect(rows.length).toBe(0);
    await expect(withUser(dev, (q) => q("insert into budget_lines (workspace_id, scenario, category, label) values ($1,'base','x','x')", [WS]))).rejects.toThrow(/row-level security/);
  });

  it("campaign manager can edit campaigns in scope but not others, and cannot change approved budget directly", async () => {
    const meera = await actor("meera@demo.fest");
    const ctx = (await ctxFor())!;
    const own = await anyId("select id from campaigns where dataset_version_id = $1 and source_id = 'C04'", [ctx.dv]); // College Partnerships → Campus Cup (Meera)
    await updateCampaign(meera, own, { notes: "Meera's note" });
    const notMine = await anyId("select id from campaigns where dataset_version_id = $1 and source_id = 'C02'", [ctx.dv]); // Paid Social → Arjun
    await expect(updateCampaign(meera, notMine, { notes: "x" })).rejects.toBeInstanceOf(PermissionError);
    await expect(updateCampaign(meera, own, { budgetApprovedInr: 1 })).rejects.toBeInstanceOf(PermissionError);
  });

  it("only admins change Strategy & Targets, and each save is a new version", async () => {
    const meera = await actor("meera@demo.fest");
    const admin = await actor("admin@demo.fest");
    const cur = await withUser(admin, (q) => getStrategy(q, WS));
    expect(() => saveStrategyConfig(meera, cur.config, "x")).toThrow(PermissionError);
    const v = await saveStrategyConfig(admin, { ...cur.config, capacity: { ...cur.config.capacity, dailyLimit: 6000, confirmedBy: "Campus security", confirmedAt: "2026-11-27" } }, "Capacity confirmed (test)");
    expect(v).toBe(cur.version + 1);
    const cap = await withUser(admin, (q) => capacityStatus(q, WS, 11000));
    expect(cap.configured).toBe(true);
    await saveStrategyConfig(admin, cur.config, "Revert capacity (test)");
  });
});

describe("approval workflow", () => {
  it("an AI draft creates no task until approved, then appears in task lists", async () => {
    const admin = await actor("admin@demo.fest");
    const before = (await withUser(admin, (q) => listTasks(q, WS))).length;
    const { approvalId } = await withUser(admin, (q) => propose(q, admin, { kind: "create_task", payload: { title: "Review Paid Social retargeting", ownerUserId: admin.userId, dueDate: "2026-12-10", priority: "high" } }, { by: "ai", rationale: "test" }));
    expect((await withUser(admin, (q) => listTasks(q, WS))).length).toBe(before);
    const res = await decide(admin, approvalId, "approve", { edits: { dueDate: "2026-12-12" } });
    const tasks = await withUser(admin, (q) => listTasks(q, WS));
    expect(tasks.length).toBe(before + 1);
    const t = tasks.find((x) => x.id === res.resultId)!;
    expect(t.origin).toBe("ai");
    expect(t.dueDate).toBe("2026-12-12");
    await expect(decide(admin, approvalId, "approve")).rejects.toThrow(/already/);
    const audit = await withSystem((q) => q("select action from audit_logs where entity_id = $1 order by id", [approvalId]));
    expect(audit.map((a) => a.action)).toEqual(["propose", "approve"]);
  });

  it("rejecting a draft creates nothing", async () => {
    const admin = await actor("admin@demo.fest");
    const before = (await withUser(admin, (q) => listTasks(q, WS))).length;
    const { approvalId } = await withUser(admin, (q) => propose(q, admin, { kind: "create_task", payload: { title: "Rejected idea" } }, { by: "ai", rationale: "test" }));
    await decide(admin, approvalId, "reject", { note: "Not now" });
    expect((await withUser(admin, (q) => listTasks(q, WS))).length).toBe(before);
  });

  it("team members cannot approve; budget changes need an admin who did not request them", async () => {
    const dev = await actor("dev@demo.fest");
    const arjun = await actor("arjun@demo.fest");
    const admin = await actor("admin@demo.fest");
    const line = await anyId("select id from budget_lines where workspace_id = $1 and scenario = 'base' and category = 'contingency'", [WS]);
    const p1 = await withUser(arjun, (q) => propose(q, arjun, { kind: "budget_change", payload: { budgetLineId: line, changes: { approvedInr: 45000 } } }, { by: "user", rationale: "test" }));
    await expect(decide(dev, p1.approvalId, "approve")).rejects.toBeInstanceOf(PermissionError);
    await expect(decide(arjun, p1.approvalId, "approve")).rejects.toBeInstanceOf(PermissionError);
    await decide(admin, p1.approvalId, "approve");
    const p2 = await withUser(admin, (q) => propose(q, admin, { kind: "budget_change", payload: { budgetLineId: line, changes: { approvedInr: 40000 } } }, { by: "user", rationale: "test" }));
    await expect(decide(admin, p2.approvalId, "approve")).rejects.toBeInstanceOf(PermissionError);
    await decide(admin, p2.approvalId, "reject");
    await updateBudgetLine(admin, line, { approvedInr: 40000 }); // restore seed value
  });

  it("audit log rows cannot be edited or deleted", async () => {
    await expect(withSystem((q) => q("update audit_logs set action = 'x' where id = (select min(id) from audit_logs)"))).rejects.toThrow(/append-only/);
    await expect(withSystem((q) => q("delete from audit_logs"))).rejects.toThrow(/append-only/);
  });
});

describe("live data changes flow into analytics", () => {
  it("registration status and check-in corrections change the metrics and bump the data version", async () => {
    const admin = await actor("admin@demo.fest");
    const ctx = (await ctxFor())!;
    const v0 = ctx.dataVersion;
    const reg0 = await withUser(admin, (q) => registrationMetrics(q, ctx));
    const regId = await anyId(`select r.id from registrations r where r.dataset_version_id = $1 and (select h.status from registration_status_history h where h.registration_id = r.id order by h.effective_at desc, h.source_id desc limit 1) = 'waitlisted' limit 1`, [ctx.dv]);
    await setRegistrationStatus(admin, regId, "confirmed", "Test: moved off waitlist");
    // Corrections are effective now, so look at today's snapshot.
    const ctxNow = (await ctxFor("admin@demo.fest", todayIn(330)) /* IST, like the app */)!;
    const reg1 = await withUser(admin, (q) => registrationMetrics(q, ctxNow));
    if (!reg0.available || !reg1.available) throw new Error("expected registrations");
    expect(reg1.latestStatus.confirmed).toBe((reg0.latestStatus.confirmed ?? 0) + 1);
    expect(ctxNow.dataVersion).toBeGreaterThan(v0);

    const att0 = await withUser(admin, (q) => attendanceMetrics(q, ctx));
    const [ck] = await withSystem((q) => q<{ id: number; person_id: string }>(
      `select c.id, c.person_id from check_ins c join people p on p.id = c.person_id where c.dataset_version_id = $1 and c.result = 'admitted' and c.verification = 'verified' and p.person_type = 'external'
       and (select count(*) from check_ins c2 where c2.person_id = c.person_id and c2.result = 'admitted' and c2.verification = 'verified') = 1 limit 1`, [ctx.dv]));
    await setCheckInVerification(admin, ck.id, "unverified", "Test: scanner misread");
    const att1 = await withUser(admin, (q) => attendanceMetrics(q, ctx));
    expect(att1.available && att0.available && att1.uniqueVerifiedAttendees).toBe(att0.available ? att0.uniqueVerifiedAttendees - 1 : -1);
    await setCheckInVerification(admin, ck.id, "verified", "Test: revert");
  });

  it("campaign edits appear in campaign analytics", async () => {
    const admin = await actor("admin@demo.fest");
    const ctx = (await ctxFor())!;
    const id = await anyId("select id from campaigns where dataset_version_id = $1 and source_id = 'C03'", [ctx.dv]);
    await updateCampaign(admin, id, { budgetApprovedInr: 40000, status: "paused" });
    const { rows } = await withUser(admin, (q) => campaignPerformance(q, ctx, { campaignIds: [id] }));
    expect(rows[0].budgetApproved).toBe(40000);
    expect(rows[0].status).toBe("paused");
    expect(rows[0].healthReasons.join(" ")).toMatch(/exceeds the campaign's approved budget/);
  });
});
