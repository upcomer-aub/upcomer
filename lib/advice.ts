import { AdviceStatus, FileCategory, FileStatus, type Prisma } from "@prisma/client";
import { adviceAbout, clampPage, ADVICE_PAGE_SIZE, authorLabel, safeResourceUrl, type AdviceAbout } from "@/lib/advice-rules";
import { db } from "@/lib/db";
import { logError } from "@/lib/logger";
import { timed } from "@/lib/timing";

// Advice from previous students (E3). This file reads advice for students: the course feed (US-38). Nothing here checks
// the caller: the pages call requireUser() first. The advice text and author names are never logged.

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

// The advice students may see in one course: visible, and not pointing at another course's exam paper or question. A
// target of another course can only come from bad data (publishing, US-34, refuses it); such advice is left out
// entirely rather than shown in the wrong course.
export const visibleCourseAdvice = (courseId: string) => ({
  courseId,
  status: AdviceStatus.VISIBLE,
  NOT: [
    { file: { is: { courseId: { not: courseId } } } },
    { questionGroup: { is: { courseId: { not: courseId } } } },
  ],
}) satisfies Prisma.AdviceWhereInput;

const adviceSelect = {
  id: true, body: true, anonymous: true, scope: true, topic: true, resourceUrl: true, editedAt: true, createdAt: true,
  author: { select: { name: true } },
  file: { select: { id: true, title: true, category: true, status: true } },
  term: { select: { name: true } },
  questionGroup: { select: { id: true, text: true } },
} satisfies Prisma.AdviceSelect;

type AdviceRow = Prisma.AdviceGetPayload<{ select: typeof adviceSelect }>;

// One advice as students see it. It never holds the author's ID, and never their name when the advice is anonymous.
export type AdviceItem = {
  id: string;
  body: string;
  author: string;
  anonymous: boolean;
  about: AdviceAbout;
  resourceUrl: string | null;
  createdAt: Date;
  edited: boolean;
};

export function toAdviceItem(row: AdviceRow): AdviceItem {
  // Only a published exam paper is named; a pending, rejected, or material file is treated as gone (US-13).
  const exam = row.file && row.file.category === FileCategory.EXAM && row.file.status === FileStatus.PUBLISHED ? row.file : null;
  return {
    id: row.id,
    body: row.body,
    author: authorLabel({ anonymous: row.anonymous, authorName: row.anonymous ? null : row.author?.name ?? null }),
    anonymous: row.anonymous,
    about: adviceAbout({ scope: row.scope, file: exam, term: row.term, topic: row.topic, questionGroup: row.questionGroup }),
    resourceUrl: safeResourceUrl(row.resourceUrl),
    createdAt: row.createdAt,
    edited: row.editedAt !== null,
  };
}

export type AdviceFeed = { items: AdviceItem[]; total: number; page: number; totalPages: number };

// The course feed (US-38): the course's visible advice, newest first, 20 a page. An invalid or out-of-range page falls
// back to the first or last page.
export const getCourseAdvice = (courseId: string, requestedPage: unknown = 1): Promise<AdviceFeed> =>
  timed("advice_feed", { courseId }, async () => {
    try {
      const where = visibleCourseAdvice(courseId);
      const total = await db.advice.count({ where });
      const { page, totalPages } = clampPage(requestedPage, total);
      const rows = total
        ? await db.advice.findMany({
          where, select: adviceSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * ADVICE_PAGE_SIZE, take: ADVICE_PAGE_SIZE,
        })
        : [];
      return { items: rows.map(toAdviceItem), total, page, totalPages };
    } catch (error) {
      logError("advice_feed_retrieval_failed", { courseId, errorType: errorType(error) });
      throw error;
    }
  });
