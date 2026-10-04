import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { evidenceHash } from "@/lib/engine/hash";
import type { Citation, EvidenceSnapshot } from "@/lib/types";

/** Evidence relations, in a deterministic order, for building a snapshot. */
export const evidenceInclude = {
  invoice: { include: { lineItems: { orderBy: { ref: "asc" } } } },
  pricingRules: { orderBy: { code: "asc" } },
  usageEvents: { orderBy: { ref: "asc" } },
  payments: { orderBy: { ref: "asc" } },
} satisfies Prisma.CaseInclude;

type CaseWithEvidence = Prisma.CaseGetPayload<{ include: typeof evidenceInclude }>;

/** Assemble the EvidenceSnapshot from already-loaded case rows. */
export function snapshotFromCase(c: CaseWithEvidence): EvidenceSnapshot | null {
  if (!c.invoice) return null;
  return {
    invoiceNumber: c.invoice.number,
    currency: c.invoice.currency,
    lineItems: c.invoice.lineItems.map((li) => ({
      ref: li.ref,
      description: li.description,
      ruleCode: li.ruleCode,
      quantity: li.quantity,
      unitPriceCents: li.unitPriceCents,
      amountCents: li.amountCents,
    })),
    rules: c.pricingRules.map((r) => ({
      code: r.code,
      description: r.description,
      kind: r.kind as EvidenceSnapshot["rules"][number]["kind"],
      params: JSON.parse(r.params),
    })),
    usage: c.usageEvents.map((u) => ({
      ref: u.ref,
      type: u.type,
      quantity: u.quantity,
      occurredAt: u.occurredAt.toISOString(),
    })),
    payments: c.payments.map((p) => ({
      ref: p.ref,
      kind: p.kind as NonNullable<EvidenceSnapshot["payments"]>[number]["kind"],
      amountCents: p.amountCents,
      reason: p.reason,
      occurredAt: p.occurredAt.toISOString(),
    })),
  };
}

/**
 * Load the full evidence for a case from the database and assemble the
 * EvidenceSnapshot the deterministic engine consumes. Returns null if the case
 * or its invoice does not exist.
 */
export async function loadEvidence(
  caseId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<EvidenceSnapshot | null> {
  const c = await db.case.findUnique({ where: { id: caseId }, include: evidenceInclude });
  return c ? snapshotFromCase(c) : null;
}

/** Hash of the case's current evidence, or null if the case doesn't exist. */
export async function currentEvidenceHash(
  caseId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<string | null> {
  const snapshot = await loadEvidence(caseId, db);
  return snapshot ? evidenceHash(snapshot) : null;
}

/**
 * The set of citation refs that actually exist for a case, grouped by kind.
 * Used to reject hallucinated citations from the agent before persisting.
 */
export async function validCitationRefs(
  caseId: string,
): Promise<Record<Citation["kind"], Set<string>>> {
  const [invoice, rules, usage, payments] = await Promise.all([
    prisma.invoice.findUnique({
      where: { caseId },
      include: { lineItems: true },
    }),
    prisma.pricingRule.findMany({ where: { caseId } }),
    prisma.usageEvent.findMany({ where: { caseId } }),
    prisma.paymentAdj.findMany({ where: { caseId } }),
  ]);

  return {
    invoice: new Set((invoice?.lineItems ?? []).map((li) => li.ref)),
    rule: new Set(rules.map((r) => r.code)),
    usage: new Set(usage.map((u) => u.ref)),
    payment: new Set(payments.map((p) => p.ref)),
  };
}

/** Partition citations into those whose refs exist and those that don't. */
export function partitionCitations(
  citations: Citation[],
  valid: Record<Citation["kind"], Set<string>>,
): { kept: Citation[]; dropped: Citation[] } {
  const kept: Citation[] = [];
  const dropped: Citation[] = [];
  for (const c of citations) {
    if (valid[c.kind]?.has(c.ref)) kept.push(c);
    else dropped.push(c);
  }
  return { kept, dropped };
}
