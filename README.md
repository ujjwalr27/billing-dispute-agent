# Billing Dispute Investigator

An application that investigates a disputed invoice from supplied billing
evidence. A **deterministic engine** recomputes the invoice and produces an
auditable original-vs-recalculated diff; an **AI agent** then explains the
dispute, classifies it, and cites the exact evidence behind every conclusion. A
human reviewer accepts, edits, or rejects findings and approves mock credits.

The guiding constraint: **all monetary math is deterministic code. The AI never
does arithmetic** — it only interprets numbers the engine produced, and its
interpretation is stored separately from those numbers.

**Live demo:** https://billing-dispute-agent.vercel.app · no login required. Use **New sample
case** on the home page to get your own fresh copy of a demo dispute.

---

## Highlights

- **Deterministic billing engine** — FLAT / PER_UNIT / TIERED / PRORATED rules,
  integer-cents arithmetic (no floating point), recomputation + per-line diff.
  Fully unit-tested.
- **Evidence-grounded agent** — classifies each issue as `CALC_ERROR`,
  `CONTRACT_AMBIGUITY`, or `MISSING_EVIDENCE`; cites line items / rules / usage /
  payments by stable ref; asks for missing evidence instead of guessing.
- **Hallucination guard** — any citation to a ref that doesn't exist is dropped
  before persistence.
- **Pluggable LLM** — Google **Gemini** in production; a deterministic **mock
  provider** runs the whole flow (and CI) with no API key.
- **Partial-failure tolerance** — if an evidence source is unavailable the
  investigation degrades to a `MISSING_EVIDENCE` finding rather than crashing
  (demonstrable via a fault-injection toggle).
- **Reviewer workflow + state integrity** — accept/edit/reject, mock credits
  capped at the engine-computed overcharge (no duplicate credits, even under
  concurrent requests), **staleness** detection when new evidence arrives, a
  resolve → reopen lifecycle, and a complete **decision history** (superseded
  findings and reviewer edits are kept, never deleted).

## Architecture

```
┌──────────────┐     evidence      ┌───────────────────────┐
│  Reviewer UI │ ────────────────► │  API routes (Next.js) │
│  (React)     │ ◄──────────────── │                       │
└──────────────┘   case + results  └───────────┬───────────┘
                                                │
                     ┌──────────────────────────┼──────────────────────────┐
                     ▼                           ▼                          ▼
            ┌─────────────────┐        ┌───────────────────┐      ┌──────────────────┐
            │ Deterministic   │        │  Agent orchestrator│      │ Prisma/PostgreSQL│
            │ engine          │        │  + provider        │      │                  │
            │ (money math)    │ ─────► │  (Gemini | mock)   │ ───► │  Recalculation   │  ← engine output
            │ recalc + diff   │  reads │  interpret + cite  │      │  Finding         │  ← AI interpretation
            └─────────────────┘  only  └───────────────────┘      │  Adjustment …    │
                                                                   └──────────────────┘
```

The engine's output (`Recalculation`) and the AI's interpretation (`Finding`,
`ResolutionOption`) live in **separate tables**, so a reviewer can always
compare "what the math says" against "what the AI thinks it means."

| Requirement                         | Where it lives                                               |
| ----------------------------------- | ------------------------------------------------------------ |
| Deterministic monetary calculations | `lib/money.ts`, `lib/engine/*` (integer cents + decimal.js)  |
| Calculations recorded separately    | `Recalculation` table vs `Finding`/`ResolutionOption` tables |
| Cite evidence behind each claim     | `citations` on findings/options, validated against real refs |
| Ask for missing evidence            | `MISSING_EVIDENCE` findings                                  |
| Prevent duplicate credits           | credit cap from the engine + per-case row lock + idempotency keys scoped to case & amount |
| Handle partial tool failure         | `lib/agent/index.ts` degrades + records `toolFailures`       |
| Case reopening on new evidence      | `POST /api/cases/:id/evidence` (also reopens resolved cases) |
| Stale earlier conclusions           | derived on read: each finding's `evidenceHash` vs the hash of the current evidence (incl. payments) |
| Preserve dispute & decision history | append-only `DecisionLog` + superseded (not deleted) findings |
| Structured app + AI-workflow logs   | `lib/log.ts`: JSON lines for every API request, LLM attempt, fallback and credit decision |

