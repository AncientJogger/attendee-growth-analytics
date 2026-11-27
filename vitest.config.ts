import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src"), "server-only": path.resolve(__dirname, "tests/server-only-stub.ts") } },
  test: {
    globalSetup: ["tests/global-setup.ts"],
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL === "embedded" ? "" : (process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/fga_test?host=/tmp"), SESSION_SECRET: "test-secret-test-secret-test-secret-123" },
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 120000,
  },
});
