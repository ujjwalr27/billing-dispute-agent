// Vercel build: generate the Prisma client, apply migrations, seed the demo
// cases into an EMPTY database only, then build Next.js.
//
// Migrations need a direct (non-pooled) connection; Neon's Vercel integration
// exposes it as DATABASE_URL_UNPOOLED. The app itself uses DATABASE_URL.
import { execSync } from "node:child_process";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Connect a Postgres database to this Vercel project first.");
  process.exit(1);
}
const direct =
  process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL;

const run = (cmd, env = {}) =>
  execSync(cmd, { stdio: "inherit", env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1", ...env } });

run("npx prisma generate");
run("npx prisma migrate deploy", { DATABASE_URL: direct });
// Never wipe a hosted database on deploy: only seed when it has no cases.
if ((process.env.SEED ?? "if-empty") !== "false") {
  run("npx tsx prisma/seed.ts", { DATABASE_URL: direct, SEED_MODE: "if-empty" });
}
run("npx next build");
