import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ambiguity, calcError, missingEvidence } from "../../prisma/scenarios";

/** Create a fresh case via the API (isolates every test) and open it. */
async function openNewCase(page: Page, request: APIRequestContext, scenario: unknown) {
  const res = await request.post("/api/cases", { data: scenario });
  expect(res.status()).toBe(201);
  const { data } = await res.json();
  await page.goto(`/cases/${data.id}`);
  return data.id as string;
}

const statusBadge = (page: Page) => page.getByTestId("case-status");
const findingCards = (page: Page) =>
  page.locator(".panel", { has: page.getByRole("heading", { name: "Agent findings" }) }).locator(".card");
const creditsPanel = (page: Page) =>
  page.locator(".panel", { has: page.getByRole("heading", { name: "Credits", exact: true }) });

async function investigate(page: Page) {
  await page.getByRole("button", { name: "Run AI investigation" }).click();
  await expect(page.getByText(/Investigation complete via mock/)).toBeVisible();
}

test("case list links to the case detail", async ({ page, request }) => {
  const id = await openNewCase(page, request, calcError);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dispute cases" })).toBeVisible();
  await page.locator(`a[href="/cases/${id}"]`).click();
  await expect(page.getByRole("heading", { name: "Acme Robotics" })).toBeVisible();
  await expect(statusBadge(page)).toHaveAttribute("data-status", "OPEN");
});

test("a reviewer can start from a fresh sample case", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("group", { name: "New sample case" }).getByRole("button", { name: "Missing evidence" }).click();
  await expect(page).toHaveURL(/\/cases\/[a-z0-9]+$/);
  await expect(page.getByRole("heading", { name: "Cinder Logistics" })).toBeVisible();
  await expect(statusBadge(page)).toHaveAttribute("data-status", "OPEN");
});

test("calculation error: recalculate, investigate, and credit exactly once", async ({ page, request }) => {
  await openNewCase(page, request, calcError);

  // deterministic engine: original vs recalculated
  await page.getByRole("button", { name: "Recalculate" }).click();
  const li2 = page.locator("tr", { hasText: "Data transfer (GB)" }).last();
  await expect(li2).toContainText("$15.00");
  await expect(li2).toContainText("$12.50");
  await expect(li2).toContainText("-$2.50");

  // AI investigation: cited CALC_ERROR
  await investigate(page);
  await expect(statusBadge(page)).toHaveAttribute("data-status", "IN_REVIEW");
  const card = findingCards(page).first();
  await expect(card).toContainText("Calculation error");
  for (const cite of ["invoice:LI-2", "rule:RULE-DATA", "usage:USG-1", "usage:USG-2"]) {
    await expect(card.locator(`[data-cite="${cite}"]`)).toBeVisible();
  }

  // approve the credit
  const approve = page.getByRole("button", { name: "Approve mock credit of $2.50" });
  await approve.click();
  await expect(page.getByText("Credit approved")).toBeVisible();
  await expect(creditsPanel(page)).toContainText(/Approved\s*\$2\.50/);
  await expect(approve).toBeDisabled();

  // re-running the investigation must not allow a second credit
  await investigate(page);
  const approveAgain = page.getByRole("button", { name: "Approve mock credit of $2.50" });
  await expect(approveAgain).toBeDisabled();
  await expect(page.getByText("Overcharge already fully credited")).toBeVisible();
  await expect(creditsPanel(page)).toContainText(/Approved\s*\$2\.50/);
  await expect(creditsPanel(page)).toContainText(/Remaining\s*\$0\.00/);
});

test("reviewer decisions: buttons collapse after deciding, changes are logged once", async ({ page, request }) => {
  await openNewCase(page, request, calcError);
  await investigate(page);
  const card = findingCards(page).first();

  // decide: actions collapse into the decision + "Change decision"
  await card.getByRole("button", { name: "Accept" }).click();
  await expect(card).toContainText("Accepted");
  await expect(card).toContainText("Accepted by reviewer");
  await expect(card.getByRole("button", { name: "Accept" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Reject" })).toHaveCount(0);

  // change to an edit
  await card.getByRole("button", { name: "Change decision" }).click();
  await expect(card.getByRole("button", { name: "Accept" })).toHaveCount(0); // current decision hidden
  await card.getByRole("button", { name: "Edit" }).click();
  await card.locator("textarea").fill("Confirmed with billing: tier misapplied.");
  await card.getByRole("button", { name: "Save edit" }).click();
  await expect(card).toContainText("Edited");
  await expect(card).toContainText("Reviewer edit: Confirmed with billing: tier misapplied.");

  // change to reject
  await card.getByRole("button", { name: "Change decision" }).click();
  await card.getByRole("button", { name: "Reject" }).click();
  await expect(card).toContainText("Rejected");
  await expect(card).toContainText("Rejected by reviewer");

  // exactly three decisions in the history — no duplicates
  await expect(page.locator('.timeline li[data-action="finding.reviewed"]')).toHaveCount(3);
});

test("an edit with empty text cannot be saved", async ({ page, request }) => {
  await openNewCase(page, request, calcError);
  await investigate(page);
  const card = findingCards(page).first();
  await card.getByRole("button", { name: "Edit" }).click();
  await card.locator("textarea").fill("   ");
  await expect(card.getByRole("button", { name: "Save edit" })).toBeDisabled();
});

test("contract ambiguity: no credit is offered", async ({ page, request }) => {
  await openNewCase(page, request, ambiguity);
  await page.getByRole("button", { name: "Recalculate" }).click();
  await expect(page.locator("tfoot")).toContainText("$0.00");

  await investigate(page);
  await expect(findingCards(page).first()).toContainText("Contract ambiguity");
  await expect(page.getByText("Uphold the invoice as billed")).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve mock credit/ })).toHaveCount(0);
});

