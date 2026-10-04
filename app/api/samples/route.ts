import type { NextRequest } from "next/server";
import { z } from "zod";
import { createCase } from "@/lib/cases";
import { handle, ok } from "@/lib/http";
import { ambiguity, calcError, missingEvidence } from "@/prisma/scenarios";

export const dynamic = "force-dynamic";

// Lets reviewers of the hosted demo start from a fresh copy of a sample case
// instead of sharing (and resolving) the same seeded ones.
const SAMPLES = { calcError, ambiguity, missingEvidence } as const;
const bodySchema = z.object({ scenario: z.enum(["calcError", "ambiguity", "missingEvidence"]) });

export const POST = handle(async (req: NextRequest) => {
  const { scenario } = bodySchema.parse(await req.json());
  const created = await createCase(SAMPLES[scenario]);
  return ok({ id: created.id }, 201);
});
