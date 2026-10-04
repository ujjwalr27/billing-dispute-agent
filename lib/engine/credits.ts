/**
 * Deterministic credit cap. A case can never be credited more than the
 * overcharge the engine computes from the current evidence, net of credits
 * already recorded in the payment history and credits already approved here.
 *
 * This is the guard against duplicate credits: it does not matter how many
 * times the agent is re-run or how many resolution options exist — the total
 * approved can't exceed what is actually owed.
 */
export interface CreditCapInput {
  /** engine delta (recalc - billed); negative means the customer was overcharged */
  deltaCents: number;
  /** credits already present in the supplied payment/adjustment history */
  historyCreditCents: number;
  /** credits already approved by reviewers in this app */
  approvedCents: number;
}

export interface CreditCap {
  /** total overcharge owed according to the engine (>= 0) */
  owedCents: number;
  /** how much more can still be credited (>= 0) */
  remainingCents: number;
  /** approved + history credits exceed what is owed (e.g. after new evidence) */
  overCredited: boolean;
}

export function creditCap({
  deltaCents,
  historyCreditCents,
  approvedCents,
}: CreditCapInput): CreditCap {
  const owedCents = Math.max(0, -deltaCents);
  // Credits are magnitudes. Clamp defensively so a negative value (a sign
  // convention mistake in imported data) can never ENLARGE the cap.
  const alreadyCredited = Math.max(0, historyCreditCents) + Math.max(0, approvedCents);
  return {
    owedCents,
    remainingCents: Math.max(0, owedCents - alreadyCredited),
    overCredited: alreadyCredited > owedCents,
  };
}
