import { prisma } from "../lib/db";
import { createCase } from "../lib/cases";
import { ambiguity, calcError, missingEvidence } from "./scenarios";

/**
 * SEED_MODE:
 *   "reset"    (default, e.g. `npm run seed`): wipe all cases, load the demos
 *   "if-empty" (container start): load the demos only into an empty database,
 *              so restarts never destroy existing cases or decision history
 */
async function main() {
  const mode = process.env.SEED_MODE ?? "reset";
  if (mode === "if-empty") {
    const existing = await prisma.case.count();
    if (existing > 0) {
      console.log(`Database already has ${existing} case(s); skipping demo seed.`);
      return;
    }
  }

  // Clean slate (cascades remove all related rows).
  await prisma.case.deleteMany({});

  const s1 = await createCase(calcError);
  const s2 = await createCase(ambiguity);
  const s3 = await createCase(missingEvidence);

  // eslint-disable-next-line no-console
  console.log("Seeded 3 cases:");
  console.log(`  1. Calculation error      -> ${s1.id} (Acme Robotics)`);
  console.log(`  2. Contract ambiguity     -> ${s2.id} (Borealis Media)`);
  console.log(`  3. Missing evidence       -> ${s3.id} (Cinder Logistics)`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
