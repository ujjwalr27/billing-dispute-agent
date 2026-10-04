# How AI agents were used to build this

This project was built with **Claude Code** (Anthropic, Claude Opus model) as a
pair-programming agent, driven and reviewed by me. The product itself uses
**Google Gemini** at runtime; that is described in the README and is separate
from the development tooling here.

## Tools

| Tool | Used for |
| --- | --- |
| Claude Code (desktop app) | Planning, writing code, running commands, writing tests and docs |
| Claude Code file / shell tools | Reading and editing files; running `npm`, `prisma`, `docker compose`, `vitest`, `playwright`, `git` |
| Claude Code in-app browser | Checking the UI visually (light/dark, desktop/phone width) against a throwaway seeded database |
| Claude Code `/code-review` (max effort) | A multi-agent review: parallel "finder" sub-agents looked at the code from different angles, then each candidate bug was checked by a separate "verifier" sub-agent before being reported |
| Docker + PostgreSQL | Local database, isolated `*_test` databases for the test suites |
| Gemini API | Runtime LLM; also probed directly to see which models my key could actually use |

## What I decided vs. what was delegated

**I decided:** which problem to build, the stack (Next.js + TypeScript, no
separate Python backend), Gemini as the LLM, Postgres in Docker, "plan first,
then implement", and every UX call raised by the agent (e.g. collapsing the
review buttons after a decision instead of hiding them for good). I tested the
app by hand throughout and reported what I saw with screenshots.

**Delegated to the agent:** the implementation plan, the deterministic billing
engine, the agent orchestrator and prompts, the API and UI, the Docker setup,
all three test suites and CI, the code review and its fixes, the UI redesign,
logging, the deployment setup and these docs. Nothing was merged without
running the tests, and the agent was asked to show a failing case (a test or a
reproduction script) before fixing a reported bug.

## Representative prompts

- "Plan in detail first." then "Continue with implementation and make an
  implementation plan md."
- "Can we use Docker here?" (chose: add a Postgres service)
- "Check which models are available and can receive traffic." (after a Gemini
  404 in the UI)
- "Can you write all the tests instead of doing it in the UI?"
- "Is the LLM working?"
- "Should accept / edit / reject disappear?"
- "Do a thorough review of every code file for bugs."
- "Is this fine? Also fix any issues you encountered." (with screenshots)
- "Improve the UI like Apple UI, prod app."
- "Deploy to Vercel."

## Agent mistakes and rejected suggestions

These are the important ones, all fixed and covered by tests:

1. **Wrong Gemini model names.** The agent first defaulted to a retired model
   and then suggested a model name that does not exist, which failed with a 404
   in my UI. Fix: it listed the models available to my key with a small probe
   script, picked a working default and added a fallback model.
2. **No handling for Gemini overload.** Live calls hit `503 high demand`. Fix:
   retries with backoff, a fallback model, then (after the review) a per-call
   timeout and a total time budget before degrading to the mock agent.
3. **Duplicate credit.** I approved a $2.50 credit, re-ran the investigation and
   could approve it again ($5.00 total). The idempotency key was tied to the
   option id, which changes on every run. Fix: total credits are capped by the
   engine's computed overcharge under a per-case row lock, and keys are scoped
   to case and amount. A test fires 5 concurrent approvals and expects exactly
   one credit.
4. **Money invented from partial evidence.** When the usage tool "failed", the
   engine recalculated with zero usage and the agent offered a bogus $15
   credit. Found by the integration tests. Fix: no recalculation from incomplete
   inputs, and proposed credits are clamped to what the engine says is owed.
5. **The LLM proposing $0.00 credits.** Gemini sometimes returned a zero
   credit, which rendered as an "Approve $0.00" button. Fix: a credit sanitizer
   between the model and the database.
6. **Engine bugs found by the code review.** Two invoice lines sharing one rule
   were each charged the rule's full amount; usage past the last price tier was
   priced at $0; a negative "credit" in payment history raised the credit cap.
   Each was reproduced with a script before the fix and re-run after.
7. **Restart wiped data.** The container re-seeded (and deleted everything) on
   every start. Fix: seed only into an empty database.
8. **Unsafe database command.** The agent tried `prisma migrate reset` on the
   test database; Prisma's guard against AI agents blocked it. The agent did
   not bypass the guard and switched to the non-destructive `migrate deploy`.
9. **UI regression from a loading skeleton.** Adding a loading screen made
   unknown cases return HTTP 200 instead of 404 (Next.js starts streaming
   before the page decides). The browser test caught it; the skeleton was
   removed.
10. **Test harness ordering.** Playwright started the dev server before the test
    database was migrated, and a selector matched Next.js's hidden route
    announcer. Both were fixed in the test setup, not by loosening assertions.
11. **Didn't plan for a remote database.** The first Vercel deploy failed every
    AI investigation with a 500: the app ran in the US while the database was in
    Singapore, and saving results took longer than Prisma's default 5-second
    transaction limit. Found by exercising the live API after deploying. Fix:
    raised the transaction limits, batched the inserts, and pinned the functions
    to the database's region (case loads went from ~3 s to ~0.3 s).

**Suggestions I rejected or changed:** a separate Python backend (not needed);
letting the LLM compute or adjust amounts (rejected by design, since all money
comes from the engine); hiding the review buttons permanently after a decision
(changed to collapsing them behind "Change decision").

## How the output was verified

- **Automated tests (143):** 54 unit tests (money math, rule kinds, hashing,
  credit cap, sanitizer, citation guard, Gemini retry and fallback, logger),
  71 API tests against real route handlers and a real PostgreSQL test database,
  and 18 Playwright tests that drive the real UI. Test databases must have
  "test" in their name or the suites refuse to run.
- **Reproduce, then fix:** each reported or review-found bug got a failing test
  or reproduction script first, re-run after the fix.
- **Independent review:** the multi-agent code review reported 15 verified
  findings, and all were fixed and re-checked.
- **Live LLM checks:** all three demo scenarios were run against Gemini to
  confirm classification, citations and the fallback path, separately from the
  mock-based test suites.
- **Manual UI checks:** every flow clicked through in the browser, including
  dark mode and phone width (no horizontal scroll).
- **Build and CI:** typecheck and production build on every change; the GitHub
  Actions workflow runs all three test layers.
