/* Builds data/fga-db.tar.gz: an embedded-Postgres (PGlite) copy of the seeded demo database.
 * The app starts from it when DATABASE_URL is not set. Usage: npx tsx scripts/build-snapshot.ts */
import { writeFileSync } from "node:fs";
delete process.env.DATABASE_URL;

async function main() {
  const { lite, SNAPSHOT_PATH, closePool } = await import("../src/lib/db");
  const t = Date.now();
  const db = await lite(true);
  const blob = await db.dumpDataDir("gzip");
  writeFileSync(SNAPSHOT_PATH, Buffer.from(await blob.arrayBuffer()));
  console.log(`snapshot written: ${SNAPSHOT_PATH} (${(blob.size / 1e6).toFixed(1)} MB, ${((Date.now() - t) / 1000).toFixed(1)}s)`);
  await closePool();
}
main().catch((e) => { console.error(e); process.exit(1); });
