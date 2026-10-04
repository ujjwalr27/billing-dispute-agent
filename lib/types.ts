// Shared domain types + the literal unions that back the String columns in the
// Prisma schema (SQLite has no native enums). These are the single source of
// truth; Zod schemas in lib/validation.ts validate against them.

export const CASE_STATUSES = ["OPEN", "IN_REVIEW", "RESOLVED", "REOPENED"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const RULE_KINDS = ["FLAT", "PER_UNIT", "TIERED", "PRORATED"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const PAYMENT_KINDS = ["PAYMENT", "CREDIT", "ADJUSTMENT"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const FINDING_TYPES = [
  "CALC_ERROR",
  "CONTRACT_AMBIGUITY",
  "MISSING_EVIDENCE",
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

export const REVIEW_STATUSES = ["PENDING", "ACCEPTED", "EDITED", "REJECTED"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const CITATION_KINDS = ["invoice", "usage", "rule", "payment"] as const;
export type CitationKind = (typeof CITATION_KINDS)[number];

export interface Citation {
  kind: CitationKind;
  /** stable human ref, e.g. "LI-1", "USG-3", "RULE-TIER-1" */
  ref: string;
  /** optional short note explaining the citation's relevance */
  note?: string;
}

// ---- Rule parameter shapes (stored as JSON string in PricingRule.params) ----

export interface FlatRuleParams {
  amountCents: number;
}

export interface PerUnitRuleParams {
  usageType: string;
  unitPriceCents: number;
}

export interface TieredRuleParams {
  usageType: string;
  /** graduated tiers; the final tier should use upTo: null (unbounded) */
  tiers: Array<{ upTo: number | null; unitPriceCents: number }>;
}

export interface ProratedRuleParams {
  fullAmountCents: number;
  periodDays: number;
  activeDays: number;
}

export type RuleParams =
  | ({ kind: "FLAT" } & FlatRuleParams)
  | ({ kind: "PER_UNIT" } & PerUnitRuleParams)
  | ({ kind: "TIERED" } & TieredRuleParams)
  | ({ kind: "PRORATED" } & ProratedRuleParams);

// ---- Engine I/O ----

export interface EvidenceRule {
  code: string;
  description: string;
  kind: RuleKind;
  params: FlatRuleParams | PerUnitRuleParams | TieredRuleParams | ProratedRuleParams;
}

export interface EvidenceUsage {
  ref: string;
  type: string;
  quantity: number;
  occurredAt: string; // ISO
}

export interface EvidenceLineItem {
  ref: string;
  description: string;
  ruleCode: string | null;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
}

export interface EvidencePayment {
  ref: string;
  kind: PaymentKind;
  /** positive magnitude in cents */
  amountCents: number;
  reason: string;
  occurredAt: string; // ISO
}

export interface EvidenceSnapshot {
  invoiceNumber: string;
  currency: string;
  lineItems: EvidenceLineItem[];
  rules: EvidenceRule[];
  usage: EvidenceUsage[];
  /**
   * Payment / adjustment history. Not used by the recalculation, but it is
   * evidence the agent reasons over, so it is part of the staleness hash.
   */
  payments?: EvidencePayment[];
}

export type LineStatus =
  /** no pricing rule attached: passed through unchanged */
  | "passthrough"
  /** recomputed from its pricing rule */
  | "recomputed"
  /** could not be verified (rule missing or rule can't price the usage) */
  | "unverifiable";

export interface LineDiff {
  ref: string;
  description: string;
  ruleCode: string | null;
  status: LineStatus;
  originalCents: number;
  expectedCents: number;
  /** expectedCents - originalCents; negative means the customer was overcharged */
  deltaCents: number;
  /** human-readable explanation of how expectedCents was derived */
  explanation: string;
}

export interface RecalcResult {
  evidenceHash: string;
  originalTotalCents: number;
  recalcTotalCents: number;
  /** recalcTotal - originalTotal; negative means overcharged (credit may be owed) */
  deltaCents: number;
  lineDiffs: LineDiff[];
}
