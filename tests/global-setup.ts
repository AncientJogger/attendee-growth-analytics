// Creates a fresh test workspace: migrations + full demo seed against TEST_DATABASE_URL.
export default async function setup() {
  // TEST_DATABASE_URL=embedded runs every test file against the shipped PGlite snapshot instead.
  if (process.env.TEST_DATABASE_URL === "embedded") return;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/fga_test?host=/tmp";
  const { seed } = await import("../scripts/seed");
  const { closePool } = await import("../src/lib/db");
  await seed({ reset: true, quiet: true });
  await closePool();
}
