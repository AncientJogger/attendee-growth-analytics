/*
 * Seeds a demo workspace. Usage: npx tsx scripts/seed.ts [--reset]
 *   --reset  deletes demo workspace data (except audit_logs, which are append-only and kept)
 *            and recreates it. The supplied workbook is re-imported from data/attendee-dataset.xlsx.
 *
 * Everything created here other than the imported workbook is synthetic demo data and is
 * labelled as such (origin = 'seed', notes "Demo seed").
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { withSystem, closePool, type Q } from "../src/lib/db";
import { migrate } from "./migrate";
import { parseUpload, suggestMapping } from "../src/lib/import/parse";
import { importDataset, sha256 } from "../src/lib/import/importer";
import { DEFAULT_STRATEGY } from "../src/lib/strategy";

export const DEMO_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

export const DEMO_USERS = [
  { email: "admin@demo.fest", name: "Asha Kapoor", role: "admin", password: "Demo-Admin-2026", owner: null, title: "Fest growth lead" },
  { email: "meera@demo.fest", name: "Meera Iyer", role: "campaign_manager", password: "Demo-Manager-2026", owner: "T03", title: "Campus programmes manager" },
  { email: "arjun@demo.fest", name: "Arjun Verma", role: "campaign_manager", password: "Demo-Manager-2026", owner: "T04", title: "Digital & partnerships manager" },
  { email: "nisha@demo.fest", name: "Nisha Rao", role: "team_member", password: "Demo-Member-2026", owner: "T05", title: "Content & creator associate" },
  { email: "dev@demo.fest", name: "Dev Malhotra", role: "team_member", password: "Demo-Member-2026", owner: "T06", title: "Community associate" },
] as const;

const INITIATIVES = [
  { key: "campus_cup", name: "Campus Cup", decision: "double_down", base: 1450, stretch: 2175, bb: 450000, sb: 750000, owner: "meera@demo.fest", proxy: "C04",
    mechanism: "Inter-college competition ranked on unique verified physical attendance, adjusted for college size." },
  { key: "crewpass", name: "CrewPass", decision: "double_down", base: 1300, stretch: 1950, bb: 300000, sb: 500000, owner: "arjun@demo.fest", proxy: "C05",
    mechanism: "Group registration (usually 4–6 people) with benefits unlocked only by actual group check-ins." },
  { key: "campus_network", name: "Campus Network", decision: "maintain", base: 550, stretch: 825, bb: 150000, sb: 250000, owner: "meera@demo.fest", proxy: "C01",
    mechanism: "Student ambassadors and college captains paid for verified arrivals; enabling layer that overlaps with Campus Cup." },
  { key: "challenge_circuit", name: "National Challenge Circuit", decision: "staged_pilot", base: 600, stretch: 900, bb: 200000, sb: 350000, owner: "arjun@demo.fest", proxy: null,
    mechanism: "Online qualifiers with offline finals at the fest. Attendance counts finalists and supporters who check in, not online entries." },
  { key: "student_passport", name: "Student Passport", decision: "deprioritize", base: 100, stretch: 150, bb: 60000, sb: 100000, owner: "arjun@demo.fest", proxy: "C07",
    mechanism: "Small café and local-business referral pilot; stays deprioritised unless incremental check-ins justify expansion." },
] as const;

async function hasDemo(q: Q) {
  return (await q("select 1 from workspaces where id = $1", [DEMO_WORKSPACE_ID])).length > 0;
}

export async function seed({ reset = false, quiet = false } = {}) {
  await migrate();
  const log = (...a: unknown[]) => !quiet && console.log(...a);
  const xlsxPath = path.join(process.cwd(), "data", "attendee-dataset.xlsx");
  const bytes = readFileSync(xlsxPath);
  const sheets = await parseUpload("Attendee Dataset.xlsx", bytes);
  const mapping = suggestMapping(sheets);

  await withSystem(async (q, client) => {
    if (await hasDemo(q)) {
      if (!reset) {
        log("Demo workspace already exists. Use --reset to recreate it.");
        return;
      }
      // Audit history is append-only and survives a reset.
      await q("update workspaces set active_dataset_version_id = null where id = $1", [DEMO_WORKSPACE_ID]);
      for (const t of ["approvals", "ai_threads", "tasks", "experiments", "budget_lines", "dataset_versions", "dataset_uploads", "strategy_configs", "initiatives", "app_users", "team_members"]) {
        await q(`delete from ${t} where workspace_id = $1`, [DEMO_WORKSPACE_ID]);
      }
      await q("delete from workspaces where id = $1", [DEMO_WORKSPACE_ID]);
    }
    const ws = DEMO_WORKSPACE_ID;
    await q("insert into workspaces (id, name) values ($1, 'Demo workspace: fest attendee growth')", [ws]);

    // Team members first, so imported owner IDs (T03–T06) link to the same people.
    const userIds: Record<string, string> = {};
    for (const u of DEMO_USERS) {
      let tm: string | null = null;
      if (u.owner) {
        [{ id: tm }] = await q<{ id: string }>("insert into team_members (workspace_id, name, title, source_owner_id) values ($1,$2,$3,$4) returning id", [ws, u.name, u.title, u.owner]);
      } else {
        [{ id: tm }] = await q<{ id: string }>("insert into team_members (workspace_id, name, title) values ($1,$2,$3) returning id", [ws, u.name, u.title]);
      }
      const [{ id }] = await q<{ id: string }>(
        "insert into app_users (workspace_id, email, display_name, role, password_hash, team_member_id) values ($1,$2,$3,$4,$5,$6) returning id",
        [ws, u.email, u.name, u.role, bcrypt.hashSync(u.password, 10), tm],
      );
      userIds[u.email] = id;
    }

    const [{ id: uploadId }] = await q<{ id: string }>(
      "insert into dataset_uploads (workspace_id, filename, bytes, sha256, uploaded_by) values ($1,$2,$3,$4,$5) returning id",
      [ws, "Attendee Dataset.xlsx", bytes, sha256(bytes), userIds["admin@demo.fest"]],
    );
    const result = await importDataset(q, client, {
      workspaceId: ws, label: "CampusFest 2025 (supplied historical dataset)", filename: "Attendee Dataset.xlsx",
      uploadId, userId: userIds["admin@demo.fest"], isDemo: true, sheets, mapping,
    });
    await q("update workspaces set active_dataset_version_id = $2 where id = $1", [ws, result.datasetVersionId]);
    log("Imported workbook:", JSON.stringify(result.counts));

    await q("insert into strategy_configs (workspace_id, version, config, change_note, created_by) values ($1, 1, $2, 'Initial planning assumptions (demo seed)', $3)",
      [ws, JSON.stringify(DEFAULT_STRATEGY), userIds["admin@demo.fest"]]);

    const initIds: Record<string, string> = {};
    for (const i of INITIATIVES) {
      const [{ id }] = await q<{ id: string }>(
        `insert into initiatives (workspace_id, key, name, mechanism, decision, base_target, stretch_target, base_budget_inr, stretch_budget_inr, owner_user_id, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [ws, i.key, i.name, i.mechanism, i.decision, i.base, i.stretch, i.bb, i.sb, userIds[i.owner],
          "Planning allocation, not an achieved result. Linked 2025 campaign is a historical proxy for evidence only."],
      );
      initIds[i.key] = id;
      await q("insert into initiative_assignments (initiative_id, user_id, workspace_id) values ($1,$2,$3)", [id, userIds[i.owner], ws]);
      if (i.proxy) await q("update campaigns set initiative_id = $1 where dataset_version_id = $2 and source_id = $3", [id, result.datasetVersionId, i.proxy]);
    }
    // Team members support initiatives too.
    await q("insert into initiative_assignments (initiative_id, user_id, workspace_id) values ($1,$2,$3),($4,$2,$3),($5,$6,$3)",
      [initIds.campus_network, userIds["dev@demo.fest"], ws, initIds.campus_cup, initIds.crewpass, userIds["nisha@demo.fest"]]);

    // Budget plan lines (planning allocations from the strategy; nothing spent yet).
    const lines: [string, string | null, string, string, number][] = [];
    for (const i of INITIATIVES) {
      lines.push(["base", initIds[i.key], "initiative", i.name, i.bb], ["stretch", initIds[i.key], "initiative", i.name, i.sb]);
    }
    lines.push(["base", null, "standard_marketing", "Standard marketing", 400000], ["stretch", null, "standard_marketing", "Standard marketing", 400000]);
    lines.push(["base", null, "contingency", "Contingency", 40000], ["stretch", null, "contingency", "Contingency", 50000]);
    for (const [scenario, init, cat, label, amt] of lines) {
      await q("insert into budget_lines (workspace_id, scenario, initiative_id, category, label, approved_inr, notes) values ($1,$2,$3,$4,$5,$6,'Planning allocation (demo seed)')",
        [ws, scenario, init, cat, label, amt]);
    }
    // A few demo commitments so variance views have something to show. Clearly labelled.
    await q("update budget_lines set committed_inr = 120000, notes = 'Demo seed: trophy and prize vendor booked (synthetic)' where workspace_id = $1 and scenario = 'base' and initiative_id = $2", [ws, initIds.campus_cup]);
    await q("update budget_lines set committed_inr = 45000, spent_inr = 18000, notes = 'Demo seed: CrewPass benefit partner advance (synthetic)' where workspace_id = $1 and scenario = 'base' and initiative_id = $2", [ws, initIds.crewpass]);

    // Demo tasks with dates relative to today. Some are overdue or blocked on purpose.
    const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const camp = async (sid: string) => (await q<{ id: string }>("select id from campaigns where dataset_version_id = $1 and source_id = $2", [result.datasetVersionId, sid]))[0]?.id ?? null;
    const T = async (t: { title: string; desc: string; init: string | null; camp?: string; owner: string; reviewer?: string; pri: string; status: string; start: number; due: number; effort: number; progress?: number }) => {
      const [{ id }] = await q<{ id: string }>(
        `insert into tasks (workspace_id, title, description, initiative_id, campaign_id, owner_user_id, reviewer_user_id, priority, status, progress, start_date, due_date, effort_hours, origin, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'seed',$14) returning id`,
        [ws, t.title, t.desc, t.init ? initIds[t.init] : null, t.camp ? await camp(t.camp) : null, userIds[t.owner], t.reviewer ? userIds[t.reviewer] : null,
          t.pri, t.status, t.progress ?? 0, day(t.start), day(t.due), t.effort, userIds["admin@demo.fest"]],
      );
      return id;
    };
    const exportOptOuts = await T({ title: "Export Paid Social opt-out list by audience", desc: "Demo seed. Pull opted-out people by Paid Social audience so retargeting can exclude them.", init: null, camp: "C02", owner: "nisha@demo.fest", pri: "high", status: "in_progress", start: -10, due: -3, effort: 4, progress: 40 });
    const auditPaid = await T({ title: "Audit Paid Social retargeting audiences", desc: "Demo seed. Paid Social had the lowest show-up rate in 2025; decide which audiences to keep.", init: null, camp: "C02", owner: "arjun@demo.fest", reviewer: "admin@demo.fest", pri: "critical", status: "blocked", start: -8, due: -1, effort: 6 });
    await q("insert into task_dependencies (task_id, depends_on_id, workspace_id) values ($1,$2,$3)", [auditPaid, exportOptOuts, ws]);
    await T({ title: "Renegotiate Creator Partners deliverables", desc: "Demo seed. Creator Partners cost the most per verified attendee in 2025.", init: null, camp: "C03", owner: "nisha@demo.fest", pri: "high", status: "todo", start: -2, due: 5, effort: 5 });
    const cupRules = await T({ title: "Publish Campus Cup scoring rules (size-adjusted)", desc: "Demo seed. 30% competition points, 70% verified supporter check-ins, normalised by college size.", init: "campus_cup", owner: "meera@demo.fest", reviewer: "admin@demo.fest", pri: "high", status: "review", start: -12, due: 2, effort: 8, progress: 90 });
    const cupColleges = await T({ title: "Sign six founding colleges for the Campus Cup pilot", desc: "Demo seed. Pilot colleges plus matched non-pilot colleges as comparison.", init: "campus_cup", owner: "meera@demo.fest", pri: "critical", status: "in_progress", start: -7, due: 7, effort: 12, progress: 50 });
    await q("insert into task_dependencies (task_id, depends_on_id, workspace_id) values ($1,$2,$3)", [cupColleges, cupRules, ws]);
    await T({ title: "Build CrewPass randomised offer (A/B) in registration flow", desc: "Demo seed. Offer CrewPass to a random half of eligible registrants.", init: "crewpass", owner: "arjun@demo.fest", pri: "high", status: "todo", start: 0, due: 10, effort: 16 });
    await T({ title: "Line up CrewPass benefit partners (food credits)", desc: "Demo seed.", init: "crewpass", owner: "nisha@demo.fest", pri: "medium", status: "todo", start: 1, due: 14, effort: 6 });
    await T({ title: "Recruit first 8 campus captains (NCR)", desc: "Demo seed. Pay per verified arrival; weekly review.", init: "campus_network", owner: "dev@demo.fest", reviewer: "meera@demo.fest", pri: "medium", status: "in_progress", start: -5, due: -2, effort: 10, progress: 60 });
    await T({ title: "Captain activation kit and tracking codes", desc: "Demo seed.", init: "campus_network", owner: "dev@demo.fest", pri: "medium", status: "todo", start: 0, due: 9, effort: 6 });
    await T({ title: "Secure category sponsors before the Challenge Circuit pilot", desc: "Demo seed. Pilot only runs if prize funding is confirmed by T-8 weeks.", init: "challenge_circuit", owner: "arjun@demo.fest", reviewer: "admin@demo.fest", pri: "high", status: "blocked", start: -4, due: 3, effort: 8 });
    await T({ title: "Shortlist 3 café partners for the Passport micro-pilot", desc: "Demo seed. Partner-funded rewards only.", init: "student_passport", owner: "dev@demo.fest", pri: "low", status: "backlog", start: 5, due: 21, effort: 3 });
    await T({ title: "Confirm venue capacity with campus security", desc: "Demo seed. Capacity is unconfirmed; targets cannot be called capacity-safe until it is set.", init: null, owner: "admin@demo.fest", pri: "critical", status: "todo", start: 0, due: 4, effort: 2 });
    await T({ title: "Set up WhatsApp reconfirmation at T-7 and T-2", desc: "Demo seed. Replace email nurture, which showed no link to show-up in 2025.", init: null, owner: "nisha@demo.fest", pri: "medium", status: "done", start: -15, due: -6, effort: 5, progress: 100 });

    await q(`insert into experiments (workspace_id, initiative_id, name, hypothesis, segment, treatment, control, start_date, end_date, owner_user_id, primary_metric, guardrail_metric, decision_rule, status, caveats)
             values ($1,$2,'CrewPass offer A/B','Offering CrewPass raises check-in rate among eligible registrants','Eligible registrants (randomised 50/50)','CrewPass offer shown','Standard confirmation','${day(10)}','${day(40)}',$3,'Verified check-in rate','Registration completion rate','Scale at ≥70% member check-in and ≥10 pt uplift vs control','planned','Demo seed: no results yet.'),
                    ($1,$4,'Campus Cup pilot vs matched colleges','Pilot colleges produce more unique verified attendees per 1,000 students than matched colleges','6 pilot colleges vs 6 matched','Campus Cup participation','Matched non-pilot colleges','${day(7)}','${day(60)}',$5,'Verified attendees per 1,000 students','Cost per verified attendee','Scale at ≥60 incremental attendees per active college','planned','Demo seed: no results yet.')`,
      [ws, initIds.crewpass, userIds["arjun@demo.fest"], initIds.campus_cup, userIds["meera@demo.fest"]]);

    await q("insert into audit_logs (workspace_id, actor_kind, action, entity, entity_id, after, reason) values ($1,'system','seed','workspace',$3,$2,'Demo workspace created')",
      [ws, JSON.stringify({ datasetVersionId: result.datasetVersionId }), ws]);
    log("Seed complete.");
  });
}

if (process.argv[1]?.endsWith("seed.ts")) {
  seed({ reset: process.argv.includes("--reset") })
    .then(() => closePool())
    .catch(async (e) => {
      console.error(e);
      await closePool();
      process.exit(1);
    });
}
