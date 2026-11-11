-- Two-reviewer protocol (docs/pipeline.md §2.1, §3).
-- Purely additive: two nullable columns, two indexes, one foreign key.
-- No existing row is rewritten. Reviews written before this migration keep
-- "reviewerExpertId" = NULL, so the unique index (NULLs are distinct in
-- Postgres) and the foreign key both apply cleanly to any existing data.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "goldExpectedAccept" BOOLEAN;

-- AlterTable
ALTER TABLE "TaskReview" ADD COLUMN     "reviewerExpertId" TEXT;

-- CreateIndex
CREATE INDEX "TaskReview_reviewerExpertId_idx" ON "TaskReview"("reviewerExpertId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskReview_taskId_reviewerExpertId_key" ON "TaskReview"("taskId", "reviewerExpertId");

-- AddForeignKey
ALTER TABLE "TaskReview" ADD CONSTRAINT "TaskReview_reviewerExpertId_fkey" FOREIGN KEY ("reviewerExpertId") REFERENCES "Expert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
