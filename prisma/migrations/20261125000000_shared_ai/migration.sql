CREATE TYPE "GeneratedRubricStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED');

ALTER TABLE "GeneratedPracticeQuestion"
  ADD COLUMN "aiModel" TEXT,
  ADD COLUMN "aiPromptVersion" TEXT,
  ADD COLUMN "rubricStatus" "GeneratedRubricStatus",
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3);

CREATE INDEX "GeneratedPracticeQuestion_courseId_rubricStatus_createdAt_idx"
  ON "GeneratedPracticeQuestion"("courseId", "rubricStatus", "createdAt");

ALTER TABLE "GeneratedPracticeQuestion" ADD CONSTRAINT "GeneratedPracticeQuestion_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MockExamQuestion"
  ADD COLUMN "generatedRubricSnapshot" JSONB,
  ADD COLUMN "markingRubric" JSONB;

CREATE TABLE "MockAiExplanation" (
  "mockExamQuestionId" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "explanation" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MockAiExplanation_pkey" PRIMARY KEY ("mockExamQuestionId", "promptVersion"),
  CONSTRAINT "MockAiExplanation_mockExamQuestionId_fkey" FOREIGN KEY ("mockExamQuestionId")
    REFERENCES "MockExamQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
