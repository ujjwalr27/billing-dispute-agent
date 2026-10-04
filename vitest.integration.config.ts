import { defineConfig } from "vitest/config";
import path from "node:path";
import { TEST_DATABASE_URL } from "./tests/test-db";

// Integration tests: real route handlers against a real PostgreSQL test DB.
// Requires a reachable database (e.g. `docker compose up -d db`).
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.int.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    // One shared database: run files sequentially to keep state isolated.
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      LOG_LEVEL: "silent",
      DATABASE_URL: TEST_DATABASE_URL,
      // Deterministic agent: integration tests must not depend on a live LLM.
      AGENT_PROVIDER: "mock",
      GEMINI_API_KEY: "",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./") },
  },
});
