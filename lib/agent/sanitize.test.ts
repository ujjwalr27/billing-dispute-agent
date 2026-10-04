import { describe, expect, it } from "vitest";
import type { AgentOutput } from "@/lib/validation";
import { sanitizeCredits } from "./sanitize";

const withCredit = (proposedCreditCents: number | null): AgentOutput => ({
  findings: [],
  resolutionOptions: [{ label: "opt", rationale: "r", proposedCreditCents, citations: [] }],
});
const creditOf = (o: AgentOutput) => o.resolutionOptions[0].proposedCreditCents;

describe("sanitizeCredits", () => {
  it("keeps a credit equal to the engine-computed overcharge", () => {
    const { output, adjusted } = sanitizeCredits(withCredit(250), 250);
    expect(creditOf(output)).toBe(250);
    expect(adjusted).toEqual([]);
  });

  it("keeps a partial credit below the overcharge", () => {
    expect(creditOf(sanitizeCredits(withCredit(100), 250).output)).toBe(100);
  });

  it("drops a $0.00 credit (seen live from Gemini on the ambiguity case)", () => {
    const { output, adjusted } = sanitizeCredits(withCredit(0), 0);
    expect(creditOf(output)).toBeNull();
    expect(adjusted[0]).toMatch(/non-positive/);
  });

  it("drops a credit larger than what the engine says is owed", () => {
    const { output, adjusted } = sanitizeCredits(withCredit(1500), 250);
    expect(creditOf(output)).toBeNull();
    expect(adjusted[0]).toMatch(/exceeds/);
  });

  it("drops all credits when there is no recalculation", () => {
    expect(creditOf(sanitizeCredits(withCredit(250), null).output)).toBeNull();
  });

  it("leaves options without a credit untouched", () => {
    const { output, adjusted } = sanitizeCredits(withCredit(null), 250);
    expect(creditOf(output)).toBeNull();
    expect(adjusted).toEqual([]);
  });
});