## Tech stack

Next.js (App Router) · TypeScript · Prisma + PostgreSQL · Zod · decimal.js ·
Google Gemini (`@google/generative-ai`) · Vitest · Docker.

## Quick start with Docker (recommended)

Brings up the app **and** PostgreSQL, runs migrations, and seeds the 3 demo
cases — one command, no local Node or database setup:

```bash
docker compose up --build
# open http://localhost:3000
```

Set a live model if you want: `GEMINI_API_KEY=... docker compose up --build`
(otherwise the deterministic mock agent runs). The 3 demo cases are loaded only
into an empty database, so restarts never wipe your cases or decision history;
use `SEED=reset docker compose up` to start over from the demo data.

## Local development (without Docker for the app)

Run just PostgreSQL in Docker, then the app on your host:

```bash
npm install
cp .env.example .env          # already points at localhost:5433
docker compose up -d db       # start only PostgreSQL
npx prisma migrate deploy     # apply migrations
npm run seed                  # load 3 demo cases
npm run dev                   # http://localhost:3000
```

(If you prefer your own PostgreSQL, just set `DATABASE_URL` and skip the `db`
container.)

### Environment variables

| Variable          | Default                                              | Notes                                                        |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`    | `postgresql://billing:billing@localhost:5433/billing`| PostgreSQL connection string (Compose sets `db:5432` for the app container). |
| `GEMINI_API_KEY`  | _(empty)_                                            | Optional. If unset, the deterministic **mock agent** is used.|
| `AGENT_PROVIDER`  | `auto`                                               | `auto` \| `gemini` \| `mock`.                                |
| `GEMINI_MODEL`    | `gemini-3.6-flash`                                   | Used only when the Gemini provider is active.                |
| `GEMINI_FALLBACK_MODELS` | `gemini-3.1-flash-lite`                       | Tried (after retries with backoff) if the primary is overloaded; then the mock. |
| `SEED`            | `if-empty`                                           | Docker/Vercel: `if-empty` loads demos into an empty DB (never wipes data), `reset` reloads them (Docker only), `false` skips. |
| `LOG_LEVEL`       | `info`                                               | `debug` \| `info` \| `warn` \| `error` \| `silent` (tests use `silent`). |
| `DATABASE_URL_UNPOOLED` | _(set by Neon on Vercel)_                      | Direct connection used only for migrations during the Vercel build. |

> The app is fully functional **without a key**. Set `GEMINI_API_KEY` to use the
> live model; everything else — engine, workflow, state integrity — is identical.

## Tests

Three layers, 143 tests in total. The integration and browser suites need PostgreSQL
(`docker compose up -d db`); they use their own `billing_test` /
`billing_e2e_test` databases and **refuse to run against any database whose
name doesn't contain "test"**, so your dev data is never touched.

```bash
npm test                  # unit (54): engine math, rule kinds, hashing, credit cap, credit
                          #   sanitizer, mock agent, citation guard, Gemini retry/fallback, logger
npm run test:integration  # API (71): real route handlers + real PostgreSQL
npm run test:e2e          # browser (18): Playwright drives the real UI
npm run test:all          # all of the above
npm run typecheck
```

First-time browser setup: `npx playwright install chromium`.

| Layer | What it proves |
| --- | --- |
| **Unit** | Money math is exact (integer cents, tiered/prorated rules), evidence hashing is stable, the credit cap is correct, the agent never cites unknown evidence, Gemini retries 503s and falls back to a second model. |
| **Integration** | Every API route: validation (400 with field details), 404s, recalculation per scenario, CALC_ERROR / CONTRACT_AMBIGUITY / MISSING_EVIDENCE classification, engine numbers stored apart from AI findings, partial tool failure, reviewer actions, idempotent credits, the duplicate-credit regression, **5 concurrent approvals → exactly one credit**, reopen + staleness, over-credit detection. |
| **End-to-end** | The reviewer's real flows in Chromium: credit exactly once (button disables, re-investigation can't re-credit), accept/edit/reject, no credit offered for ambiguity, add evidence → REOPENED + stale banner → refresh, tool-failure degradation, over-credit warning, error messages for bad evidence, 404 page. |

