-- AlterTable
ALTER TABLE "MockExam" ADD COLUMN     "originalId" TEXT;

-- CreateIndex
CREATE INDEX "MockExam_originalId_idx" ON "MockExam"("originalId");

-- AddForeignKey
ALTER TABLE "MockExam" ADD CONSTRAINT "MockExam_originalId_fkey" FOREIGN KEY ("originalId") REFERENCES "MockExam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

