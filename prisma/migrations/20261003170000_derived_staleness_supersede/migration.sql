-- Staleness is now DERIVED on read (finding.evidenceHash vs the hash of the
-- case's current evidence) instead of a stored flag that could drift — e.g. an
-- investigation finishing after new evidence arrived used to save findings as
-- "fresh". The stored column is no longer needed.
--
-- Findings/options are no longer deleted when an investigation re-runs; they
-- are marked superseded so reviewer decisions and edits stay in the history.

-- AlterTable
ALTER TABLE "Finding" DROP COLUMN "stale",
ADD COLUMN     "supersededAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ResolutionOption" DROP COLUMN "stale",
ADD COLUMN     "supersededAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Finding_caseId_supersededAt_idx" ON "Finding"("caseId", "supersededAt");

-- CreateIndex
CREATE INDEX "ResolutionOption_caseId_supersededAt_idx" ON "ResolutionOption"("caseId", "supersededAt");
