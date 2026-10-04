// Fresh sample cases for reviewers of the hosted demo.
import { beforeEach, describe, expect, it } from "vitest";
import { api, getCase, resetDb } from "./helpers";

beforeEach(resetDb);

describe("POST /api/samples", () => {
  it("creates an independent copy of a demo scenario each time", async () => {
    const a = await api.createSample({ scenario: "calcError" });
    const b = await api.createSample({ scenario: "calcError" });
    expect(a.status).toBe(201);
    expect(a.data.id).not.toBe(b.data.id);
    const c = await getCase(a.data.id);
    expect(c.customerName).toBe("Acme Robotics");
    expect(c.status).toBe("OPEN");
  });

  it("rejects unknown scenarios", async () => {
    const res = await api.createSample({ scenario: "dropTables" });
    expect(res.status).toBe(400);
  });
});
