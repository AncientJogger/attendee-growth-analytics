import { createHash } from "node:crypto";
import type { DbClient } from "../db";
import type { Q } from "../db";
import { ENTITIES, type DatasetMapping, type EntityKey, type FieldType } from "./schema";
import type { Cell, ParsedSheet } from "./parse";

export interface EntityCounts {
  sheet: string;
  read: number;
  imported: number;
  duplicatesRemoved: number;
  rejected: number;
}
export interface Capabilities {
  event: boolean;
  targets: boolean;
  campaigns: boolean;
  campaignDaily: boolean;
  spend: boolean;
  reach: boolean;
  impressions: boolean;
  clicks: boolean;
  sessions: boolean;
  people: boolean;
  personType: boolean;
  interactions: boolean;
  registrations: boolean;
  statusHistory: boolean;
  checkIns: boolean;
  checkinResult: boolean;
  checkinVerification: boolean;
}
export interface ImportResult {
  datasetVersionId: string;
  counts: Partial<Record<EntityKey, EntityCounts>>;
  rawRowsStored: number;
  warnings: string[];
  capabilities: Capabilities;
  rejectedSample: { sheet: string; row: number; reason: string }[];
}

const TZ_OFFSETS: Record<string, number> = { "asia/kolkata": 330, "asia/calcutta": 330, ist: 330, utc: 0, gmt: 0 };

interface Ctx {
  q: Q;
  ws: string;
  dv: string;
  tz: number; // minutes east of UTC for wall-clock values without an offset
  warnings: string[];
  errors: { sheet: string; row: number; reason: string; data: unknown }[];
  campaignByKey: Map<string, string>;
  personByKey: Map<string, string>;
  registrationByKey: Map<string, { id: string; person: string; campaign: string | null }>;
  ownerByKey: Map<string, string>;
}

// ---- value parsing -------------------------------------------------------------
function parseValue(v: Cell, type: FieldType, tz: number): { ok: boolean; value: unknown } {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return { ok: true, value: null };
  switch (type) {
    case "text":
      return { ok: true, value: v instanceof Date ? v.toISOString() : String(v).trim() };
    case "int": {
      const n = typeof v === "number" ? v : Number(String(v).replace(/[,₹\s]/g, ""));
      return Number.isFinite(n) ? { ok: true, value: Math.round(n) } : { ok: false, value: null };
    }
    case "bool": {
      const s = String(v).toLowerCase();
      return { ok: true, value: s === "true" || s === "1" || s === "yes" };
    }
    case "datetime":
    case "date": {
      const d = toDate(v, tz);
      if (!d) return { ok: false, value: null };
      if (type === "date") {
        const wall = new Date(d.getTime() + tz * 60000);
        return { ok: true, value: wall.toISOString().slice(0, 10) };
      }
      return { ok: true, value: d.toISOString() };
    }
  }
}

/** Wall-clock values without an explicit offset are read in the dataset timezone. */
function toDate(v: Cell, tz: number): Date | null {
  if (v instanceof Date) return new Date(v.getTime() - tz * 60000); // Excel stores naive wall time
  if (typeof v === "number") {
    if (v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000) - tz * 60000); // Excel serial
    return null;
  }
  const s = String(v).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/) ?? null;
  if (m) {
    const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
    return new Date(utc - tz * 60000);
  }
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) return new Date(Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1]) - tz * 60000);
  return null;
}

function rowsFor(sheet: ParsedSheet, entity: EntityKey, cols: Record<string, string>, ctx: Ctx) {
  const spec = ENTITIES[entity].fields as Record<string, { type: FieldType; required?: boolean; label: string }>;
  const idx: Record<string, number> = {};
  for (const [field, header] of Object.entries(cols)) {
    const i = sheet.headers.indexOf(header);
    if (i >= 0) idx[field] = i;
  }
  const out: { rowNumber: number; rec: Record<string, unknown> }[] = [];
  sheet.rows.forEach((r, i) => {
    const rowNumber = i + 2;
    const rec: Record<string, unknown> = {};
    for (const [field, f] of Object.entries(spec)) {
      if (idx[field] === undefined) continue;
      const p = parseValue(r[idx[field]], f.type, ctx.tz);
      if (!p.ok) {
        if (f.required) {
          ctx.errors.push({ sheet: sheet.name, row: rowNumber, reason: `${f.label}: could not read "${String(r[idx[field]])}" as ${f.type}`, data: r });
          return;
        }
        rec[field] = null;
      } else rec[field] = p.value;
    }
    for (const [field, f] of Object.entries(spec)) {
      if (f.required && (rec[field] === null || rec[field] === undefined)) {
        ctx.errors.push({ sheet: sheet.name, row: rowNumber, reason: `Missing required value: ${f.label}`, data: r });
        return;
      }
    }
    out.push({ rowNumber, rec });
  });
  return out;
}

