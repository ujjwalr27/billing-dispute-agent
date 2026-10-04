import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    env: { LOG_LEVEL: "silent" },
    // Fast, DB-free unit tests. Integration (tests/integration) and browser
    // (tests/e2e) suites have their own configs/scripts.
    include: ["**/*.test.ts"],
    exclude: ["node_modules", ".next", "tests/integration/**", "tests/e2e/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
