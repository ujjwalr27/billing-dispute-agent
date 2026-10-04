import { defineConfig, devices } from "@playwright/test";
import { assertTestDatabase } from "./tests/test-db";

// Browser end-to-end tests. Playwright starts its own Next.js dev server on a
// separate port against a dedicated e2e test database, with the deterministic
// mock agent — so runs never touch your dev data or call a live LLM.
// Requires PostgreSQL (e.g. `docker compose up -d db`).
const PORT = Number(process.env.E2E_PORT ?? 3100);
const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://billing:billing@localhost:5433/billing_e2e_test?schema=public";
// Fail fast before anything touches a non-test database.
assertTestDatabase(E2E_DATABASE_URL);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Each test creates its own case, but one worker keeps the dev server's
  // on-demand compilation predictable.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Apply migrations (non-destructive; creates the DB if missing) before the
    // server starts — Playwright launches webServer before any global setup.
    command: `npx prisma migrate deploy && npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      AGENT_PROVIDER: "mock",
      GEMINI_API_KEY: "",
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
    },
  },
});
