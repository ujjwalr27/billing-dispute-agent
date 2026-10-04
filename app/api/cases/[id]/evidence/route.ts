import type { NextRequest } from "next/server";
import { addEvidence } from "@/lib/cases";
import { addEvidenceSchema } from "@/lib/validation";
import { handle, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = handle(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const input = addEvidenceSchema.parse(await req.json());
    return ok(await addEvidence(id, input));
  },
);
