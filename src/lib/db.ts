import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Pool, types, type QueryResultRow } from "pg";
import type { PGlite } from "@electric-sql/pglite";

// Keep DATE columns as plain YYYY-MM-DD strings (no timezone shifting).
types.setTypeParser(1082, (v: string) => v);

/*
 * Two database modes:
 *  - DATABASE_URL set   → a real Postgres (Supabase or any other host) through `pg`. Data is permanent.
 *  - DATABASE_URL unset → an embedded Postgres (PGlite) inside the server process, started from the
 *    pre-seeded snapshot in data/fga-db.tar.gz. Nothing to configure, but changes only last while the
 *    server instance is alive; a cold start brings back the demo data.
 */

/** The minimal client surface the app uses. */
export interface DbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
}

export type Q = <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => Promise<T[]>;

export interface Actor {
  userId: string;
  workspaceId: string;
  role: "admin" | "campaign_manager" | "team_member";
}

declare global {
  var __fgaPool: Pool | undefined;
  var __fgaLite: Promise<PGlite> | undefined;
  var __fgaLiteLock: Promise<unknown> | undefined;
  var __fgaReady: Promise<void> | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const usingEmbeddedDb = () => !process.env.DATABASE_URL;

/**
 * Supabase signs its database certificate with its own CA, which Node does not trust. `pg` reads
 * `sslmode=require` in the URL as "verify the certificate" and that setting overrides the `ssl`
 * option, so the connection fails with SELF_SIGNED_CERT_IN_CHAIN. Take sslmode out of the URL and
 * set TLS explicitly: the connection stays encrypted, without CA verification.
 */
export function connectionOptions(url: string): { connectionString: string; ssl?: { rejectUnauthorized: boolean } } {
  let mode: string | null = null;
  let host = "";
  let connectionString = url;
  try {
    const u = new URL(url);
    mode = u.searchParams.get("sslmode");
    host = u.hostname;
    u.searchParams.delete("sslmode");
    connectionString = u.toString();
  } catch {
    // Not a parseable URL: hand it to pg as it is.
  }
  const ssl = mode ? mode !== "disable" : /supabase\.(co|com)$/.test(host);
  return { connectionString, ssl: ssl ? { rejectUnauthorized: false } : undefined };
}

function pool(): Pool {
  if (!globalThis.__fgaPool) {
    globalThis.__fgaPool = new Pool({
      ...connectionOptions(process.env.DATABASE_URL!),
      max: Number(process.env.DB_POOL_MAX ?? 6),
    });
  }
  return globalThis.__fgaPool;
}

/*
 * Automatic setup for a real Postgres. On the first query after a cold start:
 *  - empty database → create the tables and load the demo workspace (one transaction, takes up to a minute);
 *  - existing database → apply any migrations not yet applied.
 * Set AUTO_SETUP=false to turn this off and run `npm run db:migrate` / `npm run db:seed` yourself.
 * Two instances racing on an empty database is safe: the seed is one transaction with a fixed
 * workspace id, so the loser fails on the duplicate key and simply re-checks.
 */
const setupScope = new AsyncLocalStorage<boolean>();

async function ensurePgReady(): Promise<void> {
  if (process.env.AUTO_SETUP === "false" || setupScope.getStore()) return;
  if (!globalThis.__fgaReady) {
    globalThis.__fgaReady = setupScope
      .run(true, async () => {
        const hasData = async () => {
          const c = await pool().connect();
          try {
            const t = await c.query("select to_regclass('public.workspaces') is not null as ok");
            if (!t.rows[0].ok) return false;
            return ((await c.query("select 1 from workspaces limit 1")).rowCount ?? 0) > 0;
          } finally {
            c.release();
          }
        };
        if (await hasData()) {
          const { migrate } = await import("../../scripts/migrate");
          await migrate().catch((e) => console.error("[db] pending migrations failed", e));
          return;
        }
        console.log("[db] empty database: creating tables and loading the demo workspace");
        const t = Date.now();
        const { seed } = await import("../../scripts/seed");
        try {
          await seed({ reset: false, quiet: true });
        } catch (e) {
          if (!(await hasData())) throw e; // another instance won the race otherwise
        }
        console.log(`[db] setup finished in ${((Date.now() - t) / 1000).toFixed(1)} s`);
      })
      .catch((e) => {
        globalThis.__fgaReady = undefined;
        throw e;
      });
  }
  await globalThis.__fgaReady;
}

export const SNAPSHOT_PATH = path.join(process.cwd(), "data", "fga-db.tar.gz");

async function startLite(fresh = false): Promise<PGlite> {
  console.log("[db] starting embedded Postgres");
  const { PGlite } = await import("@electric-sql/pglite");
  // Match `pg`: dates, bigints and numerics come back as strings.
  const parsers = { 1082: (v: string) => v, 20: (v: string) => v, 1700: (v: string) => v };
  const snapshot = !fresh && existsSync(SNAPSHOT_PATH) ? new Blob([readFileSync(SNAPSHOT_PATH)]) : undefined;
  const t = Date.now();
  const db = await PGlite.create({ loadDataDir: snapshot, parsers });
  console.log(`[db] embedded Postgres ready in ${Date.now() - t} ms (${snapshot ? "from snapshot" : "empty"})`);
  if (!snapshot) {
    // No snapshot shipped: build the demo database now (slower first request).
    globalThis.__fgaLite = Promise.resolve(db);
    const { seed } = await import("../../scripts/seed");
    await seed({ reset: false, quiet: true });
  }
  return db;
}

export function lite(fresh = false): Promise<PGlite> {
  if (!globalThis.__fgaLite) {
    globalThis.__fgaLite = startLite(fresh).catch((e) => {
      globalThis.__fgaLite = undefined;
      throw e;
    });
  }
  return globalThis.__fgaLite;
}

function liteClient(db: PGlite): DbClient {
  return {
    async query(sql, params) {
      if (params && params.length) return { rows: (await db.query(sql, params as unknown[])).rows as QueryResultRow[] };
      // No parameters: allow several statements (migrations), return the last result.
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as QueryResultRow[] };
    },
  };
}

