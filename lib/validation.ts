import { z } from "zod";
import {
  CASE_STATUSES,
  CITATION_KINDS,
  FINDING_TYPES,
  PAYMENT_KINDS,
  RULE_KINDS,
} from "@/lib/types";

// ---- Money / quantity primitives ----

/** $10M in cents: well inside the 32-bit INTEGER money columns. */
export const MAX_CENTS = 1_000_000_000;
/** Non-negative price or amount in cents. */
const priceCents = z.number().int().nonnegative().max(MAX_CENTS);
/** Billed line amount; may be negative (e.g. a discount line). */
const signedCents = z.number().int().min(-MAX_CENTS).max(MAX_CENTS);
const quantity = z.number().nonnegative().max(1_000_000_000);

// ---- Rule params (discriminated by kind at the rule level) ----

const flatParams = z.object({ amountCents: priceCents });
const perUnitParams = z.object({
  usageType: z.string().min(1),
  unitPriceCents: priceCents,
});
const tieredParams = z.object({
  usageType: z.string().min(1),
  tiers: z
    .array(
      z.object({
        upTo: z.number().positive().nullable(),
        unitPriceCents: priceCents,
      }),
    )
    .min(1)
    .superRefine((tiers, ctx) => {
      let prev = 0;
      tiers.forEach((t, i) => {
        if (t.upTo === null && i !== tiers.length - 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Only the last tier may be unbounded (upTo: null)",
            path: [i, "upTo"],
          });
        }
        if (t.upTo !== null) {
          if (t.upTo <= prev) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Tier upTo values must be strictly ascending (${t.upTo} after ${prev})`,
              path: [i, "upTo"],
            });
          }
          prev = t.upTo;
        }
      });
    }),
});
const proratedParams = z
  .object({
    fullAmountCents: priceCents,
    periodDays: z.number().int().positive(),
    activeDays: z.number().int().nonnegative(),
  })
  .refine((p) => p.activeDays <= p.periodDays, {
    message: "activeDays cannot exceed periodDays",
    path: ["activeDays"],
  });

export const ruleInputSchema = z
  .object({
    code: z.string().min(1),
    description: z.string().min(1),
    kind: z.enum(RULE_KINDS),
    params: z.unknown(),
  })
  .superRefine((rule, ctx) => {
    const schemas = {
      FLAT: flatParams,
      PER_UNIT: perUnitParams,
      TIERED: tieredParams,
      PRORATED: proratedParams,
    } as const;
    const result = schemas[rule.kind].safeParse(rule.params);
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid params for ${rule.kind} rule: ${result.error.message}`,
        path: ["params"],
      });
    }
  });

export const usageInputSchema = z.object({
  ref: z.string().min(1),
  type: z.string().min(1),
  quantity,
  occurredAt: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
});

export const lineItemInputSchema = z.object({
  ref: z.string().min(1),
  description: z.string().min(1),
  ruleCode: z.string().nullable(),
  quantity,
  unitPriceCents: signedCents,
  amountCents: signedCents,
});

export const paymentInputSchema = z.object({
  ref: z.string().min(1),
  kind: z.enum(PAYMENT_KINDS),
  // Positive magnitude: a CREDIT of $2.00 is 200, never -200. (Allowing signs
  // would let a negative credit silently enlarge the creditable amount.)
  amountCents: z.number().int().positive().max(MAX_CENTS),
  reason: z.string(),
  occurredAt: z.string().datetime(),
});

/** Refs/codes identify evidence, so they must be unique within a payload. */
function uniqueBy<T>(key: (item: T) => string, what: string) {
  return (items: T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    for (const item of items) {
      const k = key(item);
      if (seen.has(k)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate ${what} "${k}"` });
      }
      seen.add(k);
    }
  };
}

export const createCaseSchema = z.object({
  customerId: z.string().min(1),
  customerName: z.string().min(1),
  disputeDescription: z.string().min(1),
  invoice: z.object({
    number: z.string().min(1),
    currency: z.string().default("USD"),
    issuedAt: z.string().datetime(),
    lineItems: z
      .array(lineItemInputSchema)
      .min(1)
      .max(200)
      .superRefine(uniqueBy((li) => li.ref, "line item ref")),
  }),
  rules: z.array(ruleInputSchema).superRefine(uniqueBy((r) => r.code, "rule code")),
  usage: z.array(usageInputSchema).superRefine(uniqueBy((u) => u.ref, "usage ref")),
  payments: z
    .array(paymentInputSchema)
    .default([])
    .superRefine(uniqueBy((p) => p.ref, "payment ref")),
});
export type CreateCaseInput = z.infer<typeof createCaseSchema>;

// ---- Evidence addition (reopen path) ----

export const addEvidenceSchema = z.object({
  rules: z.array(ruleInputSchema).default([]).superRefine(uniqueBy((r) => r.code, "rule code")),
  usage: z.array(usageInputSchema).default([]).superRefine(uniqueBy((u) => u.ref, "usage ref")),
  payments: z
    .array(paymentInputSchema)
    .default([])
    .superRefine(uniqueBy((p) => p.ref, "payment ref")),
  note: z.string().optional(),
}).refine((e) => e.rules.length + e.usage.length + e.payments.length > 0, {
  message: "Add at least one rule, usage event, or payment",
});
export type AddEvidenceInput = z.infer<typeof addEvidenceSchema>;

// ---- Reviewer actions ----

export const patchFindingSchema = z
  .object({
    reviewStatus: z.enum(["ACCEPTED", "EDITED", "REJECTED"]),
    editedText: z.string().trim().optional(),
  })
  .refine((v) => v.reviewStatus !== "EDITED" || (v.editedText ?? "").length > 0, {
    message: "editedText is required when reviewStatus is EDITED",
    path: ["editedText"],
  });
export type PatchFindingInput = z.infer<typeof patchFindingSchema>;

export const approveAdjustmentSchema = z.object({
  findingId: z.string().optional(),
  amountCents: z.number().int().positive().max(MAX_CENTS),
  reason: z.string().min(1),
  approvedBy: z.string().min(1).default("reviewer"),
  // supplied by the client to make the approval idempotent across retries
  idempotencyKey: z.string().min(1),
});
export type ApproveAdjustmentInput = z.infer<typeof approveAdjustmentSchema>;

// ---- Agent output (validated before persistence) ----

export const citationSchema = z.object({
  kind: z.enum(CITATION_KINDS),
  ref: z.string().min(1),
  note: z.string().optional(),
});

export const agentFindingSchema = z.object({
  type: z.enum(FINDING_TYPES),
  summary: z.string().min(1),
  citations: z.array(citationSchema).default([]),
});

export const agentResolutionSchema = z.object({
  label: z.string().min(1),
  rationale: z.string().min(1),
  proposedCreditCents: z.number().int().nullable().optional(),
  citations: z.array(citationSchema).default([]),
});

export const agentOutputSchema = z.object({
  findings: z.array(agentFindingSchema),
  resolutionOptions: z.array(agentResolutionSchema),
});
export type AgentOutput = z.infer<typeof agentOutputSchema>;

export const caseStatusSchema = z.enum(CASE_STATUSES);
