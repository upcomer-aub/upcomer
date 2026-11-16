-- US-36: when the author last edited their advice.
ALTER TABLE "Advice" ADD COLUMN "editedAt" TIMESTAMP(3);