test("missing evidence: add evidence reopens the case, marks stale, then refreshes", async ({ page, request }) => {
  await openNewCase(page, request, missingEvidence);
  await investigate(page);
  await expect(findingCards(page).first()).toContainText("Missing evidence");
  await expect(page.getByRole("button", { name: /Approve mock credit/ })).toHaveCount(0);

  // insert the example: the missing RULE-OVERAGE + usage
  await page.getByRole("button", { name: "Add evidence", exact: true }).click();
  await page.getByRole("button", { name: "Insert example" }).click();
  await page.getByRole("button", { name: "Add evidence & reopen" }).click();

  await expect(statusBadge(page)).toHaveAttribute("data-status", "REOPENED");
  await expect(page.getByText(/New evidence was added after some conclusions were drawn/)).toBeVisible();
  await expect(findingCards(page).first()).toContainText("Stale");
  await expect(page.locator('.timeline li[data-action="evidence.added"]')).toBeVisible();

  // re-investigate with the new evidence
  await investigate(page);
  await expect(statusBadge(page)).toHaveAttribute("data-status", "IN_REVIEW");
  await expect(page.getByText(/New evidence was added after some conclusions/)).toHaveCount(0);
  await expect(findingCards(page).first()).toContainText("Calculation error");
  await expect(page.getByRole("button", { name: "Approve mock credit of $20.00" })).toBeEnabled();
});

test("re-submitting the same evidence is ignored and does not reopen the case", async ({ page, request }) => {
  await openNewCase(page, request, missingEvidence);
  await page.getByRole("button", { name: "Add evidence", exact: true }).click();
  await page.getByRole("button", { name: "Insert example" }).click();
  await page.getByRole("button", { name: "Add evidence & reopen" }).click();
  await expect(statusBadge(page)).toHaveAttribute("data-status", "REOPENED");
  await investigate(page);
  await expect(statusBadge(page)).toHaveAttribute("data-status", "IN_REVIEW");

  // submit the same pre-filled evidence again
  await page.getByRole("button", { name: "Add evidence", exact: true }).click();
  await page.getByRole("button", { name: "Insert example" }).click();
  await page.getByRole("button", { name: "Add evidence & reopen" }).click();
  await expect(page.getByText(/Nothing new — already on this case/)).toBeVisible();
  await expect(statusBadge(page)).toHaveAttribute("data-status", "IN_REVIEW");
  await expect(page.locator("tr", { hasText: "USG-API-1" })).toHaveCount(1);
});

test("partial tool failure degrades gracefully and proposes no money", async ({ page, request }) => {
  await openNewCase(page, request, calcError);
  await page.getByRole("button", { name: "Investigate w/ usage tool down" }).click();
  await expect(page.getByText(/Tool failures: usage-events/)).toBeVisible();
  await expect(findingCards(page).first()).toContainText("Missing evidence");
  await expect(findingCards(page).filter({ hasText: "Calculation error" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Approve mock credit/ })).toHaveCount(0);
});

test("warns when new evidence lowers what is owed below approved credits", async ({ page, request }) => {
  await openNewCase(page, request, calcError);
  await investigate(page);
  await page.getByRole("button", { name: "Approve mock credit of $2.50" }).click();
  await expect(page.getByText("Credit approved")).toBeVisible();

  await page.getByRole("button", { name: "Add evidence", exact: true }).click();
  await page
    .locator("textarea.mono")
    .fill(
      JSON.stringify({
        usage: [{ ref: "USG-3", type: "data_gb", quantity: 10, occurredAt: "2026-01-28T00:00:00.000Z" }],
      }),
    );
  await page.getByRole("button", { name: "Add evidence & reopen" }).click();

  await expect(
    page.getByText(/Credits already approved exceed what the engine now says is owed/),
  ).toBeVisible();
  await expect(creditsPanel(page)).toContainText(/Owed \(engine\)\s*\$2\.00/);
});

