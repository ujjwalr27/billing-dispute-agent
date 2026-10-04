import { describe, expect, it } from "vitest";
import { creditCap } from "./credits";

describe("creditCap", () => {
  it("allows crediting the full overcharge when nothing is credited yet", () => {
    expect(creditCap({ deltaCents: -250, historyCreditCents: 0, approvedCents: 0 })).toEqual({
      owedCents: 250,
      remainingCents: 250,
      overCredited: false,
    });
  });

  it("leaves nothing remaining once the overcharge is fully credited", () => {
    const cap = creditCap({ deltaCents: -250, historyCreditCents: 0, approvedCents: 250 });
    expect(cap.remainingCents).toBe(0);
    expect(cap.overCredited).toBe(false);
  });

  it("counts credits already in the payment history", () => {
    const cap = creditCap({ deltaCents: -250, historyCreditCents: 100, approvedCents: 0 });
    expect(cap.remainingCents).toBe(150);
  });

  it("owes nothing when the customer was undercharged or billed correctly", () => {
    expect(creditCap({ deltaCents: 300, historyCreditCents: 0, approvedCents: 0 }).remainingCents).toBe(0);
    expect(creditCap({ deltaCents: 0, historyCreditCents: 0, approvedCents: 0 }).remainingCents).toBe(0);
  });

  it("flags over-crediting when new evidence lowers what is owed", () => {
    // $2.50 was approved, then new usage evidence reduced the overcharge to $2.00
    const cap = creditCap({ deltaCents: -200, historyCreditCents: 0, approvedCents: 250 });
    expect(cap.remainingCents).toBe(0);
    expect(cap.overCredited).toBe(true);
  });
});
