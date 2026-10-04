import type { NextRequest } from "next/server";
import { patchFinding } from "@/lib/cases";
import { patchFindingSchema } from "@/lib/validation";
import { handle, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export const PATCH = handle(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const input = patchFindingSchema.parse(await req.json());
    const finding = await patchFinding(id, input);
    return ok(finding);
  },
);
