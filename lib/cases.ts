import { logger } from "@/lib/log";
import type { Adjustment, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { formatCents, isStorableCents } from "@/lib/money";
import { creditCap, type CreditCap } from "@/lib/engine/credits";
import { investigateCase } from "@/lib/agent";
import {
  currentEvidenceHash,
  evidenceInclude,
  loadEvidence,
  snapshotFromCase,
} from "@/lib/evidence";
import { evidenceHash } from "@/lib/engine/hash";
import { recalculate } from "@/lib/engine/recalculate";
import type { RecalcResult } from "@/lib/types";
import type {
  AddEvidenceInput,
  ApproveAdjustmentInput,
  CreateCaseInput,
  PatchFindingInput,
} from "@/lib/validation";

/** Append an immutable entry to the case's decision history. */
export async function logDecision(
  caseId: string,
  actor: string,
  action: string,
  payload: Record<string, unknown> = {},
) {
  await prisma.decisionLog.create({
    data: { caseId, actor, action, payload: JSON.stringify(payload) },
  });
}

/** Load a case's status, or 404. */
async function requireCase(caseId: string, db: Prisma.TransactionClient = prisma) {
  const c = await db.case.findUnique({ where: { id: caseId }, select: { id: true, status: true } });
  if (!c) throw new AppError("Case not found", 404);
  return c;
}

/** Resolved cases are closed: they must be reopened before further changes. */
function assertNotResolved(status: string, action: string) {
  if (status === "RESOLVED") {
    throw new AppError(`This case is resolved. Reopen it before you ${action}.`, 409);
  }
}

/** Money columns are 32-bit; refuse totals that can't be stored faithfully. */
function assertStorable(recalc: RecalcResult) {
  for (const v of [recalc.originalTotalCents, recalc.recalcTotalCents, recalc.deltaCents]) {
    if (!isStorableCents(v)) {
      throw new AppError("Invoice totals exceed the supported amount range.", 422);
    }
  }
}

export async function createCase(input: CreateCaseInput) {
  const created = await prisma.case.create({
    data: {
      customerId: input.customerId,
      customerName: input.customerName,
      disputeDescription: input.disputeDescription,
      status: "OPEN",
      invoice: {
        create: {
          number: input.invoice.number,
          currency: input.invoice.currency,
          issuedAt: new Date(input.invoice.issuedAt),
          lineItems: {
            create: input.invoice.lineItems.map((li) => ({
              ref: li.ref,
              description: li.description,
              ruleCode: li.ruleCode,
              quantity: li.quantity,
              unitPriceCents: li.unitPriceCents,
              amountCents: li.amountCents,
            })),
          },
        },
      },
      pricingRules: {
        create: input.rules.map((r) => ({
          code: r.code,
          description: r.description,
          kind: r.kind,
          params: JSON.stringify(r.params),
        })),
      },
      usageEvents: {
        create: input.usage.map((u) => ({
          ref: u.ref,
          type: u.type,
          quantity: u.quantity,
          occurredAt: new Date(u.occurredAt),
          metadata: JSON.stringify(u.metadata ?? {}),
        })),
      },
      payments: {
        create: input.payments.map((p) => ({
          ref: p.ref,
          kind: p.kind,
          amountCents: p.amountCents,
          reason: p.reason,
          occurredAt: new Date(p.occurredAt),
        })),
      },
    },
  });
  await logDecision(created.id, "system", "case.created", {
    customer: input.customerName,
  });
  return created;
}

/**
 * Run ONLY the deterministic recalculation (no AI) and persist it. Lets the
 * reviewer see the original-vs-recalculated comparison independently of the
 * agent's interpretation.
 */
export async function runRecalculation(caseId: string, actor = "system") {
  const evidence = await loadEvidence(caseId);
  if (!evidence) throw new AppError("Case or invoice not found", 404);
  const result = recalculate(evidence);
  assertStorable(result);

  // Recalculation is deterministic: the same evidence snapshot always yields the
  // same result. If the latest recalculation was computed from this exact
  // evidence hash, reuse it instead of persisting a duplicate row and spamming
  // the decision history with identical "recalculation.ran" entries.
  const latest = await prisma.recalculation.findFirst({
    where: { caseId },
    orderBy: { createdAt: "desc" },
  });
  if (latest?.evidenceHash === result.evidenceHash) {
    return result;
  }

  const rec = await prisma.recalculation.create({
    data: {
      caseId,
      evidenceHash: result.evidenceHash,
      originalTotalCents: result.originalTotalCents,
      recalcTotalCents: result.recalcTotalCents,
      deltaCents: result.deltaCents,
      lineDiffs: JSON.stringify(result.lineDiffs),
    },
  });
  await logDecision(caseId, actor, "recalculation.ran", {
    recalculationId: rec.id,
    deltaCents: result.deltaCents,
  });
  return result;
}

/**
 * Run the agent investigation and persist its results for review.
 *
 * Earlier findings/options are marked superseded rather than deleted, so
 * reviewer decisions and edits on them remain part of the case history.
 */
export async function runInvestigation(
  caseId: string,
  opts: { faultInject?: "usage" | "rules"; actor?: string } = {},
) {
  assertNotResolved((await requireCase(caseId)).status, "re-investigate it");
  const result = await investigateCase(caseId, { faultInject: opts.faultInject });
  if (result.recalc) assertStorable(result.recalc);

  let evidenceChangedMidRun = false;
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    await tx.finding.updateMany({
      where: { caseId, supersededAt: null },
      data: { supersededAt: now },
    });
    await tx.resolutionOption.updateMany({
      where: { caseId, supersededAt: null },
      data: { supersededAt: now },
    });

    let recalculationId: string | null = null;
    if (result.recalc) {
      const rec = await tx.recalculation.create({
        data: {
          caseId,
          evidenceHash: result.recalc.evidenceHash,
          originalTotalCents: result.recalc.originalTotalCents,
          recalcTotalCents: result.recalc.recalcTotalCents,
          deltaCents: result.recalc.deltaCents,
          lineDiffs: JSON.stringify(result.recalc.lineDiffs),
        },
      });
      recalculationId = rec.id;
    }

    // Findings record the evidence the investigation STARTED from. If evidence
    // was added while the agent was running, they will read as stale.
    for (const f of result.output.findings) {
      await tx.finding.create({
        data: {
          caseId,
          recalculationId,
          type: f.type,
          summary: f.summary,
          citations: JSON.stringify(f.citations),
          evidenceHash: result.evidenceHash,
        },
      });
    }
    for (const o of result.output.resolutionOptions) {
      await tx.resolutionOption.create({
        data: {
          caseId,
          label: o.label,
          rationale: o.rationale,
          proposedCreditCents: o.proposedCreditCents ?? null,
          citations: JSON.stringify(o.citations),
          evidenceHash: result.evidenceHash,
        },
      });
    }

    evidenceChangedMidRun = (await currentEvidenceHash(caseId, tx)) !== result.evidenceHash;
    await tx.case.update({
      where: { id: caseId },
      data: { status: evidenceChangedMidRun ? "REOPENED" : "IN_REVIEW" },
    });
  });

  await logDecision(caseId, opts.actor ?? "agent", "investigation.ran", {
    provider: result.providerName,
    toolFailures: result.toolFailures,
    droppedCitations: result.droppedCitations,
    creditAdjustments: result.creditAdjustments,
    findingCount: result.output.findings.length,
    evidenceChangedMidRun,
  });

  return result;
}

