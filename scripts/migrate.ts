/* Applies supabase/migrations/*.sql in order, once each. Usage: npx tsx scripts/migrate.ts */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { withSystem, closePool } from "../src/lib/db";

export async function migrate() {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  await withSystem(async (q) => {
    await q("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  });
  for (const f of files) {
    const done = await withSystem((q) => q("select 1 from schema_migrations where name = $1", [f]));
    if (done.length) continue;
    await withSystem(async (q) => {
      await q(readFileSync(path.join(dir, f), "utf8"));
      await q("insert into schema_migrations (name) values ($1)", [f]);
    });
    console.log(`applied ${f}`);
  }
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  migrate()
    .then(() => closePool())
    .catch(async (e) => {
      console.error(e);
      await closePool();
      process.exit(1);
    });
}
