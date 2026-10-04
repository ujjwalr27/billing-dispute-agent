import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ambiguity, calcError, missingEvidence } from "@/prisma/scenarios";
import { actions, api, createCase, getCase, resetDb } from "./helpers";

beforeEach(resetDb);

describe("deterministic recalculation (original vs recalculated invoice)", () => {
  it("finds the $2.50 tier-boundary overcharge on Acme", async () => {
    const id = await createCase(calcError);
    const res = await api.recalculate(id);
    expect(res.status).toBe(200);
    expect(res.data.originalTotalCents).toBe(11400);
    expect(res.data.recalcTotalCents).toBe(11150);
    expect(res.data.deltaCents).toBe(-250);

    const li2 = res.data.lineDiffs.find((d: any) => d.ref === "LI-2");
    expect(li2).toMatchObject({ originalCents: 1500, expectedCents: 1250, deltaCents: -250 });
    const li1 = res.data.lineDiffs.find((d: any) => d.ref === "LI-1");
    expect(li1.deltaCents).toBe(0);
  });

  it("finds no discrepancy on the internally consistent Borealis invoice", async () => {
    const id = await createCase(ambiguity);
    const res = await api.recalculate(id);
    expect(res.data.deltaCents).toBe(0);
    expect(res.data.recalcTotalCents).toBe(30000);
  });

  it("does not guess when a referenced rule is missing (Cinder)", async () => {
    const id = await createCase(missingEvidence);
    const res = await api.recalculate(id);
    expect(res.data.deltaCents).toBe(0);
    const li2 = res.data.lineDiffs.find((d: any) => d.ref === "LI-2");
    expect(li2.explanation).toMatch(/not supplied/);
  });

  it("is idempotent per evidence snapshot (no duplicate rows or history spam)", async () => {
    const id = await createCase(calcError);
    const first = await api.recalculate(id);
    await api.recalculate(id);
    await api.recalculate(id);

    expect(await prisma.recalculation.count({ where: { caseId: id } })).toBe(1);
    const c = await getCase(id);
    expect(actions(c).filter((a) => a === "recalculation.ran")).toHaveLength(1);
    expect(c.recalculations[0].evidenceHash).toBe(first.data.evidenceHash);
  });

  it("records a new recalculation when the evidence changes", async () => {
    const id = await createCase(calcError);
    const before = await api.recalculate(id);
    await api.addEvidence(id, {
      usage: [{ ref: "USG-3", type: "data_gb", quantity: 10, occurredAt: "2026-01-28T00:00:00.000Z" }],
    });
    const after = await api.recalculate(id);

    expect(after.data.evidenceHash).not.toBe(before.data.evidenceHash);
    // 160 GB: 100 @ 10c + 60 @ 5c = 1300c, billed 1500c
    expect(after.data.deltaCents).toBe(-200);
    expect(await prisma.recalculation.count({ where: { caseId: id } })).toBe(2);
  });

  it("returns 404 when recalculating an unknown case", async () => {
    const res = await api.recalculate("nope");
    expect(res.status).toBe(404);
  });
});
