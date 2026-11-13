-- M9 Probe Gate wired into the API (POST /tasks/:id/probe).
-- A probe that could not run (verify service or Ollama unreachable) or whose answer was
-- unusable is stored as such, with a note, instead of as a tier: an outage must never read
-- as a difficulty. So tier and solveRate become nullable and a status says which it is.
-- No row was ever written before this (nothing called the probe), so the default is moot.

-- CreateEnum
CREATE TYPE "ProbeStatus" AS ENUM ('OK', 'NOT_RUN', 'FAILED');

-- AlterTable
ALTER TABLE "ProbeRun" ADD COLUMN     "note" TEXT,
ADD COLUMN     "status" "ProbeStatus" NOT NULL DEFAULT 'OK',
ALTER COLUMN "solveRate" DROP NOT NULL,
ALTER COLUMN "tier" DROP NOT NULL;
