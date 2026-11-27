"use server";
// Thin server actions over the service layer. Every action re-checks the session; the
// service layer and Postgres RLS enforce permissions.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { endSession, requireSession } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { decide, propose } from "@/lib/approvals";
import * as svc from "@/lib/services";
import { getStrategy } from "@/lib/analytics/context";
import type { StrategyConfig } from "@/lib/strategy";

type Result = { ok: boolean; error?: string; message?: string; id?: string };

async function run(fn: () => Promise<unknown>, message?: string): Promise<Result> {
  try {
    const out = await fn();
    revalidatePath("/", "layout");
    return { ok: true, message, id: typeof out === "string" ? out : undefined };
  } catch (e) {
    if (e instanceof ZodError) return { ok: false, error: e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
    if (e instanceof svc.PermissionError || e instanceof svc.ValidationError) return { ok: false, error: e.message };
    console.error(e);
    return { ok: false, error: "The change could not be saved." };
  }
}

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return v === null || v === "" ? undefined : String(v);
};
const nullable = (fd: FormData, k: string) => (fd.has(k) ? (fd.get(k) === "" ? null : String(fd.get(k))) : undefined);

export async function logout() {
  await endSession();
  redirect("/login");
}

export async function createTaskAction(fd: FormData): Promise<Result> {
  const s = await requireSession();
  return run(() => svc.createTask(s, {
    title: str(fd, "title"), description: str(fd, "description"), initiativeId: nullable(fd, "initiativeId"), campaignId: nullable(fd, "campaignId"),
    ownerUserId: nullable(fd, "ownerUserId"), reviewerUserId: nullable(fd, "reviewerUserId"), priority: str(fd, "priority"), status: str(fd, "status"),
    startDate: nullable(fd, "startDate"), dueDate: nullable(fd, "dueDate"), effortHours: nullable(fd, "effortHours"),
  }), "Task created");
}

export async function updateTaskAction(fd: FormData): Promise<Result> {
  const s = await requireSession();
  const id = String(fd.get("taskId"));
  const patch: Record<string, unknown> = {};
  for (const k of ["title", "description", "priority", "status", "progress", "startDate", "dueDate", "effortHours", "ownerUserId", "reviewerUserId", "initiativeId", "campaignId"]) {
    if (fd.has(k)) patch[k] = fd.get(k) === "" ? null : String(fd.get(k));
  }
  if (patch.title === null) delete patch.title;
  for (const k of ["priority", "status", "progress"]) if (patch[k] === null) delete patch[k];
  return run(() => svc.updateTask(s, id, patch), "Task updated");
}

export async function commentAction(fd: FormData): Promise<Result> {
  const s = await requireSession();
  return run(() => svc.addTaskComment(s, String(fd.get("taskId")), String(fd.get("body") ?? "")), "Comment added");
}

export async function dependencyAction(fd: FormData): Promise<Result> {
  const s = await requireSession();
  return run(() => svc.setTaskDependency(s, String(fd.get("taskId")), String(fd.get("dependsOnId")), fd.get("op") !== "remove"), fd.get("op") === "remove" ? "Dependency removed" : "Dependency added");
}

export async function updateCampaignAction(fd: FormData): Promise<Result> {
  const s = await requireSession();
  const patch: Record<string, unknown> = {};
  for (const k of ["status", "ownerTeamMemberId", "initiativeId", "budgetApprovedInr", "budgetCommittedInr", "utmCode", "kpiRegistrations", "kpiAttendees", "notes"]) {
    if (fd.has(k)) patch[k] = fd.get(k) === "" ? null : String(fd.get(k));
  }
  if (patch.status === null) delete patch.status;
  return run(() => svc.updateCampaign(s, String(fd.get("campaignId")), patch), "Campaign updated");
}

export async function updateInitiativeAction(fd: FormData): Promise<Result> {
  const s = await requireSession();
  const patch: Record<string, unknown> = {};
  for (const k of ["status", "ownerUserId", "notes", "baseTarget", "stretchTarget"]) if (fd.has(k)) patch[k] = fd.get(k) === "" ? null : String(fd.get(k));
  if (patch.status === null) delete patch.status;
  return run(() => svc.updateInitiative(s, String(fd.get("initiativeId")), patch), "Initiative updated");
}

