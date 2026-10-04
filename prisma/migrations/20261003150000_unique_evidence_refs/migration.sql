-- Evidence refs (line items, usage events, payments) are cited by findings and
-- counted by the engine, so each ref must identify exactly one row.
--
-- Before this migration, submitting the same evidence twice could duplicate a
-- ref. Remove such duplicates first (keeping the earliest-created row per ref),
-- otherwise the unique indexes below could not be created.

DELETE FROM "LineItem" a
  USING "LineItem" b
  WHERE a."invoiceId" = b."invoiceId" AND a."ref" = b."ref" AND a."id" > b."id";

DELETE FROM "UsageEvent" a
  USING "UsageEvent" b
  WHERE a."caseId" = b."caseId" AND a."ref" = b."ref" AND a."id" > b."id";

DELETE FROM "PaymentAdj" a
  USING "PaymentAdj" b
  WHERE a."caseId" = b."caseId" AND a."ref" = b."ref" AND a."id" > b."id";

-- CreateIndex
CREATE UNIQUE INDEX "LineItem_invoiceId_ref_key" ON "LineItem"("invoiceId", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_caseId_ref_key" ON "UsageEvent"("caseId", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAdj_caseId_ref_key" ON "PaymentAdj"("caseId", "ref");
