-- CreateTable
CREATE TABLE "AdviceVote" (
    "adviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdviceVote_pkey" PRIMARY KEY ("adviceId","userId")
);

-- CreateIndex
CREATE INDEX "AdviceVote_userId_idx" ON "AdviceVote"("userId");

-- AddForeignKey
ALTER TABLE "AdviceVote" ADD CONSTRAINT "AdviceVote_adviceId_fkey" FOREIGN KEY ("adviceId") REFERENCES "Advice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdviceVote" ADD CONSTRAINT "AdviceVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

