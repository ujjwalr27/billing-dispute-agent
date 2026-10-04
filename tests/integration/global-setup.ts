import { execSync } from "node:child_process";
import { assertTestDatabase, TEST_DATABASE_URL } from "../test-db";

/**
 * Bring the test database schema up to date once per run. Uses the
 * non-destructive `migrate deploy` (creates the DB if missing, applies pending
 * migrations, never drops data); each test then starts from a clean slate via
 * resetDb() in tests/integration/helpers.ts.
 */
export default function setup() {
  assertTestDatabase(TEST_DATABASE_URL);
  execSync("npx prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });
}
