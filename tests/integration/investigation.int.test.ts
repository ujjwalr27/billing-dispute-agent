import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockProvider } from "@/lib/agent/mock";
import { prisma } from "@/lib/db";
import { ambiguity, calcError, missingEvidence } from "@/prisma/scenarios";
import { actions, api, createCase, getCase, resetDb } from "./helpers";

beforeEach(resetDb);

const parse = (s: string) => JSON.parse(s);
const refs = (f: { citations: string }) =>
  parse(f.citations).map((c: any) => `${c.kind}:${c.ref}`).sort();

describe("AI investigation (deterministic mock provider)", () => {
  it("raises a cited CALC_ERROR and proposes the engine's credit on Acme", async () => {
    const id = await createCase(calcError);
    const res = await api.investigate(id);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ provider: "mock", toolFailures: [], droppedCitations: [] });

    const c = await getCase(id);
    expect(c.status).toBe("IN_REVIEW");
    expect(c.findings).toHaveLength(1);
    const [f] = c.findings;
    expect(f.type).toBe("CALC_ERROR");
    expect(f.reviewStatus).toBe("PENDING");
    expect(refs(f)).toEqual(["invoice:LI-2", "rule:RULE-DATA", "usage:USG-1", "usage:USG-2"]);

    const [opt] = c.resolutionOptions;
    expect(opt.proposedCreditCents).toBe(250); // taken from the engine, not invented
  });

  it("stores the engine's numbers separately from the AI interpretation", async () => {
    const id = await createCase(calcError);
    await api.investigate(id);
    const rec = await prisma.recalculation.findFirstOrThrow({ where: { caseId: id } });
    const finding = await prisma.finding.findFirstOrThrow({ where: { caseId: id } });

    expect(rec.deltaCents).toBe(-250);
    expect(finding.recalculationId).toBe(rec.id);
    expect(finding.evidenceHash).toBe(rec.evidenceHash);
  });

  it("classifies Borealis as CONTRACT_AMBIGUITY with no credit proposed", async () => {
    const id = await createCase(ambiguity);
    await api.investigate(id);
    const c = await getCase(id);

    expect(c.findings.map((f: any) => f.type)).toEqual(["CONTRACT_AMBIGUITY"]);
    expect(c.resolutionOptions.every((o: any) => o.proposedCreditCents === null)).toBe(true);
    expect(c.resolutionOptions[0].label).toMatch(/Uphold/);
  });

  it("asks for missing evidence on Cinder instead of guessing", async () => {
    const id = await createCase(missingEvidence);
    await api.investigate(id);
    const c = await getCase(id);

    const types = c.findings.map((f: any) => f.type);
    expect(types).toContain("MISSING_EVIDENCE");
    expect(types).not.toContain("CALC_ERROR");
    expect(c.resolutionOptions.every((o: any) => o.proposedCreditCents === null)).toBe(true);
    expect(c.resolutionOptions[0].label).toMatch(/Request missing/);
  });

  it("drops citations to evidence that doesn't exist (hallucination guard)", async () => {
    // Make the agent hallucinate: cite a rule and a usage event that were never
    // supplied, alongside a real citation.
    const spy = vi.spyOn(MockProvider.prototype, "investigate").mockResolvedValueOnce({
      findings: [
        {
          type: "MISSING_EVIDENCE",
          summary: "Overage rate unknown.",
          citations: [
            { kind: "invoice", ref: "LI-2" },
            { kind: "rule", ref: "RULE-INVENTED" },
            { kind: "usage", ref: "usage-events" },
          ],
        },
      ],
      resolutionOptions: [],
    });
    const id = await createCase(missingEvidence);
    const res = await api.investigate(id);
    spy.mockRestore();

    expect(res.data.droppedCitations).toEqual([
      { kind: "rule", ref: "RULE-INVENTED" },
      { kind: "usage", ref: "usage-events" },
    ]);
    const [f] = (await getCase(id)).findings;
    expect(refs(f)).toEqual(["invoice:LI-2"]);
  });

  it("returns 404 when investigating an unknown case", async () => {
    const res = await api.investigate("nope");
    expect(res.status).toBe(404);
  });
});

describe("partial tool failure", () => {
  it("degrades to MISSING_EVIDENCE instead of failing when usage is unavailable", async () => {
    const id = await createCase(calcError);
    const res = await api.investigate(id, { faultInject: "usage" });
    expect(res.status).toBe(200);
    expect(res.data.toolFailures).toEqual(["usage-events"]);

    const c = await getCase(id);
    expect(
      c.findings.some(
        (f: any) => f.type === "MISSING_EVIDENCE" && f.summary.includes("usage-events"),
      ),
    ).toBe(true);
  });

  it("never proposes money from incomplete evidence", async () => {
    // With usage missing, a naive recalculation would treat usage as zero and
    // report a bogus $15.00 overcharge. That must not happen.
    const id = await createCase(calcError);
    await api.investigate(id, { faultInject: "usage" });
    const c = await getCase(id);

    expect(c.findings.map((f: any) => f.type)).not.toContain("CALC_ERROR");
    expect(c.resolutionOptions.every((o: any) => o.proposedCreditCents === null)).toBe(true);
    expect(c.recalculations).toHaveLength(0); // no recalculation persisted from partial data
  });

  it("degrades the same way when pricing rules are unavailable", async () => {
    const id = await createCase(calcError);
    const res = await api.investigate(id, { faultInject: "rules" });
    expect(res.data.toolFailures).toEqual(["pricing-rules"]);
    const c = await getCase(id);
    expect(c.findings.map((f: any) => f.type)).not.toContain("CALC_ERROR");
  });

  it("recovers fully on the next investigation once the tool is back", async () => {
    const id = await createCase(calcError);
    await api.investigate(id, { faultInject: "usage" });
    await api.investigate(id);
    const c = await getCase(id);
    expect(c.findings.map((f: any) => f.type)).toEqual(["CALC_ERROR"]);
    expect(c.resolutionOptions[0].proposedCreditCents).toBe(250);
  });
});

