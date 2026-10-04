import { formatCents } from "@/lib/money";
import type { InvestigationContext } from "./provider";

export const SYSTEM_PROMPT = `You are a billing dispute investigator. You analyse evidence and explain disputes; you NEVER do arithmetic yourself.

Hard rules:
- All monetary figures are provided to you, already computed by a deterministic engine. Do not invent, re-derive, or adjust any number.
- Classify every issue as exactly one of:
  - CALC_ERROR: the engine's recalculation differs from the billed amount.
  - CONTRACT_AMBIGUITY: numbers are internally consistent, but the terms could be read more than one way.
  - MISSING_EVIDENCE: you cannot conclude because required evidence is absent.
- Cite the evidence behind every finding and option using the stable refs given (line items like "LI-1", rules like "RULE-X", usage like "USG-1", payments like "PAY-1"). Only cite refs that appear in the context. Never cite a ref that is not listed.
- If evidence is insufficient, produce a MISSING_EVIDENCE finding instead of guessing. Lines with status=unverifiable could not be priced: treat them as missing evidence, never as calculation errors.
- Tool failure names (e.g. "usage-events") are NOT evidence refs and must never be cited. A MISSING_EVIDENCE finding about a failed source may cite the affected invoice lines, or nothing.
- proposedCreditCents, when present, must equal a figure taken directly from the recalculation; otherwise use null.

Respond with ONLY a JSON object of this exact shape, no prose, no markdown fences:
{
  "findings": [
    { "type": "CALC_ERROR|CONTRACT_AMBIGUITY|MISSING_EVIDENCE", "summary": "string", "citations": [{ "kind": "invoice|rule|usage|payment", "ref": "string", "note": "string (optional)" }] }
  ],
  "resolutionOptions": [
    { "label": "string", "rationale": "string", "proposedCreditCents": number|null, "citations": [ ... ] }
  ]
}`;

export function buildUserPrompt(ctx: InvestigationContext): string {
  const lines: string[] = [];
  lines.push(`## Customer dispute\n${ctx.disputeDescription}\n`);

  if (ctx.toolFailures.length > 0) {
    lines.push(
      `## Tool failures\nThe following evidence sources failed to load: ${ctx.toolFailures.join(
        ", ",
      )}. Treat the affected evidence as missing.\n`,
    );
  }

  if (ctx.evidence) {
    lines.push("## Invoice line items");
    for (const li of ctx.evidence.lineItems) {
      lines.push(
        `- ${li.ref}: "${li.description}" | ruleCode=${li.ruleCode ?? "none"} | billed=${formatCents(
          li.amountCents,
        )}`,
      );
    }
    lines.push("\n## Pricing rules");
    for (const r of ctx.evidence.rules) {
      lines.push(`- ${r.code} (${r.kind}): ${r.description} | params=${JSON.stringify(r.params)}`);
    }
    lines.push("\n## Usage events");
    for (const u of ctx.evidence.usage) {
      lines.push(`- ${u.ref}: type=${u.type} qty=${u.quantity} at=${u.occurredAt}`);
    }
  } else {
    lines.push("## Evidence\n(unavailable)");
  }

  if (ctx.payments.length > 0) {
    lines.push("\n## Payments / prior adjustments");
    for (const p of ctx.payments) {
      lines.push(`- ${p.ref}: ${p.kind} ${formatCents(p.amountCents)} — ${p.reason}`);
    }
  }

  if (ctx.recalc) {
    lines.push("\n## Deterministic recalculation (authoritative — do not recompute)");
    lines.push(
      `Original total: ${formatCents(ctx.recalc.originalTotalCents)} | Recalculated total: ${formatCents(
        ctx.recalc.recalcTotalCents,
      )} | Delta: ${formatCents(ctx.recalc.deltaCents)} (negative = customer overcharged)`,
    );
    for (const d of ctx.recalc.lineDiffs) {
      lines.push(
        `- ${d.ref}: status=${d.status} billed=${formatCents(d.originalCents)} expected=${formatCents(
          d.expectedCents,
        )} delta=${formatCents(d.deltaCents)} | ${d.explanation}`,
      );
    }
  } else {
    lines.push("\n## Recalculation\n(unavailable — the invoice could not be recomputed)");
  }

  lines.push(
    "\nProduce your findings and resolution options now as the specified JSON object.",
  );
  return lines.join("\n");
}
