import { db } from "@/lib/db";
import { readGeneratedRubric } from "@/lib/generated-rubric-rules";
import { errorCode, logError } from "@/lib/logger";
import { hasCurrentPracticeSource, lockPracticeSources } from "@/lib/practice-source";

const pageSize = 20;
const source = { select: { text: true, excludedFromBank: true, groupId: true, fileId: true, file: { select: { title: true, courseId: true, category: true, status: true, topic: true } } } } as const;

export async function listGeneratedRubrics(courseId: string, requestedPage?: string) {
  const where = { courseId, rubricStatus: { not: null } } as const;
  const pages = Math.max(1, Math.ceil(await db.generatedPracticeQuestion.count({ where }) / pageSize));
  const page = Math.min(pages, Math.max(1, Number.parseInt(requestedPage ?? "1", 10) || 1));
  const items = await db.generatedPracticeQuestion.findMany({
    where, orderBy: [{ rubricStatus: "asc" }, { createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize,
    select: {
      id: true, prompt: true, rubric: true, rubricStatus: true, reviewedBy: { select: { name: true } }, reviewedAt: true,
      topic: true, sourceFingerprint: true, topicKey: true, sourceQuestion: source,
    },
  });
  return {
    page, pages,
    items: items.map(item => ({ ...item, rubric: readGeneratedRubric(item.rubric), currentSource: hasCurrentPracticeSource(item, courseId) })),
  };
}

export const rubricReviewMessages: Record<string, string> = {
  invalid_rubric: "Enter distinct key points and a worked explanation within the displayed limits.",
  source_changed: "The source changed or is no longer published in this course. This rubric cannot be approved.",
  stale_review: "This rubric was already changed. Review the current version and try again.",
  not_found: "This generated rubric is no longer available.",
  unexpected: "The review could not be saved. Try again.",
};

export async function reviewGeneratedRubric(reviewerId: string, input: {
  courseId: string; id: string; intent: string; revision: string; keyPoints: string; explanation: string;
}) {
  const fail = (error: keyof typeof rubricReviewMessages) => ({ ok: false as const, error });
  if (input.intent !== "approve" && input.intent !== "reject") return fail("unexpected");
  const approving = input.intent === "approve";
  const rubric = approving ? readGeneratedRubric({ keyPoints: input.keyPoints.split(/\r?\n/).map(point => point.trim()).filter(Boolean), explanation: input.explanation }) : null;
  if (approving && !rubric) return fail("invalid_rubric");

  try {
    const where = { id: input.id, courseId: input.courseId, rubricStatus: { not: null } } as const;
    const target = await db.generatedPracticeQuestion.findFirst({ where, select: { sourceQuestionId: true } });
    if (!target) return fail("not_found");
    return await db.$transaction(async tx => {
      await lockPracticeSources(tx, input.courseId, [target.sourceQuestionId]);
      const item = await tx.generatedPracticeQuestion.findFirst({
        where, select: { sourceFingerprint: true, topicKey: true, sourceQuestion: source, reviewedAt: true },
      });
      if (!item) return fail("not_found");
      if ((item.reviewedAt?.toISOString() ?? "") !== input.revision) return fail("stale_review");
      if (approving && !hasCurrentPracticeSource(item, input.courseId)) return fail("source_changed");
      await tx.generatedPracticeQuestion.update({
        where: { id: input.id },
        data: {
          rubricStatus: approving ? "APPROVED" : "REJECTED", reviewedById: reviewerId, reviewedAt: new Date(),
          ...(rubric && { rubric }),
        },
      });
      return { ok: true as const };
    }, { maxWait: 10_000, timeout: 15_000 });
  } catch (error) {
    logError("generated_rubric_review_failed", { reviewerId, courseId: input.courseId, errorCode: errorCode(error) });
    return fail("unexpected");
  }
}
