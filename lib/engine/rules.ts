import { isStorableCents, scaleCents, sumCents } from "@/lib/money";
import type {
  EvidenceRule,
  EvidenceUsage,
  FlatRuleParams,
  PerUnitRuleParams,
  ProratedRuleParams,
  TieredRuleParams,
} from "@/lib/types";

export interface RuleEvaluation {
  expectedCents: number;
  explanation: string;
}

/**
 * The rule cannot deterministically price the usage it was given (e.g. usage
 * beyond the last bounded tier). The line becomes "unverifiable" rather than
 * being priced with a guess.
 */
export class RuleEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleEvaluationError";
  }
}

/**
 * Evaluate a single pricing rule against the usage events, returning the
 * expected charge in whole cents plus a human-readable explanation of the
 * arithmetic. Pure and deterministic — no I/O, no AI.
 */
export function evaluateRule(
  rule: EvidenceRule,
  usage: EvidenceUsage[],
): RuleEvaluation {
  const result = evaluateByKind(rule, usage);
  if (!isStorableCents(result.expectedCents)) {
    throw new RuleEvaluationError(
      `Rule ${rule.code} evaluates to ${result.expectedCents}c, outside the supported amount range.`,
    );
  }
  return result;
}

function evaluateByKind(rule: EvidenceRule, usage: EvidenceUsage[]): RuleEvaluation {
  switch (rule.kind) {
    case "FLAT":
      return evalFlat(rule.params as FlatRuleParams);
    case "PER_UNIT":
      return evalPerUnit(rule.params as PerUnitRuleParams, usage);
    case "TIERED":
      return evalTiered(rule.params as TieredRuleParams, usage);
    case "PRORATED":
      return evalProrated(rule.params as ProratedRuleParams);
    default:
      // Exhaustiveness guard — unknown kinds must not silently return 0.
      throw new Error(`Unknown rule kind: ${(rule as EvidenceRule).kind}`);
  }
}

function evalFlat(p: FlatRuleParams): RuleEvaluation {
  return {
    expectedCents: p.amountCents,
    explanation: `Flat charge of ${p.amountCents}c.`,
  };
}

function totalUsage(usage: EvidenceUsage[], type: string): number {
  return usage
    .filter((u) => u.type === type)
    .reduce((acc, u) => acc + u.quantity, 0);
}

function evalPerUnit(
  p: PerUnitRuleParams,
  usage: EvidenceUsage[],
): RuleEvaluation {
  const qty = totalUsage(usage, p.usageType);
  const expectedCents = scaleCents(p.unitPriceCents, qty);
  return {
    expectedCents,
    explanation: `${qty} unit(s) of "${p.usageType}" x ${p.unitPriceCents}c = ${expectedCents}c.`,
  };
}

function evalTiered(
  p: TieredRuleParams,
  usage: EvidenceUsage[],
): RuleEvaluation {
  const qty = totalUsage(usage, p.usageType);
  let remaining = qty;
  let lowerBound = 0;
  const parts: number[] = [];
  const steps: string[] = [];

  for (const tier of p.tiers) {
    if (remaining <= 0) break;
    const upper = tier.upTo ?? Infinity;
    if (upper <= lowerBound) {
      throw new RuleEvaluationError(
        `Tiers for "${p.usageType}" are not in ascending order (upTo ${tier.upTo} after ${lowerBound}).`,
      );
    }
    const tierCapacity = upper - lowerBound;
    const unitsInTier = Math.min(remaining, tierCapacity);
    if (unitsInTier > 0) {
      const part = scaleCents(tier.unitPriceCents, unitsInTier);
      parts.push(part);
      steps.push(
        `${unitsInTier} @ ${tier.unitPriceCents}c` +
          (tier.upTo === null ? " (overage)" : ` (up to ${tier.upTo})`),
      );
      remaining -= unitsInTier;
    }
    lowerBound = upper;
  }

  if (remaining > 0) {
    // Usage beyond the last bounded tier has no defined price. Never treat it
    // as free — that would invent an overcharge.
    throw new RuleEvaluationError(
      `${remaining} unit(s) of "${p.usageType}" exceed the last tier (up to ${lowerBound}); the contract defines no price for them.`,
    );
  }

  const expectedCents = sumCents(parts);
  return {
    expectedCents,
    explanation: `Tiered on ${qty} unit(s) of "${p.usageType}": ${steps.join(
      " + ",
    )} = ${expectedCents}c.`,
  };
}

function evalProrated(p: ProratedRuleParams): RuleEvaluation {
  if (p.periodDays <= 0) {
    throw new RuleEvaluationError("Prorated rule requires periodDays > 0");
  }
  if (p.activeDays > p.periodDays) {
    throw new RuleEvaluationError(
      `Prorated rule has ${p.activeDays} active days in a ${p.periodDays}-day period.`,
    );
  }
  const factor = p.activeDays / p.periodDays;
  const expectedCents = scaleCents(p.fullAmountCents, factor);
  return {
    expectedCents,
    explanation: `${p.fullAmountCents}c prorated ${p.activeDays}/${p.periodDays} days = ${expectedCents}c.`,
  };
}