describe("reviewer actions on findings", () => {
  async function investigatedFinding() {
    const id = await createCase(calcError);
    await api.investigate(id);
    const c = await getCase(id);
    return { caseId: id, findingId: c.findings[0].id as string };
  }

  it("accepts a finding", async () => {
    const { caseId, findingId } = await investigatedFinding();
    const res = await api.reviewFinding(findingId, { reviewStatus: "ACCEPTED" });
    expect(res.status).toBe(200);
    expect(res.data.reviewStatus).toBe("ACCEPTED");
    expect(actions(await getCase(caseId))).toContain("finding.reviewed");
  });

  it("edits a finding and keeps the reviewer's text", async () => {
    const { findingId } = await investigatedFinding();
    const res = await api.reviewFinding(findingId, {
      reviewStatus: "EDITED",
      editedText: "Overcharge confirmed with the billing team.",
    });
    expect(res.data).toMatchObject({
      reviewStatus: "EDITED",
      editedText: "Overcharge confirmed with the billing team.",
    });
  });

  it("rejects a finding", async () => {
    const { findingId } = await investigatedFinding();
    const res = await api.reviewFinding(findingId, { reviewStatus: "REJECTED" });
    expect(res.data.reviewStatus).toBe("REJECTED");
  });

  it("rejects an invalid review status with 400", async () => {
    const { findingId } = await investigatedFinding();
    const res = await api.reviewFinding(findingId, { reviewStatus: "MAYBE" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown finding", async () => {
    const res = await api.reviewFinding("nope", { reviewStatus: "ACCEPTED" });
    expect(res.status).toBe(404);
  });

  it("repeating the current decision is a no-op (no duplicate history)", async () => {
    const { caseId, findingId } = await investigatedFinding();
    await api.reviewFinding(findingId, { reviewStatus: "REJECTED" });
    const again = await api.reviewFinding(findingId, { reviewStatus: "REJECTED" });
    await api.reviewFinding(findingId, { reviewStatus: "REJECTED" });

    expect(again.status).toBe(200);
    expect(again.data.unchanged).toBe(true);
    const reviews = actions(await getCase(caseId)).filter((a) => a === "finding.reviewed");
    expect(reviews).toHaveLength(1);
  });

  it("records the previous and new status when a decision changes", async () => {
    const { caseId, findingId } = await investigatedFinding();
    await api.reviewFinding(findingId, { reviewStatus: "REJECTED" });
    await api.reviewFinding(findingId, { reviewStatus: "ACCEPTED" });
    const logs = (await getCase(caseId)).decisionLogs
      .filter((l: any) => l.action === "finding.reviewed")
      .map((l: any) => JSON.parse(l.payload))
      .reverse();
    expect(logs.map((p: any) => [p.from, p.to])).toEqual([
      ["PENDING", "REJECTED"],
      ["REJECTED", "ACCEPTED"],
    ]);
  });

  it("requires text when marking a finding EDITED", async () => {
    const { findingId } = await investigatedFinding();
    expect((await api.reviewFinding(findingId, { reviewStatus: "EDITED" })).status).toBe(400);
    expect(
      (await api.reviewFinding(findingId, { reviewStatus: "EDITED", editedText: "   " })).status,
    ).toBe(400);
  });

  it("clears reviewer text when an edited finding is later accepted", async () => {
    const { findingId } = await investigatedFinding();
    await api.reviewFinding(findingId, { reviewStatus: "EDITED", editedText: "note" });
    const res = await api.reviewFinding(findingId, { reviewStatus: "ACCEPTED" });
    expect(res.data).toMatchObject({ reviewStatus: "ACCEPTED", editedText: null });
  });

  it("refuses to review a stale finding until the investigation is re-run", async () => {
    const { caseId, findingId } = await investigatedFinding();
    await api.addEvidence(caseId, {
      usage: [{ ref: "USG-3", type: "data_gb", quantity: 10, occurredAt: "2026-01-28T00:00:00.000Z" }],
    });
    const res = await api.reviewFinding(findingId, { reviewStatus: "ACCEPTED" });
    expect(res.status).toBe(409);
    expect(res.error).toMatch(/Re-run the investigation/);
  });
});
