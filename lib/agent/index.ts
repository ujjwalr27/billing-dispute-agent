import { logger } from "@/lib/log";
import { prisma } from "@/lib/db";
import { evidenceHash } from "@/lib/engine/hash";
import { recalculate } from "@/lib/engine/recalculate";
import { loadEvidence, partitionCitations, validCitationRefs } from "@/lib/evidence";
import type { Citation, RecalcResult } from "@/lib/types";
import { agentOutputSchema, type AgentOutput } from "@/lib/validation";
import { AppError } from "@/lib/errors";
import { GeminiProvider } from "./gemini";
import { MockProvider } from "./mock";
import { sanitizeCredits } from "./sanitize";
import type { AgentProvider, InvestigationContext, PaymentContext } from "./provider";

export interface InvestigationResult {
  providerName: string;
  /**
   * Hash of the case's full evidence when the investigation started. Findings
   * record it, so they read as stale if evidence changes - even mid-run.
   */
  evidenceHash: string;
  recalc: RecalcResult | null;
  output: AgentOutput;
  /** citations the agent produced that referenced non-existent evidence */
  droppedCitations: Citation[];
  toolFailures: string[];
  /** credits the agent proposed that were removed by money-safety rules */
  creditAdjustments: string[];
}

export function selectProvider(): AgentProvider {
  const mode = (process.env.AGENT_PROVIDER ?? "auto").toLowerCase();
  const key = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash";
  const fallbackModels = (process.env.GEMINI_FALLBACK_MODELS ?? "gemini-3.1-flash-lite")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  if (mode === "mock") return new MockProvider();
  if (mode === "gemini") {
    if (!key) throw new Error("AGENT_PROVIDER=gemini but GEMINI_API_KEY is not set");
    return new GeminiProvider(key, model, { fallbackModels });
  }
  // auto
  return key ? new GeminiProvider(key, model, { fallbackModels }) : new MockProvider();
}

/**
 * Orchestrate an investigation for a case:
 *  1. assemble read-only context (evidence + deterministic recalc), tolerating
 *     partial failures of individual evidence sources;
 *  2. ask the agent to interpret it;
 *  3. if the real provider fails, fall back to the deterministic mock so the
 *     reviewer always gets a result;
 *  4. validate and strip any hallucinated citations before returning.
 *
 * `faultInject` lets a caller simulate a failing evidence tool for the demo.
 */
export async function investigateCase(
  caseId: string,
  opts: { faultInject?: "usage" | "rules" } = {},
): Promise<InvestigationResult> {
  const toolFailures: string[] = [];
  const started = Date.now();

  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c) throw new AppError(`Case ${caseId} not found`, 404);

  // --- assemble evidence, tolerating partial failure ---
  let evidence = await loadEvidence(caseId);
  const startHash = evidence ? evidenceHash(evidence) : "";
  if (opts.faultInject === "usage" && evidence) {
    toolFailures.push("usage-events");
    evidence = { ...evidence, usage: [] };
  }
  if (opts.faultInject === "rules" && evidence) {
    toolFailures.push("pricing-rules");
    evidence = { ...evidence, rules: [] };
  }

  const payments: PaymentContext[] = (evidence?.payments ?? []).map((p) => ({
    ref: p.ref,
    kind: p.kind,
    amountCents: p.amountCents,
    reason: p.reason,
  }));

  // --- deterministic recalculation (the only source of money figures) ---
  // The engine needs COMPLETE inputs: recalculating with missing usage or rules
  // would treat them as zero and invent an overcharge (and a credit). When a
  // pricing source failed, skip it and let the agent report missing evidence.
  const pricingInputsIncomplete = toolFailures.some(
    (f) => f === "usage-events" || f === "pricing-rules",
  );
  let recalc: RecalcResult | null = null;
  if (evidence && pricingInputsIncomplete) {
    // recalc stays null: no money figures from partial data
  } else if (evidence) {
    try {
      recalc = recalculate(evidence);
    } catch {
      toolFailures.push("recalculation-engine");
    }
  } else {
    toolFailures.push("evidence");
  }

  const ctx: InvestigationContext = {
    disputeDescription: c.disputeDescription,
    evidence,
    recalc,
    payments,
    toolFailures,
  };

  // --- run the agent, with mock fallback ---
  const primary = selectProvider();
  let providerName = primary.name;
  logger.info("agent.investigation.started", {
    caseId,
    provider: primary.name,
    toolFailures,
    recalculated: recalc !== null,
    faultInject: opts.faultInject,
  });
  let output: AgentOutput;
  try {
    output = agentOutputSchema.parse(await primary.investigate(ctx));
    if (primary instanceof GeminiProvider && primary.lastModelUsed) {
      providerName = `gemini (${primary.lastModelUsed})`;
    }
  } catch (err) {
    if (primary.name === "mock") throw err;
    logger.warn("agent.provider.fallback_to_mock", { caseId, provider: primary.name, err });
    // Real provider failed (network, bad JSON, etc.) — degrade to the mock so
    // the reviewer still gets a grounded result instead of an error page.
    providerName = `mock (fallback from ${primary.name}: ${
      err instanceof Error ? err.message : "unknown error"
    })`;
    output = agentOutputSchema.parse(await new MockProvider().investigate(ctx));
  }

  // --- money safety: the agent can't set credits the engine doesn't back ---
  const owedCents = recalc ? Math.max(0, -recalc.deltaCents) : null;
  const sanitized = sanitizeCredits(output, owedCents);
  output = sanitized.output;

  // --- reject hallucinated citations ---
  const valid = await validCitationRefs(caseId);
  const dropped: Citation[] = [];
  const clean = (cs: Citation[]) => {
    const { kept, dropped: d } = partitionCitations(cs, valid);
    dropped.push(...d);
    return kept;
  };
  output = {
    findings: output.findings.map((f) => ({ ...f, citations: clean(f.citations) })),
    resolutionOptions: output.resolutionOptions.map((o) => ({
      ...o,
      citations: clean(o.citations),
    })),
  };

  logger.info("agent.investigation.finished", {
    caseId,
    provider: providerName,
    durationMs: Date.now() - started,
    findings: output.findings.map((f) => f.type),
    resolutionOptions: output.resolutionOptions.length,
    toolFailures,
    droppedCitations: dropped.map((d) => `${d.kind}:${d.ref}`),
    creditAdjustments: sanitized.adjusted,
  });

  return {
    providerName,
    evidenceHash: startHash,
    recalc,
    output,
    droppedCitations: dropped,
    creditAdjustments: sanitized.adjusted,
    toolFailures,
  };
}
