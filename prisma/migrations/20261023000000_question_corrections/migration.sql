-- CreateEnum
CREATE TYPE "CorrectionKind" AS ENUM ('EDIT_TEXT', 'MOVE', 'SPLIT', 'RESET');

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "pinnedToQuestionId" TEXT,
ADD COLUMN     "splitOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "textCorrectedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "QuestionCorrection" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "questionId" TEXT,
    "adminId" TEXT,
    "kind" "CorrectionKind" NOT NULL,
    "paperTitle" TEXT NOT NULL,
    "questionNumber" INTEGER NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuestionCorrection_courseId_createdAt_idx" ON "QuestionCorrection"("courseId", "createdAt");

-- CreateIndex
CREATE INDEX "QuestionCorrection_questionId_createdAt_idx" ON "QuestionCorrection"("questionId", "createdAt");

-- CreateIndex
CREATE INDEX "Question_pinnedToQuestionId_idx" ON "Question"("pinnedToQuestionId");

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_pinnedToQuestionId_fkey" FOREIGN KEY ("pinnedToQuestionId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionCorrection" ADD CONSTRAINT "QuestionCorrection_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionCorrection" ADD CONSTRAINT "QuestionCorrection_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionCorrection" ADD CONSTRAINT "QuestionCorrection_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

