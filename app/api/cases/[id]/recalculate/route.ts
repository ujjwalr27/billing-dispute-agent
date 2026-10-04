import { runRecalculation } from "@/lib/cases";
import { handle, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = handle(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const result = await runRecalculation(id);
    return ok(result);
  },
);