export async function patchFinding(
  findingId: string,
  input: PatchFindingInput,
  actor = "reviewer",
) {
  const current = await prisma.finding.findUnique({ where: { id: findingId } });
  if (!current) throw new AppError("Finding not found", 404);
  if (current.supersededAt) {
    throw new AppError("This finding was replaced by a newer investigation.", 409);
  }
  const { status } = await requireCase(current.caseId);
  assertNotResolved(status, "change review decisions");
  if ((await currentEvidenceHash(current.caseId)) !== current.evidenceHash) {
    throw new AppError(
      "This finding is based on earlier evidence. Re-run the investigation before reviewing it.",
      409,
    );
  }

  // Only EDITED carries reviewer text; other decisions clear it.
  const editedText = input.reviewStatus === "EDITED" ? (input.editedText ?? null) : null;

  // Repeating the current decision is a no-op: nothing changes, nothing is
  // logged, so double-clicks can't flood the decision history.
  if (current.reviewStatus === input.reviewStatus && current.editedText === editedText) {
    return { ...current, unchanged: true };
  }

  const finding = await prisma.finding.update({
    where: { id: findingId },
    data: { reviewStatus: input.reviewStatus, editedText },
  });
  // The log carries the reviewer's text so it survives in the history.
  await logDecision(finding.caseId, actor, "finding.reviewed", {
    findingId,
    from: current.reviewStatus,
    to: input.reviewStatus,
    ...(editedText !== null ? { editedText } : {}),
  });
  return { ...finding, unchanged: false };
}

