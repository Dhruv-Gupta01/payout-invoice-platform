import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
    // All test files share one real Postgres test DB; several files do
    // unscoped deleteMany() cleanup, which races if files run in parallel.
    fileParallelism: false,
  },
});
