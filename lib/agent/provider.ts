import type { EvidenceSnapshot, RecalcResult } from "@/lib/types";
import type { AgentOutput } from "@/lib/validation";

export interface PaymentContext {
  ref: string;
  kind: string;
  amountCents: number;
  reason: string;
}

/**
 * Everything the agent is allowed to see. The agent interprets this read-only
 * context; it never performs arithmetic. All monetary figures here were
 * produced by the deterministic engine (`recalc`), not by the model.
 */
export interface InvestigationContext {
  disputeDescription: string;
  evidence: EvidenceSnapshot | null;
  recalc: RecalcResult | null;
  payments: PaymentContext[];
  /** names of evidence sources that failed to load (partial tool failure) */
  toolFailures: string[];
}

export interface AgentProvider {
  readonly name: string;
  investigate(ctx: InvestigationContext): Promise<AgentOutput>;
}
