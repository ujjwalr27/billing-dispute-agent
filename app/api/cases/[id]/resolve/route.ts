import type { NextRequest } from "next/server";
import { resolveCase } from "@/lib/cases";
import { handle, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = handle(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    await resolveCase(id, "reviewer", typeof body?.note === "string" ? body.note : undefined);
    return ok({ resolved: true });
  },
);
