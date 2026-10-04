// Demo dispute scenarios. Shared by the seed script and the automated tests so
// both exercise exactly the same evidence.
import type { CreateCaseInput } from "../lib/validation";

const ISO = (d: string) => new Date(d).toISOString();

// Scenario 1 — a real calculation error (tier boundary applied wrong).
export const calcError: CreateCaseInput = {
  customerId: "CUST-ACME",
  customerName: "Acme Robotics",
  disputeDescription:
    "Our data usage charge looks far too high this month. We used about the same as last month but the bill nearly doubled.",
  invoice: {
    number: "INV-1001",
    currency: "USD",
    issuedAt: ISO("2026-02-01"),
    lineItems: [
      {
        ref: "LI-1",
        description: "Platform base fee",
        ruleCode: "RULE-BASE",
        quantity: 1,
        unitPriceCents: 9900,
        amountCents: 9900,
      },
      {
        ref: "LI-2",
        description: "Data transfer (GB)",
        ruleCode: "RULE-DATA",
        quantity: 150,
        unitPriceCents: 0,
        // billed as if ALL 150 GB are at the first-tier price (10c) = 1500;
        // the graduated tiers make the correct figure 1250.
        amountCents: 1500,
      },
    ],
  },
  rules: [
    {
      code: "RULE-BASE",
      description: "Flat monthly platform fee",
      kind: "FLAT",
      params: { amountCents: 9900 },
    },
    {
      code: "RULE-DATA",
      description: "Graduated data transfer pricing",
      kind: "TIERED",
      params: {
        usageType: "data_gb",
        tiers: [
          { upTo: 100, unitPriceCents: 10 },
          { upTo: null, unitPriceCents: 5 },
        ],
      },
    },
  ],
  usage: [
    { ref: "USG-1", type: "data_gb", quantity: 90, occurredAt: ISO("2026-01-10") },
    { ref: "USG-2", type: "data_gb", quantity: 60, occurredAt: ISO("2026-01-20") },
  ],
  payments: [
    {
      ref: "PAY-1",
      kind: "PAYMENT",
      amountCents: 11400,
      reason: "Paid in full on receipt",
      occurredAt: ISO("2026-02-03"),
    },
  ],
};

// Scenario 2 — internally consistent invoice; dispute is interpretation.
export const ambiguity: CreateCaseInput = {
  customerId: "CUST-BOREALIS",
  customerName: "Borealis Media",
  disputeDescription:
    "We were charged a full month for a plan we cancelled mid-month. We believe mid-month cancellations should be prorated, but the rep says the contract bills the full period once the month starts.",
  invoice: {
    number: "INV-2002",
    currency: "USD",
    issuedAt: ISO("2026-02-01"),
    lineItems: [
      {
        ref: "LI-1",
        description: "Pro plan subscription (monthly)",
        ruleCode: "RULE-SUB",
        quantity: 1,
        unitPriceCents: 20000,
        amountCents: 20000,
      },
      {
        ref: "LI-2",
        description: "Seats",
        ruleCode: "RULE-SEATS",
        quantity: 4,
        unitPriceCents: 2500,
        amountCents: 10000,
      },
    ],
  },
  rules: [
    {
      code: "RULE-SUB",
      description: "Monthly subscription, full-period billing (no mid-cycle proration)",
      kind: "FLAT",
      params: { amountCents: 20000 },
    },
    {
      code: "RULE-SEATS",
      description: "Per-seat charge",
      kind: "PER_UNIT",
      params: { usageType: "seat", unitPriceCents: 2500 },
    },
  ],
  usage: [
    { ref: "USG-1", type: "seat", quantity: 4, occurredAt: ISO("2026-01-01") },
  ],
  payments: [],
};

// Scenario 3 — missing evidence: a line references a rule not supplied.
export const missingEvidence: CreateCaseInput = {
  customerId: "CUST-CINDER",
  customerName: "Cinder Logistics",
  disputeDescription:
    "There's an 'API overage' charge on our bill but we can't find what rate it was calculated at, and we don't think we went over our included quota.",
  invoice: {
    number: "INV-3003",
    currency: "USD",
    issuedAt: ISO("2026-02-01"),
    lineItems: [
      {
        ref: "LI-1",
        description: "Platform base fee",
        ruleCode: "RULE-BASE",
        quantity: 1,
        unitPriceCents: 4900,
        amountCents: 4900,
      },
      {
        ref: "LI-2",
        description: "API overage",
        ruleCode: "RULE-OVERAGE", // intentionally NOT provided below
        quantity: 5000,
        unitPriceCents: 1,
        amountCents: 5000,
      },
    ],
  },
  rules: [
    {
      code: "RULE-BASE",
      description: "Flat monthly platform fee",
      kind: "FLAT",
      params: { amountCents: 4900 },
    },
    // RULE-OVERAGE deliberately omitted — the agent must ask for it.
  ],
  usage: [
    // No API usage events supplied either — reinforces the gap.
  ],
  payments: [],
};
