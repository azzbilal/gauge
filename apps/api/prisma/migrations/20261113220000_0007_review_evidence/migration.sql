-- Evidence per criterion on each task review (docs/pipeline.md §2, review plan item 8).
-- Purely additive: one nullable column. Rows written before this keep NULL; the API
-- requires evidence on every new review.

-- AlterTable
ALTER TABLE "TaskReview" ADD COLUMN     "evidence" JSONB;