test("invalid evidence JSON shows an error and changes nothing", async ({ page, request }) => {
  await openNewCase(page, request, calcError);
  await page.getByRole("button", { name: "Add evidence", exact: true }).click();
  await page.locator("textarea.mono").fill("{ this is not json");
  await page.getByRole("button", { name: "Add evidence & reopen" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Evidence must be valid JSON");
  await expect(statusBadge(page)).toHaveAttribute("data-status", "OPEN");
});

test("non-object evidence is rejected client-side with a clear message", async ({ page, request }) => {
  await openNewCase(page, request, calcError);
  await page.getByRole("button", { name: "Add evidence", exact: true }).click();
  await page.locator("textarea.mono").fill("[1, 2, 3]");
  await page.getByRole("button", { name: "Add evidence & reopen" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Evidence must be a JSON object");
  await expect(statusBadge(page)).toHaveAttribute("data-status", "OPEN");
});

test("server-side validation errors are shown to the reviewer", async ({ page, request }) => {
  await openNewCase(page, request, calcError);
  await page.getByRole("button", { name: "Add evidence", exact: true }).click();
  await page
    .locator("textarea.mono")
    .fill(JSON.stringify({ rules: [{ code: "X", description: "bad", kind: "TIERED", params: {} }] }));
  await page.getByRole("button", { name: "Add evidence & reopen" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Validation failed");
  await expect(statusBadge(page)).toHaveAttribute("data-status", "OPEN");
});

test("the evidence form starts empty and rejects an empty submission", async ({ page, request }) => {
  await openNewCase(page, request, calcError);
  await page.getByRole("button", { name: "Add evidence", exact: true }).click();
  await expect(page.locator("textarea.mono")).not.toContainText("RULE-OVERAGE");
  await page.getByRole("button", { name: "Add evidence & reopen" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Add at least one");
  await expect(statusBadge(page)).toHaveAttribute("data-status", "OPEN");
});

test("comparison table warns when its figures are from earlier evidence", async ({ page, request }) => {
  await openNewCase(page, request, calcError);
  await page.getByRole("button", { name: "Recalculate" }).click();
  await expect(page.locator("tfoot")).toContainText("-$2.50");

  await page.getByRole("button", { name: "Add evidence", exact: true }).click();
  await page
    .locator("textarea.mono")
    .fill(JSON.stringify({ usage: [{ ref: "USG-3", type: "data_gb", quantity: 10, occurredAt: "2026-01-28T00:00:00.000Z" }] }));
  await page.getByRole("button", { name: "Add evidence & reopen" }).click();
  await expect(page.getByText(/These figures were computed from earlier evidence/)).toBeVisible();

  await page.getByRole("button", { name: "Recalculate" }).click();
  await expect(page.getByText(/These figures were computed from earlier evidence/)).toHaveCount(0);
  await expect(page.locator("tfoot")).toContainText("-$2.00");
});

test("resolve requires a full review, locks the case, and reopen unlocks it", async ({ page, request }) => {
  await openNewCase(page, request, calcError);
  // no "Reopen" on a case that was never resolved
  await expect(page.getByRole("button", { name: "Reopen case" })).toHaveCount(0);
  const resolve = page.getByRole("button", { name: "Mark resolved" });
  await expect(resolve).toBeDisabled();

  await investigate(page);
  await expect(resolve).toBeDisabled();
  await expect(page.getByText(/To resolve: review all findings \(1 pending\)/)).toBeVisible();

  await findingCards(page).first().getByRole("button", { name: "Accept" }).click();
  await expect(resolve).toBeEnabled();
  await resolve.click();

  await expect(statusBadge(page)).toHaveAttribute("data-status", "RESOLVED");
  await expect(page.getByRole("button", { name: "Run AI investigation" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Mark resolved" })).toHaveCount(0);

  await page.getByRole("button", { name: "Reopen case" }).click();
  await expect(statusBadge(page)).toHaveAttribute("data-status", "REOPENED");
  await expect(page.getByRole("button", { name: "Run AI investigation" })).toBeEnabled();
});

test("re-investigating keeps earlier findings and reviewer edits in the history", async ({ page, request }) => {
  await openNewCase(page, request, calcError);
  await investigate(page);
  const card = findingCards(page).first();
  await card.getByRole("button", { name: "Edit" }).click();
  await card.locator("textarea").fill("Confirmed with billing.");
  await card.getByRole("button", { name: "Save edit" }).click();
  await expect(card).toContainText("Edited");

  await investigate(page);
  await page.getByRole("button", { name: /Show earlier findings \(1\)/ }).click();
  await expect(page.getByText("Superseded", { exact: true })).toBeVisible();
  await expect(page.getByText("Reviewer edit: Confirmed with billing.")).toBeVisible();
});

test("unknown case returns a 404 page", async ({ page }) => {
  const res = await page.goto("/cases/does-not-exist");
  expect(res?.status()).toBe(404);
});
