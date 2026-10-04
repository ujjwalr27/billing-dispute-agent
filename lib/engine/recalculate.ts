import { allocateCents, sumCents } from "@/lib/money";
import type { EvidenceLineItem, EvidenceSnapshot, LineDiff, RecalcResult } from "@/lib/types";
import { evidenceHash } from "./hash";
import { evaluateRule, RuleEvaluationError } from "./rules";

/**
 * Deterministically recompute an invoice from its evidence and diff the result
 * against the invoice as billed.
 *
 *   - Lines without a pricing rule are passed through (expected = billed), so
 *     unmatched lines never produce phantom deltas.
 *   - Lines referencing a rule are recomputed from that rule and the usage.
 *     A rule is evaluated ONCE per invoice: when several lines share a rule
 *     (e.g. usage split across billing periods), the rule's total is allocated
 *     across them by line quantity, so the group is never double-counted.
 *   - Lines whose rule is missing or cannot price the usage are marked
 *     "unverifiable" with expected = billed — the engine never guesses.
 *
 * `deltaCents` is expected - billed; a negative total means the customer was
 * overcharged and may be owed a credit.
 */
export function recalculate(snapshot: EvidenceSnapshot): RecalcResult {
  const rulesByCode = new Map(snapshot.rules.map((r) => [r.code, r]));
  const diffs = new Map<string, LineDiff>();

  const unchanged = (line: EvidenceLineItem, status: LineDiff["status"], explanation: string) => {
    diffs.set(line.ref, {
      ref: line.ref,
      description: line.description,
      ruleCode: line.ruleCode,
      status,
      originalCents: line.amountCents,
      expectedCents: line.amountCents,
      deltaCents: 0,
      explanation,
    });
  };

  // Group rule-governed lines by rule code (in invoice order).
  const groups = new Map<string, EvidenceLineItem[]>();
  for (const line of snapshot.lineItems) {
    if (!line.ruleCode) {
      unchanged(line, "passthrough", "No pricing rule attached; line passed through unchanged.");
      continue;
    }
    groups.set(line.ruleCode, [...(groups.get(line.ruleCode) ?? []), line]);
  }

  for (const [code, lines] of groups) {
    const rule = rulesByCode.get(code);
    if (!rule) {
      for (const line of lines) {
        unchanged(
          line,
          "unverifiable",
          `Referenced rule "${code}" was not supplied; cannot recompute this line.`,
        );
      }
      continue;
    }

    let evaluation;
    try {
      evaluation = evaluateRule(rule, snapshot.usage);
    } catch (err) {
      if (!(err instanceof RuleEvaluationError)) throw err;
      for (const line of lines) unchanged(line, "unverifiable", `Cannot verify: ${err.message}`);
      continue;
    }

    const shares =
      lines.length === 1
        ? [evaluation.expectedCents]
        : allocateCents(
            evaluation.expectedCents,
            lines.map((l) => l.quantity),
          );
    const groupNote =
      lines.length === 1
        ? ""
        : ` Rule ${code} covers ${lines.length} lines (${lines
            .map((l) => l.ref)
            .join(", ")}); its total is allocated by line quantity.`;

    lines.forEach((line, i) => {
      diffs.set(line.ref, {
        ref: line.ref,
        description: line.description,
        ruleCode: code,
        status: "recomputed",
        originalCents: line.amountCents,
        expectedCents: shares[i],
        deltaCents: shares[i] - line.amountCents,
        explanation: evaluation.explanation + groupNote,
      });
    });
  }

  // Preserve invoice order.
  const lineDiffs = snapshot.lineItems.map((l) => diffs.get(l.ref)!);
  const originalTotalCents = sumCents(lineDiffs.map((d) => d.originalCents));
  const recalcTotalCents = sumCents(lineDiffs.map((d) => d.expectedCents));

  return {
    evidenceHash: evidenceHash(snapshot),
    originalTotalCents,
    recalcTotalCents,
    deltaCents: recalcTotalCents - originalTotalCents,
    lineDiffs,
  };
}
