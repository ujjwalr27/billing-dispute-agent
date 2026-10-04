# Implementation Plan — Billing Dispute Investigation Agent

> Internal build plan. Describes **what** is being built and **how**. Does not reproduce
> the original assignment text. The public README will describe the app and how to run it.

## 1. Guiding principle

Two strictly separated worlds:

- **Deterministic world** — every monetary calculation lives in pure, unit-tested
  TypeScript. Reproducible, auditable, no AI involvement.
- **Interpretation world** — the LLM agent reasons about evidence, classifies the
  dispute, and cites sources, but **never performs arithmetic**. It may only read numbers
  the engine produced.

The two are persisted in **separate tables** so a reviewer can always compare
"the engine says X" against "the AI's interpretation of X."

## 2. Stack

| Concern        | Choice                                                        |
| -------------- | ------------------------------------------------------------- |
| App framework  | Next.js (App Router) + TypeScript — one repo, API + UI        |
| Database       | SQLite + Prisma (zero-config, real schema & migrations)       |
| Money math     | integer cents + `decimal.js` for rule evaluation (no floats)  |
| LLM            | Gemini (`@google/generative-ai`) behind a provider interface  |
| LLM fallback   | deterministic `MockProvider` — app runs & tests pass w/o key  |
| Validation     | Zod on all evidence inputs and agent output                   |
| Testing        | Vitest (engine unit tests + API integration tests)            |
| Deploy         | Vercel (SQLite for local/demo; Postgres swap documented)      |

## 3. Data model (Prisma)

- `Case` — status (OPEN / IN_REVIEW / RESOLVED / REOPENED), customer, dispute text.
- `Invoice`, `LineItem` — the invoice under dispute.
- `PricingRule` — FLAT / PER_UNIT / TIERED / PRORATED, params as JSON.
- `UsageEvent` — metered usage feeding the recalculation.
- `PaymentAdj` — prior payments / credits / adjustments.
- `Recalculation` — **engine output**: original vs recalculated totals, per-line diffs,
  `evidenceHash`.
- `Finding` — **AI interpretation**: type (CALC_ERROR / CONTRACT_AMBIGUITY /
  MISSING_EVIDENCE), summary, citations, reviewStatus, `evidenceHash`, `stale` flag.
- `ResolutionOption` — proposed outcomes + optional mock credit amount.
- `Adjustment` — approved mock credit with a **UNIQUE `idempotencyKey`** (dedup guard).
- `DecisionLog` — append-only history of every action.

### Requirement → design mapping

| Requirement                              | Where it lives                                        |
| ---------------------------------------- | ----------------------------------------------------- |
| Calculations separate from AI            | `Recalculation` vs `Finding` tables                   |
| Prevent duplicate credits                | `Adjustment.idempotencyKey` UNIQUE + no-op on repeat  |
| Staleness of earlier conclusions         | `evidenceHash` compare; mismatch → `stale = true`     |
| Case reopening on new evidence           | `/evidence` route → rehash → mark stale → REOPENED    |
| Preserve dispute & decision history      | append-only `DecisionLog`                             |
| Handle partial tool failure              | agent degrades to MISSING_EVIDENCE, never crashes     |

## 4. Deterministic engine (`lib/engine/`)

- `recalculate(evidence) -> Recalculation` — apply rules to usage, build expected lines,
  diff against actual invoice, return per-line deltas + totals. Pure function.
- `evidenceHash(evidence)` — stable canonical-JSON hash of all evidence inputs.
- `applyAdjustment(caseId, amount, key)` — idempotent; repeat key returns existing record.
- Rule kinds cover a believable dispute (e.g. a tier boundary or proration error).
- Exhaustively unit-tested — the correctness foundation.

## 5. Agent layer (`lib/agent/`)

- `AgentProvider` interface → `GeminiProvider`, `MockProvider`.
- Tool-use loop with **read-only** tools: `getInvoice`, `getUsage`, `getRules`,
  `getPayments`, `recalculate`. The agent cannot write money.
- System prompt enforces: cite every claim by id; classify each issue; emit
  MISSING_EVIDENCE rather than guess when evidence is insufficient.
- Output validated with Zod into `Finding[]` + `ResolutionOption[]`; citations must
  reference real ids (hallucinated ids rejected).
- Partial tool failure: a failing tool yields a MISSING_EVIDENCE finding; the
  investigation continues with available evidence. Fault-injection flag for demo.

## 6. API routes (`app/api/`)

| Route                               | Purpose                                        |
| ----------------------------------- | ---------------------------------------------- |
| `POST /api/cases`                   | create case from evidence (Zod-validated)      |
| `GET  /api/cases/:id`               | full case: evidence, recalc, findings, history |
| `POST /api/cases/:id/recalculate`   | run deterministic engine                       |
| `POST /api/cases/:id/investigate`   | run agent → findings + resolution options      |
| `PATCH /api/findings/:id`           | accept / edit / reject                         |
| `POST /api/cases/:id/adjustments`   | approve mock credit (idempotency-keyed)        |
| `POST /api/cases/:id/evidence`      | add evidence → rehash → mark stale → REOPENED  |
| `POST /api/cases/:id/reopen`        | reopen a case                                  |

Every mutating route writes a `DecisionLog` entry.

## 7. Reviewer UI (`app/cases/...`)

- Case list → case detail.
- Detail: dispute + evidence panels; **original vs recalculated invoice side-by-side**
  with deltas highlighted; findings with Accept / Edit / Reject and clickable citations;
  stale badges; resolution options with "Approve mock credit" (disabled once applied);
  decision-history timeline; "Add evidence" + "Reopen" actions.

## 8. Testing

- Engine: each rule kind, the diff, hash stability, idempotent adjustments (apply-twice → one credit).
- API: happy path, reopen/staleness path, duplicate-credit rejection.
- Agent: run against `MockProvider` for deterministic CI; citation validation tested with a bad id.

## 9. Seed scenarios

1. **True calc error** — tier boundary applied wrong → clear delta → CALC_ERROR → mock credit.
2. **Contract ambiguity** — usage readable two ways → CONTRACT_AMBIGUITY → options, no obvious credit.
3. **Missing evidence** — dispute references unsupplied usage → MISSING_EVIDENCE → add evidence → prior findings stale → reopen.

## 10. Docs & deploy

- `README.md`: overview, architecture, the deterministic-vs-AI split, run steps,
  env vars (`GEMINI_API_KEY` optional → mock fallback), tests, the 3 demo scenarios.
- `.env.example`; Vercel + Postgres-swap notes. No assignment text copied in.

## 11. Build order

1. Git init + Next.js/TS/Prisma/Vitest skeleton.
2. Schema + migration + seed scenario #1.
3. Deterministic engine + full unit tests.
4. API routes + integration tests.
5. Agent layer (MockProvider first, then GeminiProvider).
6. Reviewer UI.
7. Staleness / reopen / dedup polish + fault-injection demo.
8. Seeds #2 and #3, README, deploy.