export async function updateBudgetLineAction(fd: FormData): Promise<Result> {
  const s = await requireSession();
  const patch: Record<string, unknown> = {};
  for (const k of ["approvedInr", "committedInr", "spentInr", "fundingSource", "notes"]) if (fd.has(k) && fd.get(k) !== "") patch[k] = String(fd.get(k));
  return run(() => svc.updateBudgetLine(s, String(fd.get("lineId")), patch), "Budget line updated");
}

export async function proposeBudgetChangeAction(fd: FormData): Promise<Result> {
  const s = await requireSession();
  return run(() => withUser(s, (q) => propose(q, s, { kind: "budget_change", payload: { budgetLineId: String(fd.get("lineId")), changes: { approvedInr: Number(fd.get("approvedInr")) } } },
    { by: "user", rationale: String(fd.get("rationale") || "Budget change request") })), "Sent for admin approval");
}

export async function registrationStatusAction(fd: FormData): Promise<Result> {
  const s = await requireSession();
  return run(() => svc.setRegistrationStatus(s, String(fd.get("registrationId")), String(fd.get("status")), String(fd.get("reason") ?? "")), "Status changed");
}

export async function checkInVerificationAction(fd: FormData): Promise<Result> {
  const s = await requireSession();
  return run(() => svc.setCheckInVerification(s, Number(fd.get("checkInId")), fd.get("verification") === "verified" ? "verified" : "unverified", String(fd.get("reason") ?? "")), "Check-in updated");
}

export async function decideAction(fd: FormData): Promise<Result> {
  const s = await requireSession();
  const edits: Record<string, unknown> = {};
  for (const k of ["ownerUserId", "dueDate", "priority", "title"]) if (fd.has(k) && fd.get(k) !== "") edits[k] = String(fd.get(k));
  const decision = fd.get("decision") === "reject" ? "reject" : "approve";
  return run(() => decide(s, String(fd.get("approvalId")), decision, { note: str(fd, "note"), edits: Object.keys(edits).length ? edits : undefined }),
    decision === "approve" ? "Approved and applied" : "Rejected");
}

export async function setActiveDatasetAction(fd: FormData): Promise<Result> {
  const s = await requireSession();
  return run(() => svc.setActiveDataset(s, String(fd.get("datasetVersionId"))), "Active dataset switched");
}

export async function restoreDemoAction(): Promise<Result> {
  const s = await requireSession();
  return run(async () => {
    const [demo] = await withUser(s, (q) => q<{ id: string }>("select id from dataset_versions where workspace_id = $1 and is_demo order by uploaded_at limit 1", [s.workspaceId]));
    if (!demo) throw new svc.ValidationError("The original demonstration dataset is not present. Run the seed script to recreate it.");
    await svc.setActiveDataset(s, demo.id);
    const { DEFAULT_STRATEGY } = await import("@/lib/strategy");
    await svc.saveStrategyConfig(s, DEFAULT_STRATEGY, "Restored default planning assumptions");
  }, "Original dataset and default assumptions restored");
}

export async function saveStrategyAction(fd: FormData): Promise<Result> {
  const s = await requireSession();
  return run(async () => {
    const cur = await withUser(s, (q) => getStrategy(q, s.workspaceId));
    const n = (k: string, fallback: number) => (fd.get(k) === null || fd.get(k) === "" ? fallback : Number(fd.get(k)));
    const nn = (k: string) => (fd.get(k) === null || fd.get(k) === "" ? null : Number(fd.get(k)));
    const c = cur.config;
    const thresholds = Object.fromEntries(Object.entries(c.thresholds).map(([key, t]) => [key, { ...t, scaleAt: n(`th_${key}_scale`, t.scaleAt), changeFrom: n(`th_${key}_change`, t.changeFrom), stopBelow: n(`th_${key}_change`, t.stopBelow) }]));
    const dailyLimit = nn("dailyLimit");
    const totalLimit = nn("totalLimit");
    const next: StrategyConfig = {
      ...c,
      planningBaseline: n("planningBaseline", c.planningBaseline), baseTarget: n("baseTarget", c.baseTarget), stretchTarget: n("stretchTarget", c.stretchTarget),
      planningShowRate: n("planningShowRate", c.planningShowRate * 100) / 100,
      capacity: { dailyLimit, totalLimit, confirmedBy: dailyLimit || totalLimit ? str(fd, "confirmedBy") ?? s.name : null, confirmedAt: dailyLimit || totalLimit ? new Date().toISOString().slice(0, 10) : null },
      market: { ...c.market, tamStudents: n("tamStudents", c.market.tamStudents), samStudents: n("samStudents", c.market.samStudents) },
      budget: {
        base: { ...c.budget.base, ceiling: n("baseCeiling", c.budget.base.ceiling) },
        stretch: { ...c.budget.stretch, ceiling: n("stretchCeiling", c.budget.stretch.ceiling) },
      },
      thresholds,
    };
    return svc.saveStrategyConfig(s, next, String(fd.get("note") ?? ""));
  }, "Saved as a new version");
}

