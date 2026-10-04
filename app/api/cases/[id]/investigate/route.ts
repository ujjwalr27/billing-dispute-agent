import type { NextRequest } from "next/server";
import { runInvestigation } from "@/lib/cases";
import { handle, ok } from "@/lib/http";

export const dynamic = "force-dynamic";
// The Gemini provider bounds itself to ~75s (retries + fallback model) before
// falling back to the mock; give the serverless function room for that.
export const maxDuration = 90;

export const POST = handle(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    // Optional { faultInject: "usage" | "rules" } to demo partial tool failure.
    const body = await req.json().catch(() => ({}));
    const faultInject =
      body?.faultInject === "usage" || body?.faultInject === "rules"
        ? body.faultInject
        : undefined;

    const result = await runInvestigation(id, { faultInject });
    return ok({
      provider: result.providerName,
      toolFailures: result.toolFailures,
      droppedCitations: result.droppedCitations,
      findings: result.output.findings.length,
      resolutionOptions: result.output.resolutionOptions.length,
    });
  },
);
