import { beforeEach, describe, expect, it } from "vitest";
import { ambiguity, calcError, missingEvidence } from "@/prisma/scenarios";
import { actions, api, createCase, getCase, resetDb } from "./helpers";

beforeEach(resetDb);

describe("case creation & retrieval", () => {
  it("creates a case from evidence and returns 201 with its id", async () => {
    const res = await api.createCase(calcError);
    expect(res.status).toBe(201);
    expect(res.data.id).toEqual(expect.any(String));

    const c = await getCase(res.data.id);
    expect(c.status).toBe("OPEN");
    expect(c.invoice.lineItems).toHaveLength(2);
    expect(c.pricingRules.map((r: any) => r.code).sort()).toEqual(["RULE-BASE", "RULE-DATA"]);
    expect(c.usageEvents).toHaveLength(2);
    expect(actions(c)).toEqual(["case.created"]);
  });

  it("lists all cases", async () => {
    await createCase(calcError);
    await createCase(ambiguity);
    await createCase(missingEvidence);
    const res = await api.listCases();
    expect(res.status).toBe(200);
    expect(res.data.map((c: any) => c.customerName).sort()).toEqual([
      "Acme Robotics",
      "Borealis Media",
      "Cinder Logistics",
    ]);
  });

  it("returns 404 for an unknown case", async () => {
    const res = await api.getCase("does-not-exist");
    expect(res.status).toBe(404);
    expect(res.ok).toBe(false);
  });

  it("rejects an invalid case with 400 and field-level details", async () => {
    const res = await api.createCase({ customerId: "" });
    expect(res.status).toBe(400);
    expect(res.error).toBe("Validation failed");
    expect(res.details.fieldErrors).toHaveProperty("customerId");
    expect(res.details.fieldErrors).toHaveProperty("invoice");
  });

  it("rejects malformed rule params (TIERED without tiers)", async () => {
    const bad = {
      ...calcError,
      rules: [{ code: "R", description: "bad", kind: "TIERED", params: { usageType: "gb" } }],
    };
    const res = await api.createCase(bad);
    expect(res.status).toBe(400);
  });

  it("rejects a non-JSON body without crashing", async () => {
    const res = await api.createCase("{not json");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.ok).toBe(false);
  });

  it("rejects a case whose evidence repeats a ref", async () => {
    const dup = {
      ...calcError,
      usage: [...calcError.usage, { ...calcError.usage[0] }],
    };
    const res = await api.createCase(dup);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.details)).toMatch(/Duplicate usage ref.*USG-1/);
  });
});