All suites use the deterministic mock agent, so they're reproducible and need
no API key. CI (`.github/workflows/ci.yml`) runs all three on every push.

## Demo scenarios (seeded)

1. **Calculation error — Acme Robotics.** A tiered data charge was billed as if
   all usage fell in the first tier. The engine finds a **$2.50 overcharge**; the
   agent raises a cited `CALC_ERROR`; approve the mock credit to resolve.
2. **Contract ambiguity — Borealis Media.** The invoice is internally consistent
   with the rules, but the customer disputes full-month billing on a mid-month
   cancellation. The agent returns `CONTRACT_AMBIGUITY` with options, not a credit.
3. **Missing evidence — Cinder Logistics.** An "API overage" line references a
   pricing rule that wasn't supplied. The agent returns `MISSING_EVIDENCE`. Open
   **Add evidence**, click **Insert example** to supply the rule and usage → the
   case reopens, earlier conclusions are flagged **stale** → re-investigate.

To close a dispute, review every finding, then **Mark resolved**. A resolved
case is locked until it is reopened (explicitly, or by adding new evidence).

To see **partial tool failure**, use *"Investigate w/ usage tool down"* on any
case: the usage source is simulated as unavailable and the agent degrades to a
`MISSING_EVIDENCE` finding while still reporting what it can.

## API

| Method & path                       | Purpose                                     |
| ----------------------------------- | ------------------------------------------- |
| `GET  /api/cases`                   | list cases                                  |
| `POST /api/cases`                   | create a case from evidence                 |
| `GET  /api/cases/:id`               | full case (evidence, recalc, findings, log) |
| `POST /api/cases/:id/recalculate`   | run the deterministic engine                |
| `POST /api/cases/:id/investigate`   | run the agent (`{ "faultInject": "usage" }` optional) |
| `POST /api/cases/:id/evidence`      | add evidence → reopen + mark stale          |
| `POST /api/cases/:id/resolve`       | resolve (requires all findings reviewed)    |
| `POST /api/cases/:id/reopen`        | reopen a resolved case                      |
| `POST /api/cases/:id/adjustments`   | approve a mock credit (idempotency-keyed)   |
| `POST /api/samples`                 | fresh copy of a demo case (`{ "scenario": "calcError" \| "ambiguity" \| "missingEvidence" }`) |
| `PATCH /api/findings/:id`           | accept / edit / reject a finding            |

## Logs

Two separate trails:

- **Decision history** (`DecisionLog` table, shown as *Activity* on each case):
  the business audit trail of case opened, recalculations, investigations,
  reviewer decisions (with edited text), credits approved/blocked, evidence
  added, resolve/reopen. Append-only.
- **Structured application logs** (`lib/log.ts`): one JSON object per line on
  stdout/stderr, visible in `docker compose logs app` or Vercel's *Logs* tab.
  Secret-looking fields (`*key*`, `*token*`, `authorization`, ...) are redacted.

| Event | Fields |
| --- | --- |
| `api.request` | `requestId`, `method`, `path`, `status`, `durationMs` (level by status) |
| `api.rejected` / `api.error` | business-rule rejections (409/422...) / unexpected 500s with a trimmed stack |
| `agent.investigation.started` / `.finished` | `caseId`, provider, tool failures, finding types, dropped citations, credit adjustments, `durationMs` |
| `agent.llm.call` | `model`, `attempt`, `ok`, HTTP `status`, `retryable`, `durationMs`, one line per Gemini attempt |
| `agent.provider.fallback_to_mock` | why the live model was abandoned |
| `credit.approved` / `credit.blocked` / `credit.duplicate_ignored` | `caseId`, `amountCents`, reason |

