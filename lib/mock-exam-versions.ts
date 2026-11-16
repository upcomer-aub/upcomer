import { db } from "@/lib/db";
import { errorCode, logError } from "@/lib/logger";
import { avoidSetOf, numberVersions, type VersionError } from "@/lib/mock-exam-version-rules";
import { createMockExam } from "@/lib/mock-exams";

// US-46 (Lea Tass): an alternative version of a mock exam. The new exam has the original's settings (topics, length,
// difficulty, generated questions) and none of the questions of the original or any earlier version. It is built by
// US-45's createMockExam with selectMockQuestions' `exclude` (Mustafa's contract), and linked to the original through
// MockExam.originalId. Every version points at the original, so a family is the original plus the exams linked to it.
// Nothing here checks the session: the action calls requireUser() first and passes the session user's ID, and every read is
// limited to that student's own exams. Question text is never logged.

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

// Two quick clicks on one family must not both read the family before either saves, or the two new versions could share
// questions. Requests for one family run one after the other in this server process (as the rate limits, lib/rate-limit.ts,
// one process is assumed).
const familyLocks = new Map<string, Promise<unknown>>();
async function inFamilyOrder<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = familyLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  familyLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (familyLocks.get(key) === current) familyLocks.delete(key);
  }
}

const familyWhere = (userId: string, originalId: string) => ({ userId, OR: [{ id: originalId }, { originalId }] });

export type AlternativeResult =
  | { ok: true; id: string; courseId: string; difficultyApplied: boolean; version: number }
  | { ok: false; error: VersionError; available?: number; length?: number };

// Makes the next version of one of the student's own mock exams. Another student's exam is not found, like a missing one.
export async function createAlternativeMockExam(userId: string, mockExamId: string): Promise<AlternativeResult> {
  const context = { userId, mockExamId: mockExamId.slice(0, 100) || undefined };
  const refuse = (error: VersionError, extra: { available?: number; length?: number; courseId?: string; originalId?: string } = {}): AlternativeResult => {
    logError("mock_exam_version_refused", {
      ...context, courseId: extra.courseId, originalId: extra.originalId, reason: error,
      available: extra.available === undefined ? undefined : String(extra.available),
    });
    return { ok: false, error, available: extra.available, length: extra.length };
  };
  try {
    const exam = mockExamId ? await db.mockExam.findFirst({
      where: { id: mockExamId, userId },
      select: { id: true, courseId: true, originalId: true, topicKeys: true, length: true, difficulty: true, includeGenerated: true, timeLimitMinutes: true },
    }) : null;
    if (!exam) return refuse("not_found");
    const originalId = exam.originalId ?? exam.id;
    return await inFamilyOrder(`${userId}:${originalId}`, async () => {
      const used = await db.mockExamQuestion.findMany({ where: { mockExam: familyWhere(userId, originalId) }, select: { groupId: true, generatedQuestionId: true, text: true } });
      const result = await createMockExam(userId, {
        courseId: exam.courseId, length: String(exam.length), difficulty: exam.difficulty, topics: exam.topicKeys, includeGenerated: exam.includeGenerated, timeLimit: exam.timeLimitMinutes == null ? "" : String(exam.timeLimitMinutes),
      }, { originalId, avoid: avoidSetOf(used) });
      if (!result.ok) {
        const error: VersionError = result.error === "length_invalid" || result.error === "difficulty_invalid" || result.error === "time_limit_invalid" ? "unexpected" : result.error;
        return refuse(error, { available: result.available, length: exam.length, courseId: exam.courseId, originalId });
      }
      const family = await db.mockExam.findMany({ where: familyWhere(userId, originalId), select: { id: true, createdAt: true } });
      const version = numberVersions(family).find(item => item.id === result.id)?.version ?? family.length;
      logError("mock_exam_version_created", { ...context, courseId: exam.courseId, originalId, newMockExamId: result.id, version: String(version) });
      return { ok: true, id: result.id, courseId: exam.courseId, difficultyApplied: result.difficultyApplied, version };
    });
  } catch (error) {
    logError("mock_exam_version_failed", { ...context, errorType: errorType(error), errorCode: errorCode(error) });
    return { ok: false, error: "unexpected" };
  }
}

export type MockExamVersions = { current: number; versions: Array<{ id: string; version: number; status: string; createdAt: Date }> };

// The versions of one of the student's own exams, numbered in the order they were made (the original is 1), and which one
// this exam is. Another student's exam has none. Throws on a failed read, after logging it.
export async function getMockExamVersions(userId: string, mockExamId: string): Promise<MockExamVersions> {
  try {
    const exam = await db.mockExam.findFirst({ where: { id: mockExamId, userId }, select: { id: true, originalId: true } });
    if (!exam) return { current: 0, versions: [] };
    const family = numberVersions(await db.mockExam.findMany({ where: familyWhere(userId, exam.originalId ?? exam.id), select: { id: true, createdAt: true, status: true } }));
    return { current: family.find(item => item.id === exam.id)?.version ?? 1, versions: family };
  } catch (error) {
    logError("mock_exam_version_failed", { userId, mockExamId: mockExamId.slice(0, 100), entity: "list", errorType: errorType(error), errorCode: errorCode(error) });
    throw error;
  }
}
