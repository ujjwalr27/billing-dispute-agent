import { getCaseFull } from "@/lib/cases";
import { fail, handle, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = handle(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const c = await getCaseFull(id);
    if (!c) return fail("Case not found", 404);
    return ok(c);
  },
);