export async function createExperimentAction(fd: FormData): Promise<Result> {
  const s = await requireSession();
  if (s.role === "team_member") return { ok: false, error: "Team members cannot create experiments." };
  return run(() => withUser(s, async (q) => {
    const [r] = await q<{ id: string }>(
      `insert into experiments (workspace_id, initiative_id, name, hypothesis, segment, treatment, control, start_date, end_date, owner_user_id, primary_metric, guardrail_metric, decision_rule)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [s.workspaceId, nullable(fd, "initiativeId") ?? null, String(fd.get("name") ?? "").trim() || "Untitled experiment", str(fd, "hypothesis") ?? null, str(fd, "segment") ?? null, str(fd, "treatment") ?? null,
        str(fd, "control") ?? null, str(fd, "startDate") ?? null, str(fd, "endDate") ?? null, s.userId, str(fd, "primaryMetric") ?? null, str(fd, "guardrailMetric") ?? null, str(fd, "decisionRule") ?? null]);
    const { audit, bumpVersion } = await import("@/lib/db");
    await audit(q, { workspaceId: s.workspaceId, actorUserId: s.userId, action: "create", entity: "experiment", entityId: r.id, after: Object.fromEntries(fd.entries()) });
    await bumpVersion(q, s.workspaceId);
    return r.id;
  }).catch((e) => { if (/row-level security/.test(String(e))) throw new svc.PermissionError("You can only create experiments for initiatives you manage."); throw e; }), "Experiment created");
}

export async function recordExperimentAction(fd: FormData): Promise<Result> {
  const s = await requireSession();
  if (s.role === "team_member") return { ok: false, error: "Team members cannot record experiment results." };
  const n = (k: string) => (fd.get(k) === "" || fd.get(k) === null ? null : Math.max(0, Math.round(Number(fd.get(k)))));
  const vals = { tn: n("treatmentN"), cn: n("controlN"), tc: n("treatmentConversions"), cc: n("controlConversions") };
  if ((vals.tc ?? 0) > (vals.tn ?? Infinity) || (vals.cc ?? 0) > (vals.cn ?? Infinity)) return { ok: false, error: "Conversions cannot exceed the sample size." };
  return run(() => withUser(s, async (q) => {
    const id = String(fd.get("experimentId"));
    const [before] = await q("select status, decision, treatment_n, control_n, treatment_conversions, control_conversions from experiments where id = $1", [id]);
    const rows = await q("update experiments set treatment_n = $2, control_n = $3, treatment_conversions = $4, control_conversions = $5, status = coalesce($6, status), decision = $7, caveats = coalesce($8, caveats), updated_at = now() where id = $1 returning id",
      [id, vals.tn, vals.cn, vals.tc, vals.cc, str(fd, "status") ?? null, str(fd, "decision") ?? null, str(fd, "caveats") ?? null]);
    if (!rows.length) throw new svc.PermissionError("You can only update experiments for initiatives you manage.");
    const { audit, bumpVersion } = await import("@/lib/db");
    await audit(q, { workspaceId: s.workspaceId, actorUserId: s.userId, action: "update", entity: "experiment", entityId: id, before, after: vals });
    await bumpVersion(q, s.workspaceId);
  }), "Results saved");
}