/**
 * Current credit position for a case, computed deterministically from the
 * CURRENT evidence (never from a possibly-stale stored recalculation).
 */
export async function getCreditStatus(
  caseId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<CreditCap & { approvedCents: number; historyCreditCents: number }> {
  const evidence = await loadEvidence(caseId, db);
  if (!evidence) throw new AppError("Case not found", 404);
  const { deltaCents } = recalculate(evidence);
  const [history, approved] = await Promise.all([
    db.paymentAdj.aggregate({ where: { caseId, kind: "CREDIT" }, _sum: { amountCents: true } }),
    db.adjustment.aggregate({ where: { caseId }, _sum: { amountCents: true } }),
  ]);
  const historyCreditCents = history._sum.amountCents ?? 0;
  const approvedCents = approved._sum.amountCents ?? 0;
  return {
    ...creditCap({ deltaCents, historyCreditCents, approvedCents }),
    approvedCents,
    historyCreditCents,
  };
}

/**
 * Approve a mock credit/adjustment. Two layers prevent duplicate credits:
 *  1. idempotency — a repeated key (retry / double click) returns the existing
 *     adjustment instead of creating another;
 *  2. a hard cap — total credits can never exceed the overcharge the engine
 *     computes from the current evidence, so re-running the agent (which
 *     produces new resolution options) cannot credit the same dispute twice.
 * Approvals for a case are serialized with a row lock so two concurrent
 * requests can't both pass the cap check.
 */
export async function approveAdjustment(
  caseId: string,
  input: ApproveAdjustmentInput,
): Promise<{ adjustment: Adjustment; duplicate: boolean }> {
  // A replayed key must be the SAME request: same case, same amount. Anything
  // else is a client bug and must not silently "succeed" with another credit.
  const replay = (adj: Adjustment) => {
    if (adj.caseId !== caseId || adj.amountCents !== input.amountCents) {
      throw new AppError(
        "This idempotency key was already used for a different credit request.",
        422,
      );
    }
    logger.info("credit.duplicate_ignored", { caseId, adjustmentId: adj.id, amountCents: adj.amountCents });
    return { adjustment: adj, duplicate: true };
  };

  const existing = await prisma.adjustment.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return replay(existing);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status FROM "Case" WHERE id = ${caseId} FOR UPDATE`;
      if (locked.length === 0) throw new AppError("Case not found", 404);
      assertNotResolved(locked[0].status, "approve credits");

      // Re-check under the lock: a concurrent request may have just won.
      const again = await tx.adjustment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (again) return replay(again);

      const cap = await getCreditStatus(caseId, tx);
      if (input.amountCents > cap.remainingCents) {
        throw new AppError(
          `Credit of ${formatCents(input.amountCents)} exceeds the remaining creditable amount ` +
            `of ${formatCents(cap.remainingCents)} (engine-computed overcharge ` +
            `${formatCents(cap.owedCents)}; already credited ` +
            `${formatCents(cap.approvedCents + cap.historyCreditCents)}).`,
          409,
        );
      }

      const adjustment = await tx.adjustment.create({
        data: {
          caseId,
          findingId: input.findingId ?? null,
          amountCents: input.amountCents,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          approvedBy: input.approvedBy,
        },
      });
      await tx.decisionLog.create({
        data: {
          caseId,
          actor: input.approvedBy,
          action: "adjustment.approved",
          payload: JSON.stringify({
            adjustmentId: adjustment.id,
            amountCents: input.amountCents,
            remainingAfterCents: cap.remainingCents - input.amountCents,
          }),
        },
      });
      return { adjustment, duplicate: false };
    });
    if (!result.duplicate) {
      logger.info("credit.approved", {
        caseId,
        adjustmentId: result.adjustment.id,
        amountCents: input.amountCents,
        approvedBy: input.approvedBy,
      });
    }
    return result;
  } catch (err) {
    if (err instanceof AppError && err.status === 409) {
      // Record the blocked attempt — it's part of the decision history.
      logger.warn("credit.blocked", { caseId, amountCents: input.amountCents, reason: err.message });
      await logDecision(caseId, input.approvedBy, "adjustment.blocked", {
        amountCents: input.amountCents,
        reason: err.message,
      });
      throw err;
    }
    if (err instanceof AppError) throw err;
    // Lost a race on the unique key — return the winner.
    const winner = await prisma.adjustment.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (winner) return replay(winner);
    throw err;
  }
}

export interface AddEvidenceResult {
  reopened: boolean;
  added: { rules: string[]; usage: string[]; payments: string[] };
  /** rules whose definition was corrected (same code, new terms) */
  updatedRules: string[];
  /** refs already present with identical content — ignored */
  skipped: string[];
}

/**
 * Add new evidence to a case and reopen it. Earlier findings/options based on
 * the previous evidence become stale (derived from the evidence hash), so the
 * reviewer knows prior conclusions may no longer hold.
 *
 * Refs identify evidence, so re-submitting is safe:
 *  - identical rule / usage / payment already present -> skipped (no-op);
 *  - usage or payment ref reused with different values -> 409 (they are
 *    recorded facts; a correction needs its own ref);
 *  - rule code reused with different terms -> rule updated (a clarified or
 *    corrected contract term is legitimate new evidence).
 * If nothing actually changed, the case is not reopened and nothing is logged.
 */
export async function addEvidence(
  caseId: string,
  input: AddEvidenceInput,
  actor = "reviewer",
): Promise<AddEvidenceResult> {
  const exists = await prisma.case.findUnique({ where: { id: caseId }, select: { id: true } });
  if (!exists) throw new AppError("Case not found", 404);

  const result: AddEvidenceResult = {
    reopened: false,
    added: { rules: [], usage: [], payments: [] },
    updatedRules: [],
    skipped: [],
  };
  const sameTime = (a: Date, b: string) => a.getTime() === new Date(b).getTime();

  await prisma.$transaction(async (tx) => {
    for (const r of input.rules) {
      const params = JSON.stringify(r.params);
      const existing = await tx.pricingRule.findUnique({
        where: { caseId_code: { caseId, code: r.code } },
      });
      if (
        existing &&
        existing.kind === r.kind &&
        existing.description === r.description &&
        existing.params === params
      ) {
        result.skipped.push(r.code);
        continue;
      }
      await tx.pricingRule.upsert({
        where: { caseId_code: { caseId, code: r.code } },
        update: { description: r.description, kind: r.kind, params },
        create: { caseId, code: r.code, description: r.description, kind: r.kind, params },
      });
      (existing ? result.updatedRules : result.added.rules).push(r.code);
    }

    for (const u of input.usage) {
      const existing = await tx.usageEvent.findUnique({
        where: { caseId_ref: { caseId, ref: u.ref } },
      });
      if (existing) {
        if (existing.type === u.type && existing.quantity === u.quantity && sameTime(existing.occurredAt, u.occurredAt)) {
          result.skipped.push(u.ref);
          continue;
        }
        throw new AppError(
          `Usage event ${u.ref} already exists with different values. Recorded usage can't be overwritten; submit the correction under a new ref.`,
          409,
        );
      }
      await tx.usageEvent.create({
        data: {
          caseId,
          ref: u.ref,
          type: u.type,
          quantity: u.quantity,
          occurredAt: new Date(u.occurredAt),
          metadata: JSON.stringify(u.metadata ?? {}),
        },
      });
      result.added.usage.push(u.ref);
    }

    for (const p of input.payments) {
      const existing = await tx.paymentAdj.findUnique({
        where: { caseId_ref: { caseId, ref: p.ref } },
      });
      if (existing) {
        if (
          existing.kind === p.kind &&
          existing.amountCents === p.amountCents &&
          existing.reason === p.reason &&
          sameTime(existing.occurredAt, p.occurredAt)
        ) {
          result.skipped.push(p.ref);
          continue;
        }
        throw new AppError(
          `Payment ${p.ref} already exists with different values. Submit the correction under a new ref.`,
          409,
        );
      }
      await tx.paymentAdj.create({
        data: {
          caseId,
          ref: p.ref,
          kind: p.kind,
          amountCents: p.amountCents,
          reason: p.reason,
          occurredAt: new Date(p.occurredAt),
        },
      });
      result.added.payments.push(p.ref);
    }
  });

  const changed =
    result.added.rules.length +
      result.added.usage.length +
      result.added.payments.length +
      result.updatedRules.length >
    0;
  if (!changed) return result; // pure re-submission: nothing to reopen or log

  // Earlier conclusions now read as stale automatically: their evidenceHash no
  // longer matches the current evidence. Reopen (also reopens resolved cases).
  const newHash = (await currentEvidenceHash(caseId)) ?? "";
  await prisma.case.update({ where: { id: caseId }, data: { status: "REOPENED" } });
  result.reopened = true;

  await logDecision(caseId, actor, "evidence.added", {
    added: result.added,
    updatedRules: result.updatedRules,
    skipped: result.skipped,
    note: input.note,
    newEvidenceHash: newHash,
  });
  return result;
}

