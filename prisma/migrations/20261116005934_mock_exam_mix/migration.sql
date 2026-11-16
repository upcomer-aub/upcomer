-- CreateEnum
CREATE TYPE "MockExamMix" AS ENUM ('PROFILE', 'NO_PROFILE', 'PROFILE_UNAVAILABLE');

-- AlterTable
ALTER TABLE "MockExam" ADD COLUMN     "mixBasis" "MockExamMix",
ADD COLUMN     "requestedLength" INTEGER,
ADD COLUMN     "weakTopics" TEXT[] DEFAULT ARRAY[]::TEXT[];

