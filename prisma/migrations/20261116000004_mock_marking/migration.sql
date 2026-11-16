-- US-49: answer keys, and the marking of mock exam answers against them.
-- CreateEnum
CREATE TYPE "MarkOutcome" AS ENUM ('CORRECT', 'PARTIAL', 'INCORRECT', 'UNANSWERED', 'NO_KEY');

-- AlterTable
ALTER TABLE "MockExam" ADD COLUMN     "markedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MockExamQuestion" ADD COLUMN     "feedback" TEXT,
ADD COLUMN     "markedAt" TIMESTAMP(3),
ADD COLUMN     "matchedPoints" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "missedPoints" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "outcome" "MarkOutcome";

-- CreateTable
CREATE TABLE "AnswerKey" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "keyPoints" TEXT[],
    "explanation" TEXT NOT NULL DEFAULT '',
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnswerKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AnswerKey_groupId_key" ON "AnswerKey"("groupId");

-- CreateIndex
CREATE INDEX "AnswerKey_courseId_idx" ON "AnswerKey"("courseId");

-- AddForeignKey
ALTER TABLE "AnswerKey" ADD CONSTRAINT "AnswerKey_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "QuestionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerKey" ADD CONSTRAINT "AnswerKey_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerKey" ADD CONSTRAINT "AnswerKey_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