/**
 * Resolve (close) a dispute. Only allowed once the current investigation has
 * been fully reviewed: every current finding accepted/edited/rejected and none
 * based on outdated evidence.
 */
export async function resolveCase(caseId: string, actor = "reviewer", note?: string) {
  const c = await requireCase(caseId);
  if (c.status === "RESOLVED") throw new AppError("This case is already resolved.", 409);
  const findings = await prisma.finding.findMany({ where: { caseId, supersededAt: null } });
  if (findings.length === 0) {
    throw new AppError("Run the investigation and review its findings before resolving.", 409);
  }
  const hash = await currentEvidenceHash(caseId);
  if (findings.some((f) => f.evidenceHash !== hash)) {
    throw new AppError("Some findings are based on earlier evidence. Re-run the investigation first.", 409);
  }
  const pending = findings.filter((f) => f.reviewStatus === "PENDING").length;
  if (pending > 0) {
    throw new AppError(`Review all findings before resolving (${pending} pending).`, 409);
  }
  await prisma.case.update({ where: { id: caseId }, data: { status: "RESOLVED" } });
  const credited = await prisma.adjustment.aggregate({ where: { caseId }, _sum: { amountCents: true } });
  await logDecision(caseId, actor, "case.resolved", {
    note,
    creditedCents: credited._sum.amountCents ?? 0,
  });
}

