import { MockExamStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordLearningEvents } from "@/lib/learning-evidence";
import type { LearningEventInput } from "@/lib/learning-evidence-rules";
import { errorCode, logError } from "@/lib/logger";
import { eventCorrect, markAnswer, parseAnswerKey, type AnswerKeyError, type Marking, type MarkOutcomeName } from "@/lib/mock-marking-rules";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";
import { timed } from "@/lib/timing";

// Marking a submitted mock exam (US-49). Each past-paper question is marked against its question group's answer key
// (AnswerKey, written by an admin), by the rules in lib/mock-marking-rules.ts. A question with no key (no admin wrote one,
// its group was regrouped away, or a generated practice question, which has no key) is marked NO_KEY: flagged, never
// guessed, and it records no learning event.
//
// The marking is stored on each MockExamQuestion (outcome, the key points covered and missed, the explanation), copied
// at marking time like the exam's question text, so a later change to an answer key never changes a marked exam. An exam
// is marked once: the write claims the exam (SUBMITTED and not yet marked), so two tabs or a retry mark it only once.
// Then each marked past-paper question records a MOCK_EXAM learning event (US-25's contract), so the student's profile
// and recommendations use the result. Nothing here checks the session: callers pass the session user's ID. Answers and
// key text are never logged.

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

export type MarkResult =
  | { ok: true; marked: boolean; counts: Record<MarkOutcomeName, number>; eventsRecorded: number; eventsSkipped: number }
  | { ok: false; error: "not_found" | "not_submitted" | "unexpected" };

const emptyCounts = (): Record<MarkOutcomeName, number> => ({ CORRECT: 0, PARTIAL: 0, INCORRECT: 0, UNANSWERED: 0, NO_KEY: 0 });

// The stable ID of a question's learning event: one per exam question, so a retried delivery is a duplicate, not a
// second event.
export const mockEventId = (mockExamId: string, position: number) => `mock:${mockExamId}:${position}`.slice(0, 160);

// Delivers the learning events. recordLearningEvents is all or nothing, and refuses an event whose source question is no
// longer published, so after a refusal the events are sent one by one and those refused are skipped (and counted).
async function deliverEvents(userId: string, courseId: string, events: LearningEventInput[]) {
  if (!events.length) return { recorded: 0, skipped: 0 };
  const all = await recordLearningEvents(userId, courseId, events);
  if (all.ok) return { recorded: all.recorded + all.duplicates, skipped: 0 };
  let recorded = 0;
  let skipped = 0;
  for (const event of events) {
    const one = await recordLearningEvents(userId, courseId, [event]);
    if (one.ok) recorded++;
    else skipped++;
  }
  return { recorded, skipped };
}

// Marks the student's submitted exam if it is not marked yet. Safe to call more than once: a marked exam is left as it is
// (marked: false), and its events are delivered again only as duplicates.
export async function markMockExam(userId: string, mockExamId: string): Promise<MarkResult> {
  const context = { userId, mockExamId: mockExamId.slice(0, 100) };
  try {
    return await timed("mock_exam_marking", context, async (): Promise<MarkResult> => {
      const exam = await db.mockExam.findFirst({
        where: { id: mockExamId, userId },
        select: {
          id: true, courseId: true, status: true, markedAt: true,
          questions: { orderBy: { position: "asc" }, select: { id: true, position: true, groupId: true, questionId: true, generatedQuestionId: true, answer: true } },
        },
      });
      if (!exam) return { ok: false, error: "not_found" };
      if (exam.status !== MockExamStatus.SUBMITTED) return { ok: false, error: "not_submitted" };
      if (exam.markedAt) return { ok: true, marked: false, counts: emptyCounts(), eventsRecorded: 0, eventsSkipped: 0 };

      // Keys only for past-paper questions; a generated question never has one.
      const groupIds = [...new Set(exam.questions.flatMap(question => (question.groupId && !question.generatedQuestionId ? [question.groupId] : [])))];
      const keys = new Map((groupIds.length
        ? await db.answerKey.findMany({ where: { groupId: { in: groupIds }, courseId: exam.courseId }, select: { groupId: true, keyPoints: true, explanation: true } })
        : []).map(key => [key.groupId, key]));
      const marks = exam.questions.map(question => {
        const key = question.groupId && !question.generatedQuestionId ? keys.get(question.groupId) ?? null : null;
        return { question, marking: markAnswer(question.answer, key) satisfies Marking };
      });

      const now = new Date();
      const rows = marks.map(({ question, marking }) => ({
        id: question.id, outcome: marking.outcome, matched: marking.matchedPoints, missed: marking.missedPoints, feedback: marking.feedback,
      }));
      const claimed = await db.$transaction(async tx => {
        const claim = await tx.mockExam.updateMany({ where: { id: exam.id, userId, status: MockExamStatus.SUBMITTED, markedAt: null }, data: { markedAt: now } });
        if (claim.count === 0) return false;
        // One statement for every question of the exam (at most 50), as saveMockExam does.
        await tx.$executeRaw`
          UPDATE "MockExamQuestion" AS question
          SET "outcome" = mark.outcome::"MarkOutcome", "matchedPoints" = ARRAY(SELECT jsonb_array_elements_text(mark.matched)),
              "missedPoints" = ARRAY(SELECT jsonb_array_elements_text(mark.missed)), "feedback" = mark.feedback, "markedAt" = ${now}
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS mark(id text, outcome text, matched jsonb, missed jsonb, feedback text)
          WHERE question."id" = mark.id AND question."mockExamId" = ${exam.id}`;
        return true;
      }, { timeout: 15_000 });
      // Another request marked it first; it delivers the events.
      if (!claimed) return { ok: true, marked: false, counts: emptyCounts(), eventsRecorded: 0, eventsSkipped: 0 };

      const counts = emptyCounts();
      for (const { marking } of marks) counts[marking.outcome]++;
      const events: LearningEventInput[] = marks.flatMap(({ question, marking }) => {
        const correct = eventCorrect(marking.outcome);
        return correct === null || !question.questionId ? [] : [{ source: "MOCK_EXAM" as const, eventId: mockEventId(exam.id, question.position), questionId: question.questionId, correct }];
      });
      let delivered = { recorded: 0, skipped: 0 };
      try {
        delivered = await deliverEvents(userId, exam.courseId, events);
      } catch (error) {
        // The marking is saved; only the profile update failed. It is logged for an admin; the student still sees the marks.
        logError("mock_exam_marking_evidence_failed", { ...context, errorType: errorType(error) });
        delivered = { recorded: 0, skipped: events.length };
      }
      logError("mock_exam_marked", {
        ...context, courseId: exam.courseId, correct: String(counts.CORRECT), partial: String(counts.PARTIAL), incorrect: String(counts.INCORRECT),
        unanswered: String(counts.UNANSWERED), noKey: String(counts.NO_KEY), eventsRecorded: String(delivered.recorded), eventsSkipped: String(delivered.skipped),
      });
      return { ok: true, marked: true, counts, eventsRecorded: delivered.recorded, eventsSkipped: delivered.skipped };
    });
  } catch (error) {
    logError("mock_exam_marking_failed", { ...context, errorType: errorType(error), errorCode: errorCode(error) });
    return { ok: false, error: "unexpected" };
  }
}

