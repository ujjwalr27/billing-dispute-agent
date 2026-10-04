import { beforeEach, describe, expect, it } from "vitest";
import { getCreditStatus } from "@/lib/cases";
import { calcError, missingEvidence } from "@/prisma/scenarios";
import { actions, api, createCase, credit, getCase, resetDb } from "./helpers";

beforeEach(resetDb);

const missingRule = {
  rules: [
    {
      code: "RULE-OVERAGE",
      description: "API overage pricing",
      kind: "PER_UNIT",
      params: { usageType: "api_call", unitPriceCents: 1 },
    },
  ],
  usage: [{ ref: "USG-API-1", type: "api_call", quantity: 3000, occurredAt: "2026-01-25T00:00:00.000Z" }],
  note: "Billing team supplied the overage rate",
};

describe("reopening on new evidence & staleness", () => {
  it("adding evidence reopens the case and marks earlier conclusions stale", async () => {
    const id = await createCase(missingEvidence);
    await api.investigate(id);
    const before = await getCase(id);
    expect(before.findings.every((f: any) => f.stale === false)).toBe(true);

    const res = await api.addEvidence(id, missingRule);
    expect(res.status).toBe(200);

    const after = await getCase(id);
    expect(after.status).toBe("REOPENED");
    expect(after.findings.length).toBeGreaterThan(0);
    expect(after.findings.every((f: any) => f.stale)).toBe(true);
    expect(after.resolutionOptions.every((o: any) => o.stale)).toBe(true);
    // decisions taken before the reopen are still on record
    expect(actions(after)).toEqual(["case.created", "investigation.ran", "evidence.added"]);
  });

  it("re-investigating after new evidence refreshes conclusions with the new facts", async () => {
    const id = await createCase(missingEvidence);
    await api.investigate(id);
    await api.addEvidence(id, missingRule);
    await api.investigate(id);

    const c = await getCase(id);
    expect(c.status).toBe("IN_REVIEW");
    expect(c.findings.every((f: any) => f.stale === false)).toBe(true);
    // 3000 calls @ 1c = $30.00, billed $50.00 -> $20.00 overcharge now provable
    expect(c.findings.map((f: any) => f.type)).toContain("CALC_ERROR");
    expect(c.resolutionOptions.find((o: any) => o.proposedCreditCents)?.proposedCreditCents).toBe(2000);
  });

  it("findings stay fresh when nothing changed", async () => {
    const id = await createCase(calcError);
    await api.investigate(id);
    await api.recalculate(id);
    const c = await getCase(id);
    expect(c.findings.every((f: any) => f.stale === false)).toBe(true);
  });

  it("flags over-crediting when new evidence lowers what is owed", async () => {
    const id = await createCase(calcError);
    expect((await api.approveCredit(id, credit(250, "before"))).status).toBe(201);

    // late usage: 160 GB -> engine now says only $2.00 was overcharged
    await api.addEvidence(id, {
      usage: [{ ref: "USG-3", type: "data_gb", quantity: 10, occurredAt: "2026-01-28T00:00:00.000Z" }],
    });

    const status = await getCreditStatus(id);
    expect(status).toMatchObject({ owedCents: 200, approvedCents: 250, remainingCents: 0, overCredited: true });
    expect((await api.approveCredit(id, credit(1, "after"))).status).toBe(409);
  });

  it("rejects invalid evidence with 400 and leaves the case untouched", async () => {
    const id = await createCase(calcError);
    await api.investigate(id);
    const res = await api.addEvidence(id, {
      rules: [{ code: "BAD", description: "x", kind: "TIERED", params: { usageType: "gb" } }],
    });
    expect(res.status).toBe(400);
    const c = await getCase(id);
    expect(c.status).toBe("IN_REVIEW");
    expect(c.findings.every((f: any) => f.stale === false)).toBe(true);
  });

  it("reopens a resolved case via the reopen endpoint and records why", async () => {
    const id = await createCase(calcError);
    await api.investigate(id);
    const [f] = (await getCase(id)).findings;
    await api.reviewFinding(f.id, { reviewStatus: "ACCEPTED" });
    expect((await api.resolve(id)).status).toBe(200);

    const res = await api.reopen(id, { reason: "customer sent a new statement" });
    expect(res.status).toBe(200);

    const c = await getCase(id);
    expect(c.status).toBe("REOPENED");
    const entry = c.decisionLogs.find((l: any) => l.action === "case.reopened");
    expect(JSON.parse(entry.payload)).toEqual({ reason: "customer sent a new statement" });
  });

  it("returns 404 when reopening or adding evidence to an unknown case", async () => {
    expect((await api.reopen("nope")).status).toBe(404);
    const res = await api.addEvidence("nope", {
      usage: [{ ref: "U", type: "data_gb", quantity: 1, occurredAt: "2026-01-01T00:00:00.000Z" }],
    });
    expect(res.status).toBe(404);
  });

  it("re-submitting identical evidence is a no-op: no duplicate rows, no reopen", async () => {
    const id = await createCase(missingEvidence);
    await api.addEvidence(id, missingRule);
    await api.investigate(id); // refresh -> IN_REVIEW, findings fresh

    const again = await api.addEvidence(id, missingRule);
    expect(again.status).toBe(200);
    expect(again.data).toMatchObject({ reopened: false });
    expect(again.data.skipped.sort()).toEqual(["RULE-OVERAGE", "USG-API-1"]);

    const c = await getCase(id);
    expect(c.status).toBe("IN_REVIEW");
    expect(c.usageEvents.filter((u: any) => u.ref === "USG-API-1")).toHaveLength(1);
    expect(c.findings.every((f: any) => f.stale === false)).toBe(true);
    expect(actions(c).filter((a) => a === "evidence.added")).toHaveLength(1);
  });

  it("refuses to overwrite a recorded usage event with different values (409, nothing written)", async () => {
    const id = await createCase(calcError);
    const res = await api.addEvidence(id, {
      usage: [
        { ref: "USG-NEW", type: "data_gb", quantity: 5, occurredAt: "2026-01-29T00:00:00.000Z" },
        { ref: "USG-1", type: "data_gb", quantity: 9999, occurredAt: "2026-01-10T00:00:00.000Z" },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.error).toMatch(/USG-1 already exists/);

    const c = await getCase(id);
    expect(c.status).toBe("OPEN"); // transaction rolled back, not reopened
    expect(c.usageEvents.map((u: any) => u.ref).sort()).toEqual(["USG-1", "USG-2"]);
    expect(c.usageEvents.find((u: any) => u.ref === "USG-1").quantity).toBe(90);
  });

  it("treats a corrected rule (same code, new terms) as new evidence", async () => {
    const id = await createCase(calcError);
    await api.investigate(id);
    const res = await api.addEvidence(id, {
      rules: [
        {
          code: "RULE-DATA",
          description: "Graduated data transfer pricing (corrected tiers)",
          kind: "TIERED",
          params: { usageType: "data_gb", tiers: [{ upTo: 100, unitPriceCents: 10 }, { upTo: null, unitPriceCents: 4 }] },
        },
      ],
    });
    expect(res.data).toMatchObject({ reopened: true, updatedRules: ["RULE-DATA"] });
    const c = await getCase(id);
    expect(c.findings.every((f: any) => f.stale)).toBe(true);
    // 100 @ 10c + 50 @ 4c = 1200c vs billed 1500c
    expect((await api.recalculate(id)).data.deltaCents).toBe(-300);
  });

  it("rejects duplicate refs within one submission with 400", async () => {
    const id = await createCase(calcError);
    const u = { ref: "USG-DUP", type: "data_gb", quantity: 1, occurredAt: "2026-01-29T00:00:00.000Z" };
    const res = await api.addEvidence(id, { usage: [u, u] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.details)).toMatch(/Duplicate usage ref/);
  });
});
