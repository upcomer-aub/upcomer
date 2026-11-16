-- AlterTable
ALTER TABLE "MockExam" ADD COLUMN     "deadlineAt" TIMESTAMP(3),
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "timeLimitMinutes" INTEGER,
ADD COLUMN     "timedOut" BOOLEAN NOT NULL DEFAULT false;

