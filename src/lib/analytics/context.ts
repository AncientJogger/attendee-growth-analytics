import type { Q } from "../db";
import type { Capabilities } from "../import/importer";
import { DEFAULT_STRATEGY, type StrategyConfig } from "../strategy";

export interface DatasetContext {
  workspaceId: string;
  dv: string;
  label: string;
  isDemo: boolean;
  uploadedAt: string;
  caps: Capabilities;
  warnings: string[];
  rowCounts: Record<string, { read: number; imported: number; duplicatesRemoved: number; rejected: number; sheet: string }>;
  rejected: number;
  tzOffset: number;
  event: { name: string | null; startsAt: string | null; endsAt: string | null; historyStart: string | null; historyEnd: string | null; currency: string | null } | null;
  asOfDate: string; // YYYY-MM-DD in dataset timezone
  asOf: string; // ISO timestamp: end of asOfDate in dataset timezone
  dataVersion: number;
}

const EMPTY_CAPS: Capabilities = {
  event: false, targets: false, campaigns: false, campaignDaily: false, spend: false, reach: false, impressions: false, clicks: false,
  sessions: false, people: false, personType: false, interactions: false, registrations: false, statusHistory: false, checkIns: false,
  checkinResult: false, checkinVerification: false,
};

export function endOfDayIso(date: string, tzOffset: number) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - tzOffset * 60000).toISOString();
}

export function todayIn(tzOffset: number) {
  return new Date(Date.now() + tzOffset * 60000).toISOString().slice(0, 10);
}

/** Loads the active dataset version (or a specific one) and resolves the as-of date. */
export async function getDatasetContext(q: Q, workspaceId: string, opts: { asOfDate?: string | null; datasetVersionId?: string | null } = {}): Promise<DatasetContext | null> {
  const [w] = await q<{ active_dataset_version_id: string | null; data_version: string }>("select active_dataset_version_id, data_version from workspaces where id = $1", [workspaceId]);
  const dv = opts.datasetVersionId ?? w?.active_dataset_version_id;
  if (!dv) return null;
  const [v] = await q<{ id: string; label: string; is_demo: boolean; uploaded_at: Date; quality: { capabilities?: Capabilities; warnings?: string[]; rejected?: number; timezoneOffsetMinutes?: number }; row_counts: DatasetContext["rowCounts"]; status: string }>(
    "select id, label, is_demo, uploaded_at, quality, row_counts, status from dataset_versions where id = $1 and workspace_id = $2", [dv, workspaceId]);
  if (!v || v.status !== "ready") return null;
  const [e] = await q<{ name: string | null; starts_at: Date | null; ends_at: Date | null; history_start: Date | string | null; history_end: Date | string | null; currency: string | null }>(
    "select name, starts_at, ends_at, history_start::text, history_end::text, currency from event_info where dataset_version_id = $1", [dv]);
  const tz = v.quality?.timezoneOffsetMinutes ?? 330;
  let defaultAsOf = e?.history_end ? String(e.history_end) : null;
  if (!defaultAsOf) {
    const [mx] = await q<{ d: string | null }>(
      `select to_char(greatest(
         (select max(occurred_at) from check_ins where dataset_version_id = $1),
         (select max(registered_at) from registrations where dataset_version_id = $1),
         (select max(activity_date)::timestamptz from campaign_daily where dataset_version_id = $1)) + make_interval(mins => $2), 'YYYY-MM-DD') d`, [dv, tz]);
    defaultAsOf = mx?.d ?? todayIn(tz);
  }
  const asOfDate = opts.asOfDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.asOfDate) ? opts.asOfDate : defaultAsOf;
  return {
    workspaceId, dv, label: v.label, isDemo: v.is_demo, uploadedAt: new Date(v.uploaded_at).toISOString(),
    caps: { ...EMPTY_CAPS, ...(v.quality?.capabilities ?? {}) }, warnings: v.quality?.warnings ?? [], rowCounts: v.row_counts ?? {},
    rejected: v.quality?.rejected ?? 0, tzOffset: tz,
    event: e ? { name: e.name, startsAt: e.starts_at ? new Date(e.starts_at).toISOString() : null, endsAt: e.ends_at ? new Date(e.ends_at).toISOString() : null, historyStart: e.history_start ? String(e.history_start) : null, historyEnd: e.history_end ? String(e.history_end) : null, currency: e.currency } : null,
    asOfDate, asOf: endOfDayIso(asOfDate, tz), dataVersion: Number(w?.data_version ?? 0),
  };
}

export async function getStrategy(q: Q, workspaceId: string): Promise<{ version: number; config: StrategyConfig; createdAt: string | null; changeNote: string | null }> {
  const [r] = await q<{ version: number; config: StrategyConfig; created_at: Date; change_note: string | null }>(
    "select version, config, created_at, change_note from strategy_configs where workspace_id = $1 order by version desc limit 1", [workspaceId]);
  if (!r) return { version: 0, config: DEFAULT_STRATEGY, createdAt: null, changeNote: null };
  return { version: r.version, config: { ...DEFAULT_STRATEGY, ...r.config }, createdAt: new Date(r.created_at).toISOString(), changeNote: r.change_note };
}

// SQL fragments that adapt to what the dataset actually contains.
export function externalCond(ctx: DatasetContext, alias = "p") {
  return ctx.caps.personType ? `${alias}.person_type = 'external'` : "true";
}
export function verifiedCond(ctx: DatasetContext, alias = "c") {
  const parts: string[] = [];
  if (ctx.caps.checkinResult) parts.push(`${alias}.result = 'admitted'`);
  if (ctx.caps.checkinVerification) parts.push(`${alias}.verification = 'verified'`);
  return parts.length ? parts.join(" and ") : "true";
}
export function attendanceDefinition(ctx: DatasetContext) {
  const bits = ["distinct people with at least one check-in"];
  if (ctx.caps.checkinResult) bits.push("result = admitted");
  if (ctx.caps.checkinVerification) bits.push("verification = verified");
  if (ctx.caps.personType) bits.push("person type = external");
  return `Unique verified attendees = ${bits.join(", ")}, up to the end of ${ctx.asOfDate}. Repeat check-ins and both-day visits count once.`;
}
