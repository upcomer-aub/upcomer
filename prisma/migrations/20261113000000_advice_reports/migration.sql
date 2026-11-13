-- CreateEnum
CREATE TYPE "AdviceReportReason" AS ENUM ('OFFENSIVE', 'SPAM', 'PERSONAL_INFO', 'ACADEMIC_DISHONESTY', 'OTHER');

-- CreateEnum
CREATE TYPE "AdviceReportStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "AdviceReport" (
    "id" TEXT NOT NULL,
    "adviceId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "reporterId" TEXT,
    "reason" "AdviceReportReason" NOT NULL,
    "note" TEXT,
    "status" "AdviceReportStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdviceReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdviceReport_status_createdAt_idx" ON "AdviceReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AdviceReport_adviceId_status_idx" ON "AdviceReport"("adviceId", "status");

-- CreateIndex
CREATE INDEX "AdviceReport_reporterId_status_idx" ON "AdviceReport"("reporterId", "status");

-- CreateIndex
CREATE INDEX "AdviceReport_courseId_idx" ON "AdviceReport"("courseId");

-- AddForeignKey
ALTER TABLE "AdviceReport" ADD CONSTRAINT "AdviceReport_adviceId_fkey" FOREIGN KEY ("adviceId") REFERENCES "Advice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceReport" ADD CONSTRAINT "AdviceReport_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceReport" ADD CONSTRAINT "AdviceReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceReport" ADD CONSTRAINT "AdviceReport_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

