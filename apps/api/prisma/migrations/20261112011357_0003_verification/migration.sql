-- CreateEnum
CREATE TYPE "CheckMethod" AS ENUM ('MACHINE', 'VISUAL', 'MANUAL');

-- CreateEnum
CREATE TYPE "VerifySubjectType" AS ENUM ('REFERENCE_SOLUTION', 'EXPERT_SUBMISSION', 'MODEL_ROLLOUT');

-- CreateEnum
CREATE TYPE "DifficultyTier" AS ENUM ('T0', 'T1', 'T2', 'BROKEN');

-- CreateTable
CREATE TABLE "Requirement" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "kind" TEXT,
    "value" TEXT,
    "tolerance" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Requirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RubricItem" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "requirementId" TEXT,
    "text" TEXT NOT NULL,
    "checkMethod" "CheckMethod" NOT NULL DEFAULT 'MANUAL',
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RubricItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LintFinding" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "detail" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LintFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerifierRun" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "subjectType" "VerifySubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "verifierVersion" TEXT NOT NULL,
    "results" JSONB NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerifierRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProbeRun" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "rollouts" INTEGER NOT NULL,
    "solveRate" DOUBLE PRECISION NOT NULL,
    "tier" "DifficultyTier" NOT NULL,
    "verifierVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProbeRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Requirement_taskId_idx" ON "Requirement"("taskId");

-- CreateIndex
CREATE INDEX "RubricItem_taskId_idx" ON "RubricItem"("taskId");

-- CreateIndex
CREATE INDEX "RubricItem_requirementId_idx" ON "RubricItem"("requirementId");

-- CreateIndex
CREATE INDEX "LintFinding_taskId_idx" ON "LintFinding"("taskId");

-- CreateIndex
CREATE INDEX "VerifierRun_taskId_idx" ON "VerifierRun"("taskId");

-- CreateIndex
CREATE INDEX "VerifierRun_subjectType_subjectId_idx" ON "VerifierRun"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "ProbeRun_taskId_idx" ON "ProbeRun"("taskId");

-- AddForeignKey
ALTER TABLE "Requirement" ADD CONSTRAINT "Requirement_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RubricItem" ADD CONSTRAINT "RubricItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RubricItem" ADD CONSTRAINT "RubricItem_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LintFinding" ADD CONSTRAINT "LintFinding_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerifierRun" ADD CONSTRAINT "VerifierRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbeRun" ADD CONSTRAINT "ProbeRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
