-- Auth (review plan item 4): logins with a role, each backed by one Expert.
-- Purely additive: one enum, one table. No existing row is touched.

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('AUTHOR', 'REVIEWER', 'ADJUDICATOR', 'ADMIN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'AUTHOR',
    "expertId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_expertId_key" ON "User"("expertId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