/** Reopen a resolved case (adding evidence also reopens it automatically). */
export async function reopenCase(caseId: string, actor = "reviewer", reason?: string) {
  const c = await requireCase(caseId);
  if (c.status !== "RESOLVED") {
    throw new AppError("Only a resolved case can be reopened.", 409);
  }
  await prisma.case.update({ where: { id: caseId }, data: { status: "REOPENED" } });
  await logDecision(caseId, actor, "case.reopened", { reason });
}

/**
 * Load a case with everything the API / UI needs. Staleness is derived here by
 * comparing each finding's (and the latest recalculation's) evidence hash with
 * the hash of the case's CURRENT evidence.
 */
export async function getCaseFull(caseId: string) {
  const c = await prisma.case.findUnique({
    where: { id: caseId },
    include: {
      ...evidenceInclude,
      recalculations: { orderBy: { createdAt: "desc" } },
      findings: { orderBy: { createdAt: "asc" } },
      resolutionOptions: { orderBy: { createdAt: "asc" } },
      adjustments: { orderBy: { createdAt: "desc" } },
      decisionLogs: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!c) return null;

  const snapshot = snapshotFromCase(c);
  const currentHash = snapshot ? evidenceHash(snapshot) : "";
  const isStale = (hash: string) => hash !== currentHash;

  const { findings, resolutionOptions, ...rest } = c;
  return {
    ...rest,
    currentEvidenceHash: currentHash,
    latestRecalculationStale: c.recalculations[0] ? isStale(c.recalculations[0].evidenceHash) : false,
    findings: findings
      .filter((f) => !f.supersededAt)
      .map((f) => ({ ...f, stale: isStale(f.evidenceHash) })),
    resolutionOptions: resolutionOptions
      .filter((o) => !o.supersededAt)
      .map((o) => ({ ...o, stale: isStale(o.evidenceHash) })),
    /** findings replaced by later investigations, newest first (history) */
    supersededFindings: findings.filter((f) => f.supersededAt).reverse(),
  };
}
