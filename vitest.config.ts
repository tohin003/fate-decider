import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Money-path tests run against a real Postgres, so give them room and
    // run test files serially — each file manages its own wallet rows and we
    // don't want cross-file interference on a shared database.
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/globalSetup.ts"],
    env: { LOG_LEVEL: "silent" },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
