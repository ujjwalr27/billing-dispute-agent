// Regression tests for defects found in the code review. Each test names the
// behaviour that used to be wrong.
import { describe, expect, it } from "vitest";
import { allocateCents } from "@/lib/money";
import type { EvidenceRule, EvidenceSnapshot, EvidenceUsage } from "@/lib/types";
import { creditCap } from "./credits";
import { evidenceHash } from "./hash";
import { recalculate } from "./recalculate";
import { evaluateRule } from "./rules";

const usage = (quantity: number, ref = "U1"): EvidenceUsage => ({
  ref,
  type: "gb",
  quantity,
  occurredAt: "2026-01-15T00:00:00.000Z",
});

describe("shared rules across split lines", () => {
  it("allocates the rule's total instead of charging it once per line", () => {
    // Previously each line got the rule's FULL charge: 2000c vs 1000c billed.
    const r = recalculate({
      invoiceNumber: "I",
      currency: "USD",
      rules: [{ code: "R", description: "d", kind: "PER_UNIT", params: { usageType: "gb", unitPriceCents: 10 } }],
      usage: [usage(100)],
      lineItems: [
        { ref: "L1", description: "Jan 1-15", ruleCode: "R", quantity: 50, unitPriceCents: 10, amountCents: 500 },
        { ref: "L2", description: "Jan 16-31", ruleCode: "R", quantity: 50, unitPriceCents: 10, amountCents: 500 },
      ],
    });
    expect(r.recalcTotalCents).toBe(1000);
    expect(r.deltaCents).toBe(0);
    expect(r.lineDiffs.map((d) => d.expectedCents)).toEqual([500, 500]);
    expect(r.lineDiffs[0].explanation).toMatch(/covers 2 lines/);
  });
});

describe("rules that cannot price the usage", () => {
  it("marks usage beyond the last bounded tier unverifiable instead of pricing it at 0", () => {
    const r = recalculate({
      invoiceNumber: "I",
      currency: "USD",
      rules: [{ code: "T", description: "d", kind: "TIERED", params: { usageType: "gb", tiers: [{ upTo: 100, unitPriceCents: 10 }] } }],
      usage: [usage(150)],
      lineItems: [{ ref: "L1", description: "data", ruleCode: "T", quantity: 150, unitPriceCents: 10, amountCents: 1500 }],
    });
    expect(r.lineDiffs[0].status).toBe("unverifiable");
    expect(r.deltaCents).toBe(0); // no invented overcharge
    expect(r.lineDiffs[0].explanation).toMatch(/exceed the last tier/);
  });

  it("refuses to price tiers that are out of order", () => {
    const rule: EvidenceRule = {
      code: "T",
      description: "d",
      kind: "TIERED",
      params: {
        usageType: "gb",
        tiers: [
          { upTo: 500, unitPriceCents: 10 },
          { upTo: 100, unitPriceCents: 5 },
          { upTo: null, unitPriceCents: 1 },
        ],
      },
    };
    expect(() => evaluateRule(rule, [usage(600)])).toThrow(/ascending/);
  });

  it("refuses proration above 100%", () => {
    const rule: EvidenceRule = {
      code: "P",
      description: "d",
      kind: "PRORATED",
      params: { fullAmountCents: 3000, periodDays: 30, activeDays: 90 },
    };
    expect(() => evaluateRule(rule, [])).toThrow(/active days/);
  });

  it("labels each line with an explicit status", () => {
    const r = recalculate({
      invoiceNumber: "I",
      currency: "USD",
      rules: [{ code: "R", description: "d", kind: "FLAT", params: { amountCents: 100 } }],
      usage: [],
      lineItems: [
        { ref: "A", description: "a", ruleCode: null, quantity: 1, unitPriceCents: 5, amountCents: 5 },
        { ref: "B", description: "b", ruleCode: "R", quantity: 1, unitPriceCents: 100, amountCents: 100 },
        { ref: "C", description: "c", ruleCode: "MISSING", quantity: 1, unitPriceCents: 7, amountCents: 7 },
      ],
    });
    expect(r.lineDiffs.map((d) => d.status)).toEqual(["passthrough", "recomputed", "unverifiable"]);
  });
});

describe("staleness hash", () => {
  const snap: EvidenceSnapshot = { invoiceNumber: "I", currency: "USD", lineItems: [], rules: [], usage: [] };

  it("includes payment history", () => {
    const withPayment: EvidenceSnapshot = {
      ...snap,
      payments: [{ ref: "CR-1", kind: "CREDIT", amountCents: 250, reason: "goodwill", occurredAt: "2026-02-01T00:00:00.000Z" }],
    };
    expect(evidenceHash(withPayment)).not.toBe(evidenceHash(snap));
    expect(evidenceHash({ ...snap, payments: [] })).toBe(evidenceHash(snap));
  });

  it("orders refs by code unit, not locale", () => {
    const a: EvidenceSnapshot = { ...snap, usage: [usage(1, "b"), usage(1, "B"), usage(1, "a")] };
    const b: EvidenceSnapshot = { ...snap, usage: [usage(1, "a"), usage(1, "b"), usage(1, "B")] };
    expect(evidenceHash(a)).toBe(evidenceHash(b));
  });
});

describe("credit cap", () => {
  it("never lets a negative stored credit enlarge the cap", () => {
    // Previously: owed 250 with history -200 allowed 450 to be credited.
    expect(creditCap({ deltaCents: -250, historyCreditCents: -200, approvedCents: 0 }).remainingCents).toBe(250);
  });
});

describe("allocateCents", () => {
  it("splits exactly, with no cent lost or invented", () => {
    expect(allocateCents(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(allocateCents(1250, [100, 50])).toEqual([833, 417]);
  });
  it("splits evenly when all weights are zero", () => {
    expect(allocateCents(10, [0, 0])).toEqual([5, 5]);
  });
});
