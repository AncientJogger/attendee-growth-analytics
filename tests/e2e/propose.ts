// Creates a pending AI-origin proposal for the browser test (simulates the analyst's draft_task tool).
import { withSystem, withUser, closePool } from "../../src/lib/db";
import { propose } from "../../src/lib/approvals";
const WS = "00000000-0000-4000-8000-000000000001";
(async () => {
  const [u] = await withSystem((q) => q<{ id: string }>("select id from app_users where email = 'admin@demo.fest'"));
  const [arjun] = await withSystem((q) => q<{ id: string }>("select id from app_users where email = 'arjun@demo.fest'"));
  const actor = { userId: u.id, workspaceId: WS, role: "admin" as const };
  const r = await withUser(actor, (q) => propose(q, actor, { kind: "create_task", payload: { title: "E2E: Cut Paid Social prospecting to retargeting only", ownerUserId: arjun.id, dueDate: "2026-12-05", priority: "high" } }, { by: "ai", rationale: "Paid Social show-up 50% vs portfolio 68.8%; ₹274 per verified attendee." }));
  console.log(r.approvalId);
  await closePool();
})();
