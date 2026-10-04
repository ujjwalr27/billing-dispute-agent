import { describe, expect, it } from "vitest";
import { recalculate } from "@/lib/engine/recalculate";
import { partitionCitations } from "@/lib/evidence";
import type { Citation, EvidenceSnapshot } from "@/lib/types";
import { MockProvider } from "./mock";
import type { InvestigationContext } from "./provider";

function ctxFor(
  snapshot: EvidenceSnapshot,
  overrides: Partial<InvestigationContext> = {},
): InvestigationContext {
  return {
    disputeDescription: "Charge looks too high.",
    evidence: snapshot,
    recalc: recalculate(snapshot),
    payments: [],
    toolFailures: [],
    ...overrides,
  };
}

const overchargeSnapshot: EvidenceSnapshot = {
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
  usage: [{ ref: "USG-1", type: "gb", quantity: 150, occurredAt: "2026-01-15T00:00:00.000Z" }],
  lineItems: [
    {
      ref: "LI-1",
      description: "data usage",
      ruleCode: "RULE-TIER",
      quantity: 150,
      unitPriceCents: 0,
      amountCents: 1500, // should be 1250
    },
  ],
};

describe("MockProvider", () => {
  it("produces a cited CALC_ERROR and a credit option on overcharge", async () => {
    const out = await new MockProvider().investigate(ctxFor(overchargeSnapshot));
    const calc = out.findings.find((f) => f.type === "CALC_ERROR");
    expect(calc).toBeDefined();
    // cites the line, the rule, and the usage event
    expect(calc!.citations.map((c) => c.ref).sort()).toEqual(["LI-1", "RULE-TIER", "USG-1"]);
    const credit = out.resolutionOptions.find((o) => o.proposedCreditCents === 250);
    expect(credit).toBeDefined();
  });

  it("flags MISSING_EVIDENCE when a referenced rule is absent", async () => {
    const snap = { ...overchargeSnapshot, rules: [] };
    const out = await new MockProvider().investigate(ctxFor(snap));
    expect(out.findings.some((f) => f.type === "MISSING_EVIDENCE")).toBe(true);
    // must not fabricate a calc error or credit when it cannot verify
    expect(out.findings.some((f) => f.type === "CALC_ERROR")).toBe(false);
  });

  it("reports a tool failure as MISSING_EVIDENCE", async () => {
    const out = await new MockProvider().investigate(
      ctxFor(overchargeSnapshot, { toolFailures: ["payment-history"] }),
    );
    expect(
      out.findings.some(
        (f) => f.type === "MISSING_EVIDENCE" && f.summary.includes("payment-history"),
      ),
    ).toBe(true);
  });

  it("classifies a consistent invoice as CONTRACT_AMBIGUITY", async () => {
    const correct: EvidenceSnapshot = {
      ...overchargeSnapshot,
      lineItems: [{ ...overchargeSnapshot.lineItems[0], amountCents: 1250 }],
    };
    const out = await new MockProvider().investigate(ctxFor(correct));
    expect(out.findings.some((f) => f.type === "CONTRACT_AMBIGUITY")).toBe(true);
    expect(out.findings.some((f) => f.type === "CALC_ERROR")).toBe(false);
  });
});

describe("partitionCitations", () => {
  it("drops citations whose refs do not exist", () => {
    const valid = {
      invoice: new Set(["LI-1"]),
      rule: new Set(["RULE-TIER"]),
      usage: new Set<string>(),
      payment: new Set<string>(),
    };
    const citations: Citation[] = [
      { kind: "invoice", ref: "LI-1" },
      { kind: "invoice", ref: "LI-99" }, // hallucinated
      { kind: "usage", ref: "USG-1" }, // not in valid set
    ];
    const { kept, dropped } = partitionCitations(citations, valid);
    expect(kept.map((c) => c.ref)).toEqual(["LI-1"]);
    expect(dropped.map((c) => c.ref).sort()).toEqual(["LI-99", "USG-1"]);
  });
});
