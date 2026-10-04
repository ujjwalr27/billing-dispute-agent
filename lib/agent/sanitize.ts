import type { AgentOutput } from "@/lib/validation";

/**
 * Enforce money rules on the agent's output, whatever model produced it. The
 * LLM interprets; it does not get to set money figures the engine didn't back:
 *  - no recalculation (e.g. partial evidence) -> no credits at all;
 *  - zero/negative credits -> null (a "$0.00 credit" is not a resolution);
 *  - credits above the engine-computed overcharge -> null (invented amount).
 * Credits at or below the overcharge are kept (a reviewer may settle partially).
 */
export function sanitizeCredits(
  output: AgentOutput,
  owedCents: number | null,
): { output: AgentOutput; adjusted: string[] } {
  const adjusted: string[] = [];
  const resolutionOptions = output.resolutionOptions.map((o) => {
    const c = o.proposedCreditCents;
    if (c == null) return o;
    let reason: string | null = null;
    if (owedCents == null) reason = "no recalculation available";
    else if (c <= 0) reason = "non-positive amount";
    else if (c > owedCents) reason = `exceeds engine-computed overcharge of ${owedCents}c`;
    if (!reason) return o;
    adjusted.push(`"${o.label}": dropped credit ${c}c (${reason})`);
    return { ...o, proposedCreditCents: null };
  });
  return { output: { ...output, resolutionOptions }, adjusted };
}
