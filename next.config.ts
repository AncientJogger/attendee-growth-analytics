import type { NextConfig } from "next";

// Every screen reads live, per-user data from Postgres, so we use dynamic
// rendering (the "previous model") instead of Cache Components.
const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "exceljs", "@electric-sql/pglite"],
  // The /setup page runs migrations and the seed from the deployed app, so ship those files with it.
  // Without DATABASE_URL every route runs on the embedded database, which needs the PGlite runtime
  // files and the pre-seeded snapshot at run time.
  outputFileTracingIncludes: {
    "/**": [
      "./data/fga-db.tar.gz",
      // A real Postgres that is still empty gets its tables and demo data on first use.
      "./supabase/migrations/**",
      "./data/attendee-dataset.xlsx",
      "./node_modules/@electric-sql/pglite/dist/*.{js,cjs,wasm,data}",
      "./node_modules/@electric-sql/pglite/package.json",
    ],
    "/setup": ["./supabase/migrations/**", "./data/**"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