/** PGlite has one connection, so transactions take turns. */
async function liteLocked<T>(fn: () => Promise<T>): Promise<T> {
  const prev = globalThis.__fgaLiteLock ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  globalThis.__fgaLiteLock = prev.then(() => mine);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

function makeQ(client: DbClient): Q {
  return async (sql, params) => (await client.query(sql, params)).rows as never;
}

async function runTx<T>(client: DbClient, fn: (q: Q, client: DbClient) => Promise<T>, setupSql?: string) {
  try {
    // begin + role + identity travel together: one round trip instead of three.
    await client.query(setupSql ? `begin; ${setupSql}` : "begin");
    const out = await fn(makeQ(client), client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}

async function tx<T>(fn: (q: Q, client: DbClient) => Promise<T>, setupSql?: string): Promise<T> {
  if (usingEmbeddedDb()) {
    const db = await lite();
    return liteLocked(() => runTx(liteClient(db), fn, setupSql));
  }
  await ensurePgReady();
  const client = await pool().connect();
  try {
    return await runTx(client as unknown as DbClient, fn, setupSql);
  } finally {
    client.release();
  }
}

/** One read-only statement as the table owner, in a single round trip (no explicit transaction). */
export async function systemQuery<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]> {
  if (usingEmbeddedDb()) return withSystem((q) => q<T>(sql, params));
  await ensurePgReady();
  return (await pool().query<T>(sql, params as unknown[])).rows;
}

/** Runs as the table owner. Only for migrations, seeding, imports and session lookup. */
export function withSystem<T>(fn: (q: Q, client: DbClient) => Promise<T>): Promise<T> {
  return tx(fn);
}

/**
 * Runs as the restricted fga_app role with the actor's identity set, so Postgres
 * row-level security applies to every statement inside.
 */
export function withUser<T>(actor: Actor, fn: (q: Q, client: DbClient) => Promise<T>): Promise<T> {
  // The identity values are inlined (a multi-statement query cannot take parameters), so check their shape first.
  if (!UUID.test(actor.userId) || !UUID.test(actor.workspaceId) || !/^[a-z_]+$/.test(actor.role)) throw new Error("Invalid session identity");
  return tx(
    fn,
    `set local role fga_app; select set_config('app.user_id', '${actor.userId}', true), set_config('app.role', '${actor.role}', true), set_config('app.workspace_id', '${actor.workspaceId}', true)`,
  );
}

/** Bump the workspace data version so open dashboards refresh. */
export async function bumpVersion(q: Q, workspaceId: string) {
  await q("update workspaces set data_version = data_version + 1 where id = $1", [workspaceId]);
}

export async function audit(
  q: Q,
  a: { workspaceId: string; actorUserId: string | null; actorKind?: "user" | "ai" | "system"; action: string; entity: string; entityId?: string | null; before?: unknown; after?: unknown; reason?: string | null },
) {
  await q(
    `insert into audit_logs (workspace_id, actor_user_id, actor_kind, action, entity, entity_id, before, after, reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [a.workspaceId, a.actorUserId, a.actorKind ?? "user", a.action, a.entity, a.entityId ?? null,
     a.before === undefined ? null : JSON.stringify(a.before), a.after === undefined ? null : JSON.stringify(a.after), a.reason ?? null],
  );
}

export async function closePool() {
  await globalThis.__fgaPool?.end();
  globalThis.__fgaPool = undefined;
  if (globalThis.__fgaLite) {
    const db = await globalThis.__fgaLite.catch(() => null);
    await db?.close();
    globalThis.__fgaLite = undefined;
  }
}
