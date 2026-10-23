import { CorrectionKind, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { PUBLISHED_FILES } from "@/lib/file-visibility";
import { logError } from "@/lib/logger";
import { courseExams, rebuildQuestionBank } from "@/lib/question-bank";
import { cleanCorrectedText, MAX_QUESTION_TEXT_LENGTH, normalizeLineEndings, type CorrectionRefusal } from "@/lib/question-correction-rules";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";
import { hasReadableText } from "@/lib/readable-text";
import { escapeLike } from "@/lib/search";
import { timed } from "@/lib/timing";

// Question corrections: an admin fixes a wrongly extracted question's text, moves a wrongly grouped question to another group,
// or splits it into a group of its own. Every correction is saved in the QuestionCorrection activity log and the course is
// regrouped and re-ranked right away. Moves and splits are stored on the question (pinnedToQuestionId, splitOut) and applied
// by every later rebuild (lib/question-grouping.ts), and a corrected text is never replaced because a file that already has
// questions is not extracted again (lib/exam-processing.ts), so corrections survive the pipeline running again.
// Nothing here checks the caller: the pages and actions call requireAdmin() first.

export const CORRECTION_PAGE_SIZE = 20;
export const CORRECTION_LOG_SIZE = 50;
// Corrections per admin per minute. Far above what a person clicks, so it only stops a script or a stolen session (DoS protection).
export const CORRECTION_WINDOW_MS = 60_000;
export const correctionLimit = () => limitFromEnv("CORRECTION_RATE_LIMIT_PER_MINUTE", 60);

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

const questionSelect = {
  id: true, number: true, text: true, splitOut: true, pinnedToQuestionId: true, textCorrectedAt: true,
  file: { select: { id: true, title: true, year: true } },
} satisfies Prisma.QuestionSelect;

const logSelect = {
  id: true, kind: true, paperTitle: true, questionNumber: true, before: true, after: true, createdAt: true, questionId: true,
  admin: { select: { name: true } },
} satisfies Prisma.QuestionCorrectionSelect;

export type CorrectionLogEntry = Prisma.QuestionCorrectionGetPayload<{ select: typeof logSelect }>;

// A page of the course's groups in rank order, with their questions, and the latest corrections. The keyword keeps the groups
// with a question containing it. An invalid or out-of-range page falls back to the first or last page. Null if no such course.
export async function getCorrectionPage(courseId: string, { page: requestedPage = 1, query = "" }: { page?: number; query?: string } = {}) {
  return timed("question_corrections_page", { courseId }, async () => {
    try {
      const keyword = query.trim();
      const where: Prisma.QuestionGroupWhereInput = {
        courseId,
        questions: { some: { file: PUBLISHED_FILES, ...(keyword ? { text: { contains: escapeLike(keyword), mode: "insensitive" as const } } : {}) } },
      };
      const [course, total] = await Promise.all([
        db.course.findUnique({ where: { id: courseId }, select: { id: true, code: true, name: true } }),
        db.questionGroup.count({ where }),
      ]);
      if (!course) return null;
      const totalPages = Math.max(1, Math.ceil(total / CORRECTION_PAGE_SIZE));
      const page = Number.isInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, totalPages) : 1;
      const [groups, totalPapers, log] = await Promise.all([
        db.questionGroup.findMany({
          where, orderBy: { rank: "asc" }, skip: (page - 1) * CORRECTION_PAGE_SIZE, take: CORRECTION_PAGE_SIZE,
          select: {
            id: true, rank: true, text: true, paperCount: true,
            questions: { where: { file: PUBLISHED_FILES }, select: questionSelect, orderBy: [{ fileId: "asc" }, { number: "asc" }] },
          },
        }),
        db.courseFile.count({ where: { ...courseExams(courseId), questions: { some: {} } } }),
        db.questionCorrection.findMany({ where: { courseId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: CORRECTION_LOG_SIZE, select: logSelect }),
      ]);
      return { course, groups, total, page, totalPages, totalPapers, log, query: keyword };
    } catch (error) {
      logError("question_correction_retrieval_failed", { courseId, errorType: errorType(error) });
      throw error;
    }
  });
}

// One question of the course with its group, every group it can be moved to, and its own corrections. Null if not found.
export async function getQuestionCorrection(courseId: string, questionId: string) {
  try {
    const question = await db.question.findFirst({
      where: { id: questionId, file: courseExams(courseId) },
      select: { ...questionSelect, group: { select: { id: true, rank: true, text: true, paperCount: true } } },
    });
    if (!question) return null;
    const [course, groups, history] = await Promise.all([
      db.course.findUniqueOrThrow({ where: { id: courseId }, select: { id: true, code: true, name: true } }),
      db.questionGroup.findMany({ where: { courseId, questions: { some: { file: PUBLISHED_FILES } } }, orderBy: { rank: "asc" }, select: { id: true, rank: true, text: true } }),
      db.questionCorrection.findMany({ where: { questionId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: CORRECTION_LOG_SIZE, select: logSelect }),
    ]);
    return { course, question, groups, history };
  } catch (error) {
    logError("question_correction_retrieval_failed", { courseId, questionId, errorType: errorType(error) });
    throw error;
  }
}

export type Correction =
  | { kind: "edit"; questionId: string; text: string; previousText: string }
  | { kind: "move"; questionId: string; groupId: string }
  | { kind: "split"; questionId: string }
  | { kind: "reset"; questionId: string };

export type CorrectionOutcome = { ok: true; regrouped: boolean } | { ok: false; error: CorrectionRefusal };

class Refused extends Error {
  constructor(readonly reason: CorrectionRefusal) {
    super(reason);
  }
}

type Tx = Prisma.TransactionClient;
type CorrectedQuestion = { id: string; groupId: string | null; pinnedQuestions: { id: string }[] };

// Questions an admin moved onto this one follow it. Before this one leaves its group, they are pinned to another question that
// stays there, so moving or splitting one question never takes the others with it. If nothing else stays, the first of them
// is grouped by its own text again and the rest stay with it.
async function keepFollowersInPlace(tx: Tx, question: CorrectedQuestion) {
  if (!question.pinnedQuestions.length) return;
  const followers = question.pinnedQuestions.map(item => item.id);
  const staying = question.groupId ? await tx.question.findMany({
    where: { groupId: question.groupId, id: { notIn: [question.id, ...followers] }, file: PUBLISHED_FILES },
    select: { id: true, pinnedToQuestionId: true }, orderBy: [{ fileId: "asc" }, { number: "asc" }],
  }) : [];
  const anchor = staying.find(item => !item.pinnedToQuestionId) ?? staying[0];
  if (anchor) {
    await tx.question.updateMany({ where: { id: { in: followers } }, data: { pinnedToQuestionId: anchor.id } });
    return;
  }
  const [first, ...rest] = await tx.question.findMany({ where: { id: { in: followers } }, select: { id: true }, orderBy: [{ fileId: "asc" }, { number: "asc" }] });
  await tx.question.update({ where: { id: first.id }, data: { pinnedToQuestionId: null } });
  if (rest.length) await tx.question.updateMany({ where: { id: { in: rest.map(item => item.id) } }, data: { pinnedToQuestionId: first.id } });
}

async function applyCorrection(tx: Tx, adminId: string, courseId: string, correction: Correction) {
  // The same per-course lock as rebuildQuestionBank, so a correction never interleaves with a regroup of the course.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${courseId}))`;
  const question = await tx.question.findFirst({
    where: { id: correction.questionId, file: courseExams(courseId) },
    select: {
      id: true, number: true, text: true, groupId: true, splitOut: true, pinnedToQuestionId: true,
      file: { select: { title: true } }, group: { select: { text: true } }, pinnedQuestions: { select: { id: true } },
    },
  });
  if (!question) throw new Refused("not_found");
  const record = (kind: CorrectionKind, before: string | null, after: string | null) => tx.questionCorrection.create({
    data: { courseId, questionId: question.id, adminId, kind, paperTitle: question.file.title, questionNumber: question.number, before, after },
  });
  const groupText = question.group?.text ?? null;

  if (correction.kind === "edit") {
    const current = cleanCorrectedText(question.text);
    if (current !== cleanCorrectedText(correction.previousText)) throw new Refused("stale");
    if (current === correction.text) throw new Refused("text_unchanged");
    await tx.question.update({ where: { id: question.id }, data: { text: correction.text, textCorrectedAt: new Date() } });
    await record(CorrectionKind.EDIT_TEXT, question.text, correction.text);
  } else if (correction.kind === "move") {
    const target = await tx.questionGroup.findFirst({
      where: { id: correction.groupId, courseId },
      select: {
        id: true, text: true,
        questions: { where: { file: PUBLISHED_FILES, id: { not: question.id } }, select: { id: true, pinnedToQuestionId: true }, orderBy: [{ fileId: "asc" }, { number: "asc" }] },
      },
    });
    if (!target || !target.questions.length) throw new Refused("group_not_found");
    if (question.groupId === target.id) throw new Refused("same_group");
    // Prefer an anchor that is in the group because of its own text rather than because of a pin.
    const anchor = target.questions.find(item => !item.pinnedToQuestionId) ?? target.questions[0];
    await keepFollowersInPlace(tx, question);
    await tx.question.update({ where: { id: question.id }, data: { pinnedToQuestionId: anchor.id, splitOut: false } });
    await record(CorrectionKind.MOVE, groupText, target.text);
  } else if (correction.kind === "split") {
    if (question.splitOut) throw new Refused("already_split");
    await keepFollowersInPlace(tx, question);
    await tx.question.update({ where: { id: question.id }, data: { splitOut: true, pinnedToQuestionId: null } });
    await record(CorrectionKind.SPLIT, groupText, null);
  } else {
    if (!question.splitOut && !question.pinnedToQuestionId) throw new Refused("not_corrected");
    await keepFollowersInPlace(tx, question);
    await tx.question.update({ where: { id: question.id }, data: { splitOut: false, pinnedToQuestionId: null } });
    await record(CorrectionKind.RESET, groupText, null);
  }
}

// Saves one correction for an admin, logs it, then regroups and re-ranks the course. A failed regroup does not undo the
// correction; it is reported so the admin can regroup again. The question's text is never logged.
export async function correctQuestion(adminId: string, courseId: string, correction: Correction): Promise<CorrectionOutcome> {
  const context = { courseId: courseId || undefined, questionId: correction.questionId || undefined, kind: correction.kind, userId: adminId };
  const limit = checkRateLimit(`correction:${adminId}`, correctionLimit(), CORRECTION_WINDOW_MS);
  if (!limit.ok) {
    logError("question_correction_rate_limited", { ...context, retryAfterSeconds: String(limit.retryAfterSeconds) });
    return { ok: false, error: "rate_limited" };
  }
  const refuse = (reason: CorrectionRefusal): CorrectionOutcome => {
    logError("question_correction_refused", { ...context, reason });
    return { ok: false, error: reason };
  };
  if (correction.kind === "edit") {
    const text = cleanCorrectedText(correction.text);
    if (!hasReadableText(text)) return refuse("text_required");
    if (text.length > MAX_QUESTION_TEXT_LENGTH) return refuse("text_too_long");
    correction = { ...correction, text, previousText: normalizeLineEndings(correction.previousText) };
  }
  const saved = correction;
  return timed(`question_correction_${correction.kind}`, context, async (): Promise<CorrectionOutcome> => {
    try {
      await db.$transaction(tx => applyCorrection(tx, adminId, courseId, saved));
    } catch (error) {
      if (error instanceof Refused) return refuse(error.reason);
      logError("question_correction_failed", { ...context, errorType: errorType(error) });
      return { ok: false, error: "unexpected" };
    }
    const rebuilt = await rebuildQuestionBank(courseId);
    logError("question_corrected", { ...context, regrouped: String(rebuilt.ok) });
    return { ok: true, regrouped: rebuilt.ok };
  });
}
