-- Gold clones (docs/pipeline.md §3, item 6 re-review).
-- Purely additive: three nullable columns, indexes, one self-referencing foreign key.
-- No existing row is rewritten: every existing task keeps the new columns NULL.
-- A reviewed clone is kept, so a reviewer accumulates clones: "goldForExpertId" is a plain
-- index. "goldOpenFor" is set only while the clone is unreviewed and is unique, so a
-- reviewer holds at most one open clone and two concurrent requests cannot write two
-- (NULLs are distinct in Postgres). ("goldSourceId", "goldForExpertId") is unique: a
-- reviewer is never given the same gold twice.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "goldSourceId" TEXT,
ADD COLUMN     "goldForExpertId" TEXT,
ADD COLUMN     "goldOpenFor" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Task_goldOpenFor_key" ON "Task"("goldOpenFor");

-- CreateIndex
CREATE INDEX "Task_goldSourceId_idx" ON "Task"("goldSourceId");

-- CreateIndex
CREATE INDEX "Task_goldForExpertId_idx" ON "Task"("goldForExpertId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_goldSourceId_goldForExpertId_key" ON "Task"("goldSourceId", "goldForExpertId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_goldSourceId_fkey" FOREIGN KEY ("goldSourceId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
