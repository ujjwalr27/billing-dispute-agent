import { createHash } from "node:crypto";
import type { EvidenceSnapshot } from "@/lib/types";

/**
 * Produce a stable SHA-256 hash of an evidence snapshot (invoice, rules, usage
 * AND payment history). The hash is the basis for staleness detection: a
 * finding records the hash it was computed from, and when the current evidence
 * hash differs, the finding is stale.
 *
 * Determinism requires canonical serialization: object keys are sorted and
 * arrays are sorted by their stable `ref`/`code` so that reordering evidence
 * without changing its content does not change the hash.
 */
export function evidenceHash(snapshot: EvidenceSnapshot): string {
  const canonical = canonicalize(normalizeSnapshot(snapshot));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Locale-independent ordering. The hash is persisted and compared later, so it
 * must not depend on the runtime's ICU locale (which `localeCompare` does).
 */
function byKey<T>(key: (item: T) => string) {
  return (a: T, b: T) => {
    const x = key(a);
    const y = key(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
}

function normalizeSnapshot(s: EvidenceSnapshot): EvidenceSnapshot {
  return {
    invoiceNumber: s.invoiceNumber,
    currency: s.currency,
    lineItems: [...s.lineItems].sort(byKey((li) => li.ref)),
    rules: [...s.rules].sort(byKey((r) => r.code)),
    usage: [...s.usage].sort(byKey((u) => u.ref)),
    payments: [...(s.payments ?? [])].sort(byKey((p) => p.ref)),
  };
}

/** Deterministic JSON: object keys sorted recursively. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`;
}
