import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { createCase } from "@/lib/cases";
import { createCaseSchema } from "@/lib/validation";
import { handle, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const cases = await prisma.case.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      invoice: { select: { number: true, currency: true } },
      _count: { select: { findings: { where: { supersededAt: null } }, adjustments: true } },
    },
  });
  return ok(cases);
});

export const POST = handle(async (req: NextRequest) => {
  const body = await req.json();
  const input = createCaseSchema.parse(body);
  const created = await createCase(input);
  return ok({ id: created.id }, 201);
});