// --- Answer keys (admins) -------------------------------------------------------------------------------------------

export const ANSWER_KEY_PAGE_SIZE = 20;

// The course's question groups that appear in a published exam paper, in rank order, with whether each has a key.
export async function listAnswerKeyGroups(courseId: string, requestedPage: unknown = 1) {
  const where: Prisma.QuestionGroupWhereInput = { courseId, questions: { some: { file: { category: "EXAM", status: "PUBLISHED" } } } };
  const total = await db.questionGroup.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / ANSWER_KEY_PAGE_SIZE));
  const number = Number(requestedPage);
  const page = Number.isInteger(number) && number > 0 ? Math.min(number, totalPages) : 1;
  const groups = await db.questionGroup.findMany({
    where, orderBy: [{ rank: "asc" }, { id: "asc" }], skip: (page - 1) * ANSWER_KEY_PAGE_SIZE, take: ANSWER_KEY_PAGE_SIZE,
    select: { id: true, rank: true, text: true, paperCount: true, answerKey: { select: { keyPoints: true, updatedAt: true } } },
  });
  const withKey = await db.answerKey.count({ where: { courseId } });
  return { groups, total, withKey, page, totalPages };
}

export async function getAnswerKeyGroup(courseId: string, groupId: string) {
  if (!groupId) return null;
  return db.questionGroup.findFirst({
    where: { id: groupId, courseId },
    select: { id: true, rank: true, text: true, paperCount: true, answerKey: { select: { keyPoints: true, explanation: true, updatedAt: true } } },
  });
}

// DoS protection: answer keys saved per admin per minute.
export const ANSWER_KEY_WINDOW_MS = 60_000;
export const answerKeyLimit = () => limitFromEnv("ANSWER_KEY_RATE_LIMIT_PER_MINUTE", 60);

export type AnswerKeySaveResult = { ok: true; removed: boolean } | { ok: false; error: AnswerKeyError };

// Saves (or, with remove, deletes) the answer key of one question group of the course. Only exams marked after the save
// use it; marked exams keep the marking they got. The key text is never logged.
export async function saveAnswerKey(adminId: string, input: { courseId: string; groupId: string; keyPoints: string; explanation: string; remove?: boolean }): Promise<AnswerKeySaveResult> {
  const context = { adminId, courseId: input.courseId.slice(0, 100), groupId: input.groupId.slice(0, 100) };
  const limit = checkRateLimit(`answer-key:${adminId}`, answerKeyLimit(), ANSWER_KEY_WINDOW_MS);
  if (!limit.ok) {
    logError("answer_key_rate_limited", { ...context, retryAfterSeconds: String(limit.retryAfterSeconds) });
    return { ok: false, error: "rate_limited" };
  }
  const parsed = input.remove ? null : parseAnswerKey(input);
  if (parsed && !parsed.ok) {
    logError("answer_key_refused", { ...context, reason: parsed.error });
    return { ok: false, error: parsed.error };
  }
  try {
    return await timed("answer_key_save", context, async (): Promise<AnswerKeySaveResult> => {
      const group = await db.questionGroup.findFirst({ where: { id: input.groupId, courseId: input.courseId }, select: { id: true } });
      if (!group) {
        logError("answer_key_refused", { ...context, reason: "not_found" });
        return { ok: false, error: "not_found" };
      }
      if (!parsed) {
        await db.answerKey.deleteMany({ where: { groupId: group.id } });
        logError("answer_key_removed", context);
        return { ok: true, removed: true };
      }
      const data = { keyPoints: parsed.keyPoints, explanation: parsed.explanation, updatedById: adminId };
      await db.answerKey.upsert({ where: { groupId: group.id }, create: { groupId: group.id, courseId: input.courseId, ...data }, update: data });
      logError("answer_key_saved", { ...context, keyPoints: String(parsed.keyPoints.length) });
      return { ok: true, removed: false };
    });
  } catch (error) {
    logError("answer_key_save_failed", { ...context, errorType: errorType(error), errorCode: errorCode(error) });
    return { ok: false, error: "unexpected" };
  }
}
