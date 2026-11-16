-- CreateTable
CREATE TABLE "QuestionWalkthrough" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionWalkthrough_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuestionWalkthrough_questionId_textHash_promptVersion_key" ON "QuestionWalkthrough"("questionId", "textHash", "promptVersion");

-- AddForeignKey
ALTER TABLE "QuestionWalkthrough" ADD CONSTRAINT "QuestionWalkthrough_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
