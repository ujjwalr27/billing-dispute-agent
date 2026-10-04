import type { NextRequest } from "next/server";
import { approveAdjustment } from "@/lib/cases";
import { approveAdjustmentSchema } from "@/lib/validation";
import { handle, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = handle(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const input = approveAdjustmentSchema.parse(await req.json());
    const { adjustment, duplicate } = await approveAdjustment(id, input);
    // 200 (not 201) on a duplicate: the idempotency guard returned the existing
    // credit rather than creating a second one.
    return ok({ adjustment, duplicate }, duplicate ? 200 : 201);
  },
);