/** Exact repeated source IDs are import copies and count once; conflicting repeats are rejected. */
function dedupe<T extends { rowNumber: number; rec: Record<string, unknown> }>(rows: T[], sheet: string, ctx: Ctx) {
  const seen = new Map<string, string>();
  const kept: T[] = [];
  let dups = 0;
  for (const r of rows) {
    const id = r.rec.source_id as string | undefined;
    if (!id) {
      kept.push(r);
      continue;
    }
    const sig = JSON.stringify(r.rec);
    const prev = seen.get(id);
    if (prev === undefined) {
      seen.set(id, sig);
      kept.push(r);
    } else if (prev === sig) dups++;
    else ctx.errors.push({ sheet, row: r.rowNumber, reason: `Conflicting duplicate ID ${id}: kept the first version`, data: r.rec });
  }
  return { kept, dups };
}

async function bulkInsert(q: Q, table: string, columns: string[], rows: unknown[][], returning?: string) {
  const out: Record<string, unknown>[] = [];
  const chunk = Math.max(1, Math.floor(30000 / columns.length));
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const values = part.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(",")})`).join(",");
    const res = await q(`insert into ${table} (${columns.join(",")}) values ${values}${returning ? ` returning ${returning}` : ""}`, params);
    out.push(...res);
  }
  return out;
}

async function ensureOwner(ctx: Ctx, ownerId: unknown, ownerName: unknown): Promise<string | null> {
  const key = (ownerId as string) || (ownerName ? `name:${ownerName}` : "");
  if (!key) return null;
  if (ctx.ownerByKey.has(key)) return ctx.ownerByKey.get(key)!;
  const rows = await ctx.q<{ id: string }>(
    `insert into team_members (workspace_id, name, source_owner_id) values ($1,$2,$3)
     on conflict (workspace_id, source_owner_id) do update set name = coalesce(excluded.name, team_members.name) returning id`,
    [ctx.ws, (ownerName as string) || key, key],
  );
  ctx.ownerByKey.set(key, rows[0].id);
  return rows[0].id;
}

async function ensureCampaign(ctx: Ctx, ref: unknown): Promise<string | null> {
  if (ref === null || ref === undefined || ref === "") return null;
  const key = String(ref).toLowerCase();
  const found = ctx.campaignByKey.get(key);
  if (found) return found;
  const rows = await ctx.q<{ id: string }>(
    "insert into campaigns (workspace_id, dataset_version_id, source_id, name, notes) values ($1,$2,$3,$3,'Created during import: referenced but not listed in a campaigns sheet') returning id",
    [ctx.ws, ctx.dv, String(ref)],
  );
  ctx.campaignByKey.set(key, rows[0].id);
  ctx.warnings.push(`Campaign "${ref}" is referenced but was not in a campaigns sheet; created a placeholder.`);
  return rows[0].id;
}

async function ensurePerson(ctx: Ctx, ref: string): Promise<string> {
  const found = ctx.personByKey.get(ref);
  if (found) return found;
  const rows = await ctx.q<{ id: string }>(
    "insert into people (workspace_id, dataset_version_id, source_id, extra) values ($1,$2,$3,'{\"placeholder\":true}') returning id",
    [ctx.ws, ctx.dv, ref],
  );
  ctx.personByKey.set(ref, rows[0].id);
  return rows[0].id;
}

// ---- main ---------------------------------------------------------------------------
export async function importDataset(
  q: Q,
  _client: DbClient,
  opts: { workspaceId: string; label: string; filename: string; uploadId: string | null; userId: string | null; isDemo?: boolean; sheets: ParsedSheet[]; mapping: DatasetMapping },
): Promise<ImportResult> {
  const { workspaceId: ws, sheets, mapping } = opts;
  const bySheet = new Map(sheets.map((s) => [s.name, s]));
  const entitySheet = new Map<EntityKey, { sheet: ParsedSheet; cols: Record<string, string> }>();
  for (const [name, m] of Object.entries(mapping.sheets)) {
    if (m.entity === "ignore") continue;
    const s = bySheet.get(name);
    if (!s) throw new Error(`Mapped sheet "${name}" is not in the file`);
    if (entitySheet.has(m.entity)) throw new Error(`Two sheets are mapped to ${ENTITIES[m.entity].label}. Map each entity once.`);
    for (const [field, f] of Object.entries(ENTITIES[m.entity].fields) as [string, { required?: boolean; label: string }][]) {
      if (f.required && !m.columns[field]) throw new Error(`${ENTITIES[m.entity].label}: required field "${f.label}" is not mapped`);
    }
    entitySheet.set(m.entity, { sheet: s, cols: m.columns });
  }
  if (!entitySheet.has("check_ins") && !entitySheet.has("registrations")) {
    throw new Error("Map at least a check-ins or a registrations sheet: without either, attendance cannot be measured.");
  }

  const [dvRow] = await q<{ id: string }>(
    `insert into dataset_versions (workspace_id, upload_id, label, source_filename, uploaded_by, status, is_demo, mapping)
     values ($1,$2,$3,$4,$5,'processing',$6,$7) returning id`,
    [ws, opts.uploadId, opts.label, opts.filename, opts.userId, !!opts.isDemo, JSON.stringify(mapping)],
  );
  const dv = dvRow.id;

  // Timezone: explicit mapping > event sheet timezone > IST default.
  let tz = mapping.timezoneOffsetMinutes ?? 330;
  const warnings: string[] = [];
  const evSheet = entitySheet.get("event");
  if (mapping.timezoneOffsetMinutes === undefined && evSheet?.cols.timezone) {
    const i = evSheet.sheet.headers.indexOf(evSheet.cols.timezone);
    const tzName = String(evSheet.sheet.rows[0]?.[i] ?? "").toLowerCase();
    if (tzName in TZ_OFFSETS) tz = TZ_OFFSETS[tzName];
    else if (tzName) warnings.push(`Unknown timezone "${tzName}"; read times as IST (+05:30).`);
  } else if (mapping.timezoneOffsetMinutes === undefined) warnings.push("No timezone supplied; times without an offset were read as IST (+05:30).");

  const ctx: Ctx = { q, ws, dv, tz, warnings, errors: [], campaignByKey: new Map(), personByKey: new Map(), registrationByKey: new Map(), ownerByKey: new Map() };
  const existingOwners = await q<{ id: string; source_owner_id: string }>("select id, source_owner_id from team_members where workspace_id = $1 and source_owner_id is not null", [ws]);
  existingOwners.forEach((o) => ctx.ownerByKey.set(o.source_owner_id, o.id));

  // Preserve every raw source row, mapped or not.
  let rawRowsStored = 0;
  for (const s of sheets) {
    const raw = s.rows.map((r, i) => [ws, dv, s.name, i + 2, JSON.stringify(Object.fromEntries(s.headers.map((h, j) => [h, r[j] instanceof Date ? (r[j] as Date).toISOString() : r[j]])))]);
    await bulkInsert(q, "raw_source_rows", ["workspace_id", "dataset_version_id", "sheet", "row_number", "data"], raw);
    rawRowsStored += raw.length;
  }

  const counts: ImportResult["counts"] = {};
  const run = async (entity: EntityKey, fn: (rows: { rowNumber: number; rec: Record<string, unknown> }[]) => Promise<number>) => {
    const m = entitySheet.get(entity);
    if (!m) return;
    const before = ctx.errors.length;
    const parsed = rowsFor(m.sheet, entity, m.cols, ctx);
    const { kept, dups } = dedupe(parsed, m.sheet.name, ctx);
    const imported = await fn(kept);
    counts[entity] = { sheet: m.sheet.name, read: m.sheet.rows.length, imported, duplicatesRemoved: dups, rejected: ctx.errors.length - before };
  };

  await run("event", async (rows) => {
    const r = rows[0]?.rec;
    if (!r) return 0;
    await q(`insert into event_info (dataset_version_id, workspace_id, name, starts_at, ends_at, timezone, currency, history_start, history_end) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [dv, ws, r.name ?? null, r.starts_at ?? null, r.ends_at ?? null, r.timezone ?? null, r.currency ?? null, r.history_start ?? null, r.history_end ?? null]);
    return 1;
  });

  await run("targets", async (rows) => {
    await bulkInsert(q, "target_versions", ["workspace_id", "dataset_version_id", "effective_at", "label", "identified_goal", "registration_goal", "visitor_goal", "budget_inr"],
      rows.map(({ rec: r }) => [ws, dv, r.effective_at, r.label ?? null, r.identified_goal ?? null, r.registration_goal ?? null, r.visitor_goal ?? null, r.budget_inr ?? null]));
    return rows.length;
  });

  await run("campaigns", async (rows) => {
    const vals = [];
    for (const { rec: r } of rows) {
      const owner = await ensureOwner(ctx, r.owner_id, r.owner_name);
      vals.push([ws, dv, r.source_id, r.name, r.channel ?? null, r.target_audience ?? null, r.objective ?? null, owner, r.planned_start ?? null, r.planned_end ?? null]);
    }
    const ins = await bulkInsert(q, "campaigns", ["workspace_id", "dataset_version_id", "source_id", "name", "channel", "target_audience", "objective", "owner_team_member_id", "planned_start", "planned_end"], vals, "id, source_id, name");
    for (const c of ins) {
      ctx.campaignByKey.set(String(c.source_id).toLowerCase(), c.id as string);
      ctx.campaignByKey.set(String(c.name).toLowerCase(), c.id as string);
    }
    return ins.length;
  });

  await run("campaign_daily", async (rows) => {
    const vals = [];
    let n = 0;
    for (const { rec: r } of rows) {
      const camp = await ensureCampaign(ctx, r.campaign_ref);
      vals.push([ws, dv, camp, r.source_id ?? `row-${++n}`, r.activity_date, r.impressions ?? null, r.clicks ?? null, r.reported_reach ?? null, r.sessions ?? null, r.registration_starts ?? null, r.spend_inr ?? null, r.platform ?? null]);
    }
    await bulkInsert(q, "campaign_daily", ["workspace_id", "dataset_version_id", "campaign_id", "source_id", "activity_date", "impressions", "clicks", "reported_reach", "sessions", "registration_starts", "spend_inr", "platform"], vals);
    return vals.length;
  });

  await run("people", async (rows) => {
    const vals = [];
    for (const { rec: r } of rows) {
      const owner = await ensureOwner(ctx, r.owner_id, r.owner_name);
      const camp = await ensureCampaign(ctx, r.first_campaign_ref);
      vals.push([ws, dv, r.source_id, r.display_name ?? null, r.person_type ? String(r.person_type).toLowerCase() : null, r.first_seen_at ?? null, r.first_touch_source ?? null, camp, owner]);
    }
    const ins = await bulkInsert(q, "people", ["workspace_id", "dataset_version_id", "source_id", "display_name", "person_type", "first_seen_at", "first_touch_source", "first_campaign_id", "owner_team_member_id"], vals, "id, source_id");
    ins.forEach((p) => ctx.personByKey.set(String(p.source_id), p.id as string));
    return ins.length;
  });

  const placeholderPeopleBefore = ctx.personByKey.size;
  await run("interactions", async (rows) => {
    const vals = [];
    for (const { rec: r } of rows) {
      const person = await ensurePerson(ctx, String(r.person_ref));
      const camp = await ensureCampaign(ctx, r.campaign_ref);
      vals.push([ws, dv, r.source_id, person, camp, r.occurred_at, String(r.event_type).toLowerCase()]);
    }
    await bulkInsert(q, "interactions", ["workspace_id", "dataset_version_id", "source_id", "person_id", "campaign_id", "occurred_at", "event_type"], vals);
    return vals.length;
  });

  await run("registrations", async (rows) => {
    const vals = [];
    for (const { rec: r } of rows) {
      const person = await ensurePerson(ctx, String(r.person_ref));
      const camp = await ensureCampaign(ctx, r.campaign_ref);
      vals.push([ws, dv, r.source_id, person, camp, r.registered_at]);
    }
    const ins = await bulkInsert(q, "registrations", ["workspace_id", "dataset_version_id", "source_id", "person_id", "campaign_id", "registered_at"], vals, "id, source_id, person_id, campaign_id");
    ins.forEach((x) => ctx.registrationByKey.set(String(x.source_id), { id: x.id as string, person: x.person_id as string, campaign: (x.campaign_id as string) ?? null }));
    return ins.length;
  });

  await run("registration_history", async (rows) => {
    const vals = [];
    for (const { rowNumber, rec: r } of rows) {
      const reg = ctx.registrationByKey.get(String(r.registration_ref));
      if (!reg) {
        ctx.errors.push({ sheet: entitySheet.get("registration_history")!.sheet.name, row: rowNumber, reason: `Registration ${r.registration_ref} not found`, data: r });
        continue;
      }
      vals.push([ws, dv, r.source_id, reg.id, String(r.status).trim().toLowerCase(), r.effective_at]);
    }
    await bulkInsert(q, "registration_status_history", ["workspace_id", "dataset_version_id", "source_id", "registration_id", "status", "effective_at"], vals);
    return vals.length;
  });

  await run("check_ins", async (rows) => {
    const vals = [];
    for (const { rec: r } of rows) {
      const person = await ensurePerson(ctx, String(r.person_ref));
      const reg = r.registration_ref ? ctx.registrationByKey.get(String(r.registration_ref)) : undefined;
      if (r.registration_ref && !reg) ctx.warnings.push(`Check-in ${r.source_id} references unknown registration ${r.registration_ref}; kept without the link.`);
      const camp = await ensureCampaign(ctx, r.campaign_ref);
      vals.push([ws, dv, r.source_id, person, reg?.id ?? null, camp, r.occurred_at,
        r.result ? String(r.result).toLowerCase() : null, r.verification ? String(r.verification).toLowerCase() : null, r.method ? String(r.method).toLowerCase() : null]);
    }
    await bulkInsert(q, "check_ins", ["workspace_id", "dataset_version_id", "source_id", "person_id", "registration_id", "campaign_id", "occurred_at", "result", "verification", "method"], vals);
    return vals.length;
  });

  const placeholders = ctx.personByKey.size - placeholderPeopleBefore;
  if (entitySheet.has("people") && placeholders > 0) warnings.push(`${placeholders} people were referenced but not in the people sheet; created placeholders with no person type.`);

  const has = (e: EntityKey, f?: string) => entitySheet.has(e) && (!f || !!entitySheet.get(e)!.cols[f]);
  const capabilities: Capabilities = {
    event: has("event"), targets: has("targets"), campaigns: has("campaigns"), campaignDaily: has("campaign_daily"),
    spend: has("campaign_daily", "spend_inr"), reach: has("campaign_daily", "reported_reach"), impressions: has("campaign_daily", "impressions"),
    clicks: has("campaign_daily", "clicks"), sessions: has("campaign_daily", "sessions"),
    people: has("people"), personType: has("people", "person_type"), interactions: has("interactions"), registrations: has("registrations"),
    statusHistory: has("registration_history"), checkIns: has("check_ins"), checkinResult: has("check_ins", "result"), checkinVerification: has("check_ins", "verification"),
  };
  if (!capabilities.personType) warnings.push("No person type mapped: every person is treated as an external visitor.");
  if (capabilities.checkIns && !capabilities.checkinVerification) warnings.push("No verification field on check-ins: attendance counts admitted check-ins without verification.");
  if (capabilities.checkIns && !capabilities.checkinResult) warnings.push("No result field on check-ins: every check-in row counts as an admission.");
  if (!capabilities.checkIns) warnings.push("No check-ins sheet: verified attendance cannot be measured.");
  if (!capabilities.spend) warnings.push("No spend field: cost metrics are unavailable.");

  if (ctx.errors.length) {
    await bulkInsert(q, "import_errors", ["workspace_id", "dataset_version_id", "sheet", "row_number", "reason", "data"],
      ctx.errors.map((e) => [ws, dv, e.sheet, e.row, e.reason, JSON.stringify(e.data, (_k, v) => (v instanceof Date ? v.toISOString() : v))]));
  }
  const uniqueWarnings = [...new Set(ctx.warnings.concat(warnings))].slice(0, 50);
  await q(`update dataset_versions set status = 'ready', row_counts = $2, quality = $3 where id = $1`, [
    dv, JSON.stringify(counts), JSON.stringify({ warnings: uniqueWarnings, capabilities, rejected: ctx.errors.length, rawRowsStored, timezoneOffsetMinutes: tz }),
  ]);
  return { datasetVersionId: dv, counts, rawRowsStored, warnings: uniqueWarnings, capabilities, rejectedSample: ctx.errors.slice(0, 20).map(({ sheet, row, reason }) => ({ sheet, row, reason })) };
}

export function sha256(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}