## Deployment

### Vercel (hosted demo)

1. Create a Vercel project from this repo (or run `npx vercel` in the folder).
2. **Storage → Create Database → Neon (Postgres)** and connect it to the
   project. This sets `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED`.
3. Add `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`)
   under **Settings → Environment Variables**.
4. Deploy. The `vercel-build` script (`scripts/vercel-build.mjs`) runs
   `prisma generate`, `prisma migrate deploy` over the direct connection, seeds
   the three demo cases **only if the database is empty**, then `next build`.

Functions are pinned to the database's region in `vercel.json` (`sin1`, Singapore); change it if your database lives elsewhere, since every query crosses that link. The investigation route allows up to 90 s (`maxDuration`); the Gemini provider
bounds itself to ~75 s across retries and its fallback model before degrading
to the mock agent. `.vercelignore` keeps local-only files out of the upload.

### Docker / any container host

`docker compose up --build`, or build the image (`docker build -t
billing-dispute .`) and run it against a managed PostgreSQL by setting
`DATABASE_URL`. The entrypoint runs `prisma migrate deploy` on start.

## Project layout

```
app/                 Next.js routes — UI pages + /api route handlers
lib/
  engine/            deterministic recalculation, rule evaluation, evidence hashing
  agent/             provider interface, Gemini + mock providers, orchestrator
  money.ts           integer-cents money handling (decimal.js)
  cases.ts           service layer (create, investigate, review, credits, reopen)
  validation.ts      Zod schemas for all inputs and agent output
  log.ts             structured JSON logger
prisma/              schema, migrations, seed, demo scenarios
scripts/             vercel-build (generate, migrate, seed-if-empty, build)
tests/               integration (API) and e2e (Playwright) suites
```

## Scope

### Completed

- Case intake from structured evidence (invoice lines, pricing rules, usage,
  payments/adjustments, dispute text) with strict validation.
- Deterministic recalculation for FLAT, PER_UNIT, TIERED and PRORATED rules with
  a per-line diff; lines that cannot be verified are flagged, never guessed.
- AI investigation (Gemini with retries, a fallback model and a mock fallback)
  that classifies findings, cites evidence and asks for what is missing.
  Citations and proposed credits are checked against the evidence and the
  engine before they are stored.
- Reviewer workflow: accept / edit / reject, change a decision, approve mock
  credits (capped, idempotent, race-safe), add evidence (reopens and marks
  stale), resolve once everything is reviewed, reopen.
- Complete history (superseded findings and edits kept), structured logs, and
  loading / empty / validation / success / failure states in the UI.
- 143 automated tests across unit, API and browser layers, plus a CI workflow.

### Intentionally left out

- Real payment processing, accounting-system integration, tax advice and
  automatic financial adjustments. Credits are **mock** records a reviewer
  approves.
- Authentication and roles: the demo has a single anonymous reviewer.
- File uploads (PDF invoices or contracts): evidence is entered as structured
  JSON.
- Reversing an approved credit. The UI warns when credits exceed what is owed,
  but the reversal is left to a human.

### Limitations

- Anyone with the demo URL can act as the reviewer, and there is no rate
  limiting, so the live LLM key is protected only by Gemini's own quotas.
- Pricing rules cover four kinds. Anything else must be added to the engine (and
  its tests); the agent will not attempt the arithmetic itself.
- One currency per invoice; no FX.
- The LLM's wording varies between runs (temperature 0 reduces but does not
  remove this). Its numbers do not: every amount comes from the engine.
- Preview and production deployments share one database unless you connect a
  separate one.

## Design notes

- The agent is deliberately kept out of all arithmetic. If a future rule kind is
  added, the engine and its tests are the only place money logic changes.
- Staleness is derived on read (finding hash vs current evidence hash), so no
  code path can forget to flag a conclusion as stale.
- Evidence and agent output are validated with Zod at every boundary; the same
  scenarios feed the seed script and all three test layers.
