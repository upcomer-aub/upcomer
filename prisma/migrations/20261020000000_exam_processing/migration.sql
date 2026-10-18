CREATE TYPE "ProcessingStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "ProcessingStage" AS ENUM ('EXTRACTION', 'GROUPING');

CREATE TABLE "FileProcessingRun" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "status" "ProcessingStatus" NOT NULL DEFAULT 'RUNNING',
    "stage" "ProcessingStage" NOT NULL DEFAULT 'EXTRACTION',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FileProcessingRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FileProcessingRun_fileId_createdAt_idx" ON "FileProcessingRun"("fileId", "createdAt");

ALTER TABLE "FileProcessingRun" ADD CONSTRAINT "FileProcessingRun_fileId_fkey"
FOREIGN KEY ("fileId") REFERENCES "CourseFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
