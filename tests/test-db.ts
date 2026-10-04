// Shared test-database resolution + safety guard. Tests TRUNCATE and RESET this
// database, so refuse to touch anything that isn't clearly a test database.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://billing:billing@localhost:5433/billing_test?schema=public";

export function assertTestDatabase(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run tests against database "${dbName}": its name must contain "test". ` +
        "Set TEST_DATABASE_URL to a dedicated test database.",
    );
  }
}
