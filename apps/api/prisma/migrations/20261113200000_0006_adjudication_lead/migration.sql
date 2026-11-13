-- Adjudication escape for small teams (docs/pipeline.md §2.1, review plan item 7).
-- Purely additive: one boolean column with a default. Every existing user stays a non-lead.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isLead" BOOLEAN NOT NULL DEFAULT false;
