-- CreateTable
CREATE TABLE "AdviceComment" (
    "id" TEXT NOT NULL,
    "adviceId" TEXT NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdviceComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdviceComment_adviceId_createdAt_idx" ON "AdviceComment"("adviceId", "createdAt");

-- CreateIndex
CREATE INDEX "AdviceComment_authorId_idx" ON "AdviceComment"("authorId");

-- AddForeignKey
ALTER TABLE "AdviceComment" ADD CONSTRAINT "AdviceComment_adviceId_fkey" FOREIGN KEY ("adviceId") REFERENCES "Advice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceComment" ADD CONSTRAINT "AdviceComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

