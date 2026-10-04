import { describe, expect, it } from "vitest";
import type { EvidenceRule, EvidenceSnapshot, EvidenceUsage } from "@/lib/types";
import { evaluateRule } from "./rules";
import { recalculate } from "./recalculate";
import { evidenceHash } from "./hash";
import { formatCents, scaleCents, toCents } from "@/lib/money";

const usage = (type: string, quantity: number, ref = "USG-1"): EvidenceUsage => ({
  ref,
  type,
  quantity,
  occurredAt: "2026-01-15T00:00:00.000Z",
});

describe("money", () => {
  it("avoids float error when scaling", () => {
    // 0.1 + 0.2 territory: 3 units at 10.1c each must be exactly 30c (rounded)
    expect(scaleCents(1010, 0.3)).toBe(303);
  });

  it("converts dollars to cents without float drift", () => {
    expect(toCents("19.99")).toBe(1999);
    expect(toCents(0.1 + 0.2)).toBe(30);
  });

  it("formats cents including negatives", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(-500)).toBe("-$5.00");
    expect(formatCents(7)).toBe("$0.07");
  });
});

describe("evaluateRule", () => {
  it("FLAT returns the fixed amount regardless of usage", () => {
    const rule: EvidenceRule = {
      code: "R",
      description: "base fee",
      kind: "FLAT",
      params: { amountCents: 5000 },
    };
    expect(evaluateRule(rule, []).expectedCents).toBe(5000);
    expect(evaluateRule(rule, [usage("anything", 999)]).expectedCents).toBe(5000);
  });

  it("PER_UNIT multiplies summed usage by the unit price", () => {
    const rule: EvidenceRule = {
      code: "R",
      description: "api calls",
      kind: "PER_UNIT",
      params: { usageType: "api_call", unitPriceCents: 2 },
    };
    const result = evaluateRule(rule, [
      usage("api_call", 100, "USG-1"),
      usage("api_call", 50, "USG-2"),
      usage("storage_gb", 10, "USG-3"), // different type, ignored
    ]);
    expect(result.expectedCents).toBe(300);
  });

  it("TIERED charges graduated tiers correctly", () => {
    const rule: EvidenceRule = {
      code: "R",
      description: "graduated usage",
      kind: "TIERED",
      params: {
        usageType: "gb",
        tiers: [
          { upTo: 100, unitPriceCents: 10 }, // first 100 @ 10c
          { upTo: 500, unitPriceCents: 5 }, // next 400 @ 5c
          { upTo: null, unitPriceCents: 1 }, // overage @ 1c
        ],
      },
    };
    // 600 units: 100*10 + 400*5 + 100*1 = 1000 + 2000 + 100 = 3100
    expect(evaluateRule(rule, [usage("gb", 600)]).expectedCents).toBe(3100);
    // exactly at a boundary: 100 units -> 1000
    expect(evaluateRule(rule, [usage("gb", 100)]).expectedCents).toBe(1000);
    // within first tier: 40 units -> 400
    expect(evaluateRule(rule, [usage("gb", 40)]).expectedCents).toBe(400);
  });

  it("PRORATED scales a full amount by active/period days", () => {
    const rule: EvidenceRule = {
      code: "R",
      description: "monthly seat",
      kind: "PRORATED",
      params: { fullAmountCents: 3000, periodDays: 30, activeDays: 10 },
    };
    expect(evaluateRule(rule, []).expectedCents).toBe(1000);
  });

  it("PRORATED throws on zero period", () => {
    const rule: EvidenceRule = {
      code: "R",
      description: "bad",
      kind: "PRORATED",
      params: { fullAmountCents: 3000, periodDays: 0, activeDays: 10 },
    };
    expect(() => evaluateRule(rule, [])).toThrow(/periodDays/);
  });
});

describe("recalculate", () => {
  const baseSnapshot: EvidenceSnapshot = {
    invoiceNumber: "INV-1",
    currency: "USD",
    rules: [
      {
        code: "RULE-TIER",
        description: "graduated gb",
        kind: "TIERED",
        params: {
          usageType: "gb",
          tiers: [
            { upTo: 100, unitPriceCents: 10 },
            { upTo: null, unitPriceCents: 5 },
          ],
        },
      },
    ],
    usage: [usage("gb", 150)],
    lineItems: [
      {
        ref: "LI-1",
        description: "data usage",
        ruleCode: "RULE-TIER",
        quantity: 150,
        unitPriceCents: 0,
        // billed as if all 150 @ 10c = 1500 (the overcharge bug)
        amountCents: 1500,
      },
    ],
  };

  it("detects an overcharge (negative delta = credit owed)", () => {
    const r = recalculate(baseSnapshot);
    // correct: 100@10 + 50@5 = 1000 + 250 = 1250
    expect(r.recalcTotalCents).toBe(1250);
    expect(r.originalTotalCents).toBe(1500);
    expect(r.deltaCents).toBe(-250);
    expect(r.lineDiffs[0].deltaCents).toBe(-250);
  });

  it("passes through lines with no rule", () => {
    const snap: EvidenceSnapshot = {
      ...baseSnapshot,
      lineItems: [
        {
          ref: "LI-2",
          description: "misc",
          ruleCode: null,
          quantity: 1,
          unitPriceCents: 999,
          amountCents: 999,
        },
      ],
    };
    const r = recalculate(snap);
    expect(r.deltaCents).toBe(0);
    expect(r.lineDiffs[0].explanation).toMatch(/passed through/);
  });

  it("does not guess when a referenced rule is missing", () => {
    const snap: EvidenceSnapshot = {
      ...baseSnapshot,
      rules: [], // rule referenced by LI-1 is absent
    };
    const r = recalculate(snap);
    expect(r.deltaCents).toBe(0);
    expect(r.lineDiffs[0].explanation).toMatch(/not supplied/);
  });
});

describe("evidenceHash", () => {
  const snap: EvidenceSnapshot = {
    invoiceNumber: "INV-1",
    currency: "USD",
    rules: [
      { code: "A", description: "a", kind: "FLAT", params: { amountCents: 100 } },
      { code: "B", description: "b", kind: "FLAT", params: { amountCents: 200 } },
    ],
    usage: [usage("x", 1, "USG-1"), usage("y", 2, "USG-2")],
    lineItems: [
      { ref: "LI-1", description: "", ruleCode: "A", quantity: 1, unitPriceCents: 100, amountCents: 100 },
    ],
  };

  it("is stable across array reordering", () => {
    const reordered: EvidenceSnapshot = {
      ...snap,
      rules: [snap.rules[1], snap.rules[0]],
      usage: [snap.usage[1], snap.usage[0]],
    };
    expect(evidenceHash(snap)).toBe(evidenceHash(reordered));
  });

  it("changes when evidence content changes", () => {
    const changed: EvidenceSnapshot = {
      ...snap,
      usage: [usage("x", 999, "USG-1"), snap.usage[1]],
    };
    expect(evidenceHash(snap)).not.toBe(evidenceHash(changed));
  });
});
