import { describe, expect, it } from "vitest";
import {
  addEvidenceSchema,
  approveAdjustmentSchema,
  lineItemInputSchema,
  paymentInputSchema,
  ruleInputSchema,
  usageInputSchema,
} from "./validation";

const at = "2026-01-01T00:00:00.000Z";
const tiered = (tiers: unknown) => ({
  code: "T",
  description: "d",
  kind: "TIERED",
  params: { usageType: "gb", tiers },
});

describe("evidence validation", () => {
  it("requires ascending tiers with only the last one unbounded", () => {
    expect(
      ruleInputSchema.safeParse(tiered([{ upTo: 100, unitPriceCents: 10 }, { upTo: null, unitPriceCents: 5 }])).success,
    ).toBe(true);
    expect(
      ruleInputSchema.safeParse(tiered([{ upTo: 500, unitPriceCents: 10 }, { upTo: 100, unitPriceCents: 5 }])).success,
    ).toBe(false);
    expect(
      ruleInputSchema.safeParse(tiered([{ upTo: null, unitPriceCents: 10 }, { upTo: 100, unitPriceCents: 5 }])).success,
    ).toBe(false);
  });

  it("accepts only positive payment / credit magnitudes", () => {
    const pay = (amountCents: number) => ({ ref: "C", kind: "CREDIT", amountCents, reason: "x", occurredAt: at });
    expect(paymentInputSchema.safeParse(pay(-200)).success).toBe(false);
    expect(paymentInputSchema.safeParse(pay(0)).success).toBe(false);
    expect(paymentInputSchema.safeParse(pay(200)).success).toBe(true);
  });

  it("rejects negative usage and negative prices", () => {
    expect(usageInputSchema.safeParse({ ref: "U", type: "gb", quantity: -5, occurredAt: at }).success).toBe(false);
    expect(
      ruleInputSchema.safeParse({
        code: "R",
        description: "d",
        kind: "PER_UNIT",
        params: { usageType: "gb", unitPriceCents: -1 },
      }).success,
    ).toBe(false);
  });

  it("rejects proration above 100%", () => {
    const rule = (activeDays: number) => ({
      code: "P",
      description: "d",
      kind: "PRORATED",
      params: { fullAmountCents: 3000, periodDays: 30, activeDays },
    });
    expect(ruleInputSchema.safeParse(rule(30)).success).toBe(true);
    expect(ruleInputSchema.safeParse(rule(31)).success).toBe(false);
  });

  it("rejects amounts the money columns can't store", () => {
    const line = (amountCents: number) => ({
      ref: "L",
      description: "d",
      ruleCode: null,
      quantity: 1,
      unitPriceCents: 1,
      amountCents,
    });
    expect(lineItemInputSchema.safeParse(line(3_000_000_000)).success).toBe(false);
    expect(lineItemInputSchema.safeParse(line(-500)).success).toBe(true); // discount line
    expect(
      approveAdjustmentSchema.safeParse({ amountCents: 3_000_000_000, reason: "r", idempotencyKey: "k" }).success,
    ).toBe(false);
  });

  it("rejects an evidence submission with nothing in it", () => {
    expect(addEvidenceSchema.safeParse({ rules: [], usage: [], payments: [] }).success).toBe(false);
    expect(addEvidenceSchema.safeParse({}).success).toBe(false);
  });
});
