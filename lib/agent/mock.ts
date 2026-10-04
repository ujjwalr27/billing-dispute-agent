import { formatCents } from "@/lib/money";
import type { Citation } from "@/lib/types";
import type { AgentOutput } from "@/lib/validation";
import type { AgentProvider, InvestigationContext } from "./provider";

/**
 * Deterministic, rules-based "agent". It reasons purely from the engine's
 * recalculation and the evidence — no randomness, no network — so the full
 * investigation flow works with no API key and CI is reproducible. It mirrors
 * the structure a real LLM is asked to produce: classified, cited findings plus
 * resolution options, and MISSING_EVIDENCE when the inputs are insufficient.
 */
export class MockProvider implements AgentProvider {
  readonly name = "mock";

  async investigate(ctx: InvestigationContext): Promise<AgentOutput> {
    const findings: AgentOutput["findings"] = [];
    const resolutionOptions: AgentOutput["resolutionOptions"] = [];

    // 1. Partial tool failure -> explicit MISSING_EVIDENCE, never a guess.
    for (const failure of ctx.toolFailures) {
      findings.push({
        type: "MISSING_EVIDENCE",
        summary: `Could not load "${failure}" while investigating. Conclusions may be incomplete until this evidence is available.`,
        citations: [],
      });
    }

    if (!ctx.recalc || !ctx.evidence) {
      findings.push({
        type: "MISSING_EVIDENCE",
        summary:
          "The invoice could not be recalculated because core evidence (invoice, rules, or usage) is missing.",
        citations: [],
      });
      return { findings, resolutionOptions };
    }

    const { recalc } = ctx;

    // 2. Lines whose referenced rule wasn't supplied -> MISSING_EVIDENCE.
    const unresolved = recalc.lineDiffs.filter((d) => d.status === "unverifiable");
    const ruleCodes = new Set(ctx.evidence.rules.map((r) => r.code));
    for (const line of unresolved) {
      const citations: Citation[] = [{ kind: "invoice", ref: line.ref }];
      const ruleMissing = !line.ruleCode || !ruleCodes.has(line.ruleCode);
      if (!ruleMissing && line.ruleCode) citations.push({ kind: "rule", ref: line.ruleCode });
      findings.push({
        type: "MISSING_EVIDENCE",
        summary: ruleMissing
          ? `Line ${line.ref} ("${line.description}") references pricing rule ${line.ruleCode}, which was not provided. The rule definition is needed to verify this charge.`
          : `Line ${line.ref} ("${line.description}") cannot be verified. ${line.explanation} More complete contract terms are needed.`,
        citations,
      });
    }

    // 3. Lines with a non-zero delta -> CALC_ERROR, cited to line + rule + usage.
    const mismatches = recalc.lineDiffs.filter((d) => d.deltaCents !== 0);
    for (const line of mismatches) {
      const citations: Citation[] = [{ kind: "invoice", ref: line.ref }];
      if (line.ruleCode) citations.push({ kind: "rule", ref: line.ruleCode });
      for (const u of relevantUsage(ctx, line.ruleCode)) {
        citations.push({ kind: "usage", ref: u.ref });
      }
      const dir = line.deltaCents < 0 ? "overcharged" : "undercharged";
      findings.push({
        type: "CALC_ERROR",
        summary: `Line ${line.ref} ("${line.description}") was ${dir}. Billed ${formatCents(
          line.originalCents,
        )} but the rule recomputes to ${formatCents(
          line.expectedCents,
        )} (difference ${formatCents(line.deltaCents)}). ${line.explanation}`,
        citations,
      });
    }

    // 4. Nothing wrong arithmetically -> the dispute is about interpretation.
    if (mismatches.length === 0 && unresolved.length === 0) {
      findings.push({
        type: "CONTRACT_AMBIGUITY",
        summary:
          "The invoice is internally consistent with the supplied rules and usage; no calculation error was found. The dispute appears to concern how the contract terms should be interpreted rather than an arithmetic mistake.",
        citations: ctx.evidence.lineItems
          .slice(0, 1)
          .map((li) => ({ kind: "invoice" as const, ref: li.ref })),
      });
    }

    // 5. Resolution options.
    const creditOwed = recalc.deltaCents < 0 ? Math.abs(recalc.deltaCents) : 0;
    if (creditOwed > 0) {
      resolutionOptions.push({
        label: `Issue credit of ${formatCents(creditOwed)}`,
        rationale: `The recalculation shows the customer was overcharged by ${formatCents(
          creditOwed,
        )} across ${mismatches.length} line(s). A credit of this amount makes the invoice correct.`,
        proposedCreditCents: creditOwed,
        citations: mismatches.map((m) => ({ kind: "invoice" as const, ref: m.ref })),
      });
    }
    if (unresolved.length > 0) {
      resolutionOptions.push({
        label: "Request missing pricing evidence before deciding",
        rationale:
          "One or more disputed lines cannot be verified with the supplied pricing rules. Request the missing or complete terms, add them as evidence, then re-investigate.",
        proposedCreditCents: null,
        citations: unresolved.map((m) => ({ kind: "invoice" as const, ref: m.ref })),
      });
    }
    if (creditOwed === 0 && unresolved.length === 0) {
      resolutionOptions.push({
        label: "Uphold the invoice as billed",
        rationale:
          "No overcharge was found. If the customer still disputes, the disagreement is about contract interpretation and should be escalated to a billing owner.",
        proposedCreditCents: null,
        citations: [],
      });
    }

    return { findings, resolutionOptions };
  }
}

function relevantUsage(ctx: InvestigationContext, ruleCode: string | null) {
  if (!ctx.evidence || !ruleCode) return [];
  const rule = ctx.evidence.rules.find((r) => r.code === ruleCode);
  if (!rule) return [];
  const usageType =
    "usageType" in rule.params ? (rule.params as { usageType: string }).usageType : null;
  if (!usageType) return [];
  return ctx.evidence.usage.filter((u) => u.type === usageType);
}
