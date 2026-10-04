import type { NextRequest } from "next/server";
import { reopenCase } from "@/lib/cases";
import { handle, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = handle(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    await reopenCase(id, "reviewer", body?.reason);
    return ok({ reopened: true });
  },
);
