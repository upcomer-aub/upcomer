import { Prisma } from "@prisma/client";
import { PUBLISHED_FILES } from "@/lib/file-visibility";
import { topicKey } from "@/lib/learning-profile";
import { sourceFingerprint } from "@/lib/practice-generation-rules";
import { isUsableQuestion } from "@/lib/question-content";

export const publishedPracticeSources = (courseId: string, grouped = true): Prisma.QuestionWhereInput => ({
  excludedFromBank: false, ...(grouped && { groupId: { not: null } }), file: { courseId, category: "EXAM", ...PUBLISHED_FILES },
});

type Provenance = {
  sourceFingerprint: string;
  topicKey: string;
  sourceQuestion: { text: string; excludedFromBank?: boolean; groupId?: string | null; file: { courseId: string; category: string; status: string; topic: string | null } };
};

export const hasCurrentPracticeSource = (item: Provenance, courseId: string) =>
  isUsableQuestion(item.sourceQuestion) && item.sourceQuestion.groupId !== null && item.sourceQuestion.file.courseId === courseId
  && item.sourceQuestion.file.category === "EXAM" && item.sourceQuestion.file.status === "PUBLISHED"
  && item.sourceFingerprint === sourceFingerprint(item.sourceQuestion.text) && item.topicKey === topicKey(item.sourceQuestion.file.topic);

// Use the same course lock as bank rebuilds and corrections. Row locks also protect the recheck from concurrent
// updates to the source question or its publication and topic metadata until this transaction commits.
export async function lockPracticeSources(tx: Prisma.TransactionClient, courseId: string, sourceIds: string[]) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${courseId}))`;
  await tx.$queryRaw`
    SELECT q."id" FROM "Question" q JOIN "CourseFile" f ON f."id" = q."fileId"
    WHERE q."id" IN (${Prisma.join(sourceIds)}) AND f."courseId" = ${courseId}
    ORDER BY q."id" FOR SHARE OF q, f`;
}
