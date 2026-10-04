import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ambiguity, calcError } from "@/prisma/scenarios";
import { actions, api, createCase, credit, getCase, resetDb } from "./helpers";

beforeEach(resetDb);

const totalApproved = async (caseId: string) =>
  (await prisma.adjustment.aggregate({ where: { caseId }, _sum: { amountCents: true } }))._sum
    .amountCents ?? 0;

describe("mock credits — duplicate prevention", () => {
  it("approves a credit up to the engine-computed overcharge", async () => {
    const id = await createCase(calcError);
    const res = await api.approveCredit(id, credit(250, "k1"));
    expect(res.status).toBe(201);
    expect(res.data.duplicate).toBe(false);
    expect(await totalApproved(id)).toBe(250);
    expect(actions(await getCase(id))).toContain("adjustment.approved");
  });

  it("is idempotent: the same key returns the existing credit (200, duplicate)", async () => {
    const id = await createCase(calcError);
    const first = await api.approveCredit(id, credit(250, "same-key"));
    const second = await api.approveCredit(id, credit(250, "same-key"));

    expect(second.status).toBe(200);
    expect(second.data.duplicate).toBe(true);
    expect(second.data.adjustment.id).toBe(first.data.adjustment.id);
    expect(await prisma.adjustment.count({ where: { caseId: id } })).toBe(1);
  });

  it("REGRESSION: re-running the investigation cannot credit the same dispute twice", async () => {
    // Previously each investigation recreated the resolution option with a new
    // id, the UI keyed idempotency on that id, and the total reached $5.00.
    const id = await createCase(calcError);
    await api.investigate(id);
    const opt1 = (await getCase(id)).resolutionOptions[0];
    expect((await api.approveCredit(id, credit(250, `${id}:${opt1.id}`))).status).toBe(201);

    await api.investigate(id);
    const opt2 = (await getCase(id)).resolutionOptions[0];
    expect(opt2.id).not.toBe(opt1.id); // new option, new key...
    const second = await api.approveCredit(id, credit(250, `${id}:${opt2.id}`));

    expect(second.status).toBe(409); // ...but still refused
    expect(second.error).toMatch(/exceeds the remaining creditable amount of \$0\.00/);
    expect(await totalApproved(id)).toBe(250);
  });

  it("serializes concurrent approvals: 5 parallel requests -> exactly one credit", async () => {
    const id = await createCase(calcError);
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => api.approveCredit(id, credit(250, `race-${i}`))),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    expect(await totalApproved(id)).toBe(250);
  });

  it("allows partial credits that together stay within the overcharge", async () => {
    const id = await createCase(calcError);
    expect((await api.approveCredit(id, credit(100, "p1"))).status).toBe(201);
    expect((await api.approveCredit(id, credit(150, "p2"))).status).toBe(201);
    expect((await api.approveCredit(id, credit(1, "p3"))).status).toBe(409);
    expect(await totalApproved(id)).toBe(250);
  });

  it("refuses a credit larger than the overcharge", async () => {
    const id = await createCase(calcError);
    const res = await api.approveCredit(id, credit(300, "too-much"));
    expect(res.status).toBe(409);
    expect(await totalApproved(id)).toBe(0);
  });

  it("refuses any credit when nothing is owed (contract ambiguity)", async () => {
    const id = await createCase(ambiguity);
    const res = await api.approveCredit(id, credit(1, "nothing-owed"));
    expect(res.status).toBe(409);
  });

  it("counts credits already in the payment history toward the cap", async () => {
    const withPriorCredit = {
      ...calcError,
      payments: [
        ...calcError.payments,
        {
          ref: "CR-1",
          kind: "CREDIT" as const,
          amountCents: 200,
          reason: "goodwill credit already issued",
          occurredAt: "2026-02-05T00:00:00.000Z",
        },
      ],
    };
    const id = await createCase(withPriorCredit);
    expect((await api.approveCredit(id, credit(100, "over"))).status).toBe(409);
    expect((await api.approveCredit(id, credit(50, "rest"))).status).toBe(201);
  });

  it("logs blocked attempts in the decision history", async () => {
    const id = await createCase(calcError);
    await api.approveCredit(id, credit(250, "ok"));
    await api.approveCredit(id, credit(250, "dup"));
    const log = actions(await getCase(id));
    expect(log).toContain("adjustment.approved");
    expect(log).toContain("adjustment.blocked");
  });

  it("rejects zero / negative amounts and missing keys with 400", async () => {
    const id = await createCase(calcError);
    expect((await api.approveCredit(id, credit(0, "zero"))).status).toBe(400);
    expect((await api.approveCredit(id, credit(-100, "neg"))).status).toBe(400);
    expect(
      (await api.approveCredit(id, { amountCents: 100, reason: "x", approvedBy: "r" })).status,
    ).toBe(400);
  });

  it("returns 404 when crediting an unknown case", async () => {
    const res = await api.approveCredit("nope", credit(100, "ghost"));
    expect(res.status).toBe(404);
  });
});
