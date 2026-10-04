// Case lifecycle, history preservation, derived staleness and idempotency-key
// misuse — regression coverage for the code-review findings.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { calcError } from "@/prisma/scenarios";
import { actions, api, createCase, credit, getCase, resetDb } from "./helpers";

beforeEach(resetDb);

async function investigatedCase() {
  const id = await createCase(calcError);
  await api.investigate(id);
  const c = await getCase(id);
  return { id, findingId: c.findings[0].id as string };
}

describe("history is preserved across re-investigation", () => {
  it("supersedes earlier findings instead of deleting them, keeping reviewer edits", async () => {
    const { id, findingId } = await investigatedCase();
    await api.reviewFinding(findingId, { reviewStatus: "EDITED", editedText: "Confirmed with billing." });

    await api.investigate(id);
    const c = await getCase(id);

    expect(c.findings).toHaveLength(1);
    expect(c.findings[0].id).not.toBe(findingId);
    expect(c.supersededFindings).toHaveLength(1);
    expect(c.supersededFindings[0]).toMatchObject({
      id: findingId,
      reviewStatus: "EDITED",
      editedText: "Confirmed with billing.",
    });
  });

  it("records the reviewer's edited text in the decision log", async () => {
    const { id, findingId } = await investigatedCase();
    await api.reviewFinding(findingId, { reviewStatus: "EDITED", editedText: "Tier misapplied." });
    const entry = (await getCase(id)).decisionLogs.find((l: any) => l.action === "finding.reviewed");
    expect(JSON.parse(entry.payload)).toMatchObject({ to: "EDITED", editedText: "Tier misapplied." });
  });

  it("refuses to review a superseded finding", async () => {
    const { id, findingId } = await investigatedCase();
    await api.investigate(id);
    const res = await api.reviewFinding(findingId, { reviewStatus: "ACCEPTED" });
    expect(res.status).toBe(409);
    expect(res.error).toMatch(/replaced by a newer investigation/);
  });
});

describe("staleness is derived from the current evidence", () => {
  it("marks findings stale even when evidence changes without going through addEvidence", async () => {
    // Simulates the race where evidence lands while an investigation is running:
    // nothing gets a chance to set a flag, but the hashes no longer match.
    const { id } = await investigatedCase();
    await prisma.usageEvent.create({
      data: { caseId: id, ref: "USG-LATE", type: "data_gb", quantity: 5, occurredAt: new Date("2026-01-30") },
    });
    const c = await getCase(id);
    expect(c.findings.every((f: any) => f.stale)).toBe(true);
    expect(c.resolutionOptions.every((o: any) => o.stale)).toBe(true);
  });

  it("treats new payment history as new evidence", async () => {
    const { id } = await investigatedCase();
    const res = await api.addEvidence(id, {
      payments: [
        { ref: "CR-1", kind: "CREDIT", amountCents: 250, reason: "credited by support", occurredAt: "2026-02-10T00:00:00.000Z" },
      ],
    });
    expect(res.data.reopened).toBe(true);
    const c = await getCase(id);
    expect(c.findings.every((f: any) => f.stale)).toBe(true);
    // ...and that credit already covers the overcharge
    expect((await api.approveCredit(id, credit(1, "more"))).status).toBe(409);
  });

  it("flags the stored recalculation as stale once evidence changes", async () => {
    const id = await createCase(calcError);
    await api.recalculate(id);
    expect((await getCase(id)).latestRecalculationStale).toBe(false);
    await api.addEvidence(id, {
      usage: [{ ref: "USG-3", type: "data_gb", quantity: 10, occurredAt: "2026-01-28T00:00:00.000Z" }],
    });
    expect((await getCase(id)).latestRecalculationStale).toBe(true);
    await api.recalculate(id);
    expect((await getCase(id)).latestRecalculationStale).toBe(false);
  });
});

describe("resolve / reopen lifecycle", () => {
  it("can't resolve before investigating", async () => {
    const id = await createCase(calcError);
    const res = await api.resolve(id);
    expect(res.status).toBe(409);
    expect(res.error).toMatch(/Run the investigation/);
  });

  it("can't resolve while findings are pending review", async () => {
    const { id } = await investigatedCase();
    const res = await api.resolve(id);
    expect(res.status).toBe(409);
    expect(res.error).toMatch(/1 pending/);
  });

  it("can't resolve while findings are stale", async () => {
    const { id, findingId } = await investigatedCase();
    await api.reviewFinding(findingId, { reviewStatus: "ACCEPTED" });
    await api.addEvidence(id, {
      usage: [{ ref: "USG-3", type: "data_gb", quantity: 10, occurredAt: "2026-01-28T00:00:00.000Z" }],
    });
    expect((await api.resolve(id)).status).toBe(409);
  });

  it("resolves a fully reviewed case and locks it until reopened", async () => {
    const { id, findingId } = await investigatedCase();
    await api.approveCredit(id, credit(250, "k1"));
    await api.reviewFinding(findingId, { reviewStatus: "ACCEPTED" });

    const res = await api.resolve(id, { note: "credited" });
    expect(res.status).toBe(200);
    const resolved = await getCase(id);
    expect(resolved.status).toBe("RESOLVED");
    const entry = resolved.decisionLogs.find((l: any) => l.action === "case.resolved");
    expect(JSON.parse(entry.payload)).toMatchObject({ note: "credited", creditedCents: 250 });

    // locked: no re-investigation, credits, or review changes
    expect((await api.investigate(id)).status).toBe(409);
    expect((await api.approveCredit(id, credit(1, "k2"))).status).toBe(409);
    expect((await api.reviewFinding(findingId, { reviewStatus: "REJECTED" })).status).toBe(409);
    expect((await api.resolve(id)).status).toBe(409);
  });

  it("only reopens resolved cases", async () => {
    const { id } = await investigatedCase();
    const res = await api.reopen(id);
    expect(res.status).toBe(409);
    expect(res.error).toMatch(/Only a resolved case/);
  });

  it("reopens a resolved case automatically when new evidence arrives", async () => {
    const { id, findingId } = await investigatedCase();
    await api.reviewFinding(findingId, { reviewStatus: "ACCEPTED" });
    await api.resolve(id);
    await api.addEvidence(id, {
      usage: [{ ref: "USG-3", type: "data_gb", quantity: 10, occurredAt: "2026-01-28T00:00:00.000Z" }],
    });
    const c = await getCase(id);
    expect(c.status).toBe("REOPENED");
    expect(actions(c)).toEqual([
      "case.created",
      "investigation.ran",
      "finding.reviewed",
      "case.resolved",
      "evidence.added",
    ]);
  });
});

describe("idempotency keys must identify one request", () => {
  it("rejects a key replayed with a different amount", async () => {
    const id = await createCase(calcError);
    await api.approveCredit(id, credit(100, "same"));
    const res = await api.approveCredit(id, credit(150, "same"));
    expect(res.status).toBe(422);
    expect(await prisma.adjustment.count({ where: { caseId: id } })).toBe(1);
  });

  it("rejects a key from another case instead of returning that case's credit", async () => {
    const a = await createCase(calcError);
    const b = await createCase(calcError);
    await api.approveCredit(a, credit(250, "shared-key"));
    const res = await api.approveCredit(b, credit(250, "shared-key"));
    expect(res.status).toBe(422);
    expect(res.data).toBeUndefined(); // case A's adjustment is not leaked
  });
});
