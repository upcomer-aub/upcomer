import { MockExamDifficulty, MockExamStatus } from "@prisma/client";
import { getConsolidatedExam } from "@/lib/consolidated-exam";
import { db } from "@/lib/db";
import { PUBLISHED_FILES } from "@/lib/file-visibility";
import { questionTopic } from "@/lib/learning-profile";
import { errorCode, logError } from "@/lib/logger";
import {
  cleanAnswer, MOCK_ANSWER_MAX_LENGTH, parseMockExamConfig, selectMockQuestions, sourceQuestionOf,
  type GeneratedCandidate, type MockExamError, type MockExamOptions, type PoolQuestion, type SittingError,
} from "@/lib/mock-exam-rules";
import { excludedIds, type AvoidSet } from "@/lib/mock-exam-version-rules";
import { getGeneratedPracticeQuestions } from "@/lib/practice-generation";
import { courseExams } from "@/lib/question-bank";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";

// Configurable mock exams (US-45). A student picks topics, a length, and a difficulty; the exam is drawn from the course's
// consolidated exam (lib/consolidated-exam.ts), copied into MockExam/MockExamQuestion so it never changes afterwards, and
// then sat: answers are saved and the exam is submitted. Marking and results are US-49 and US-50.
// When the student asks for it, up to half of the exam is their own generated practice questions (US-44). Those are read
// only through getGeneratedPracticeQuestions (Ali Slim's contract), never from the table, and nothing is generated here.
// Nothing here checks the caller: the pages and actions call requireUser() first and pass the session user's ID, and every
// read and write of an exam is limited to its own student. Question text and answers are never logged.

export const MOCK_EXAM_RATE_WINDOW_MS = 60 * 60_000;
export const mockExamLimit = () => limitFromEnv("MOCK_EXAM_RATE_LIMIT_PER_HOUR", 20);
export const MOCK_EXAM_LIST_LIMIT = 20;
// The database is remote: an interactive transaction needs more than the default 5 seconds (as in lib/topic-confidence.ts).
const SAVE_TRANSACTION = { maxWait: 10_000, timeout: 20_000 };

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

// Every question the course's published papers can give, with its topic. Only published papers count (US-13).
export async function buildPool(courseId: string): Promise<PoolQuestion[]> {
  const exam = await getConsolidatedExam(courseId);
  const paperIds = [...new Set(exam.questions.flatMap(question => question.papers.map(paper => paper.id)))];
  const papers = paperIds.length ? await db.courseFile.findMany({ where: { id: { in: paperIds }, courseId, ...PUBLISHED_FILES }, select: { id: true, topic: true } }) : [];
  const topics = new Map(papers.map(paper => [paper.id, paper.topic]));
  return exam.questions.map(question => {
    const topic = questionTopic(question.papers.map(paper => ({ topic: topics.get(paper.id) ?? null })));
    return {
      id: question.id, position: question.position, text: question.text, paperCount: question.paperCount, totalPapers: question.totalPapers,
      topicKey: topic?.topicKey ?? null, topic: topic?.topic ?? null, papers: question.papers.map(paper => ({ id: paper.id, title: paper.title, year: paper.year })),
    };
  });
}

// The student's generated practice questions an exam can include, newest first: only their own, and only those that still
// match a published source (getGeneratedPracticeQuestions checks both).
async function generatedCandidates(userId: string, courseId: string): Promise<GeneratedCandidate[]> {
  const items = await getGeneratedPracticeQuestions(userId, courseId);
  return items.map(item => ({ id: item.id, topicKey: item.topicKey, topic: item.topic, difficulty: item.difficulty, text: item.prompt, sourcePaper: item.sourceQuestion.file.title }));
}

// The topics a student can build an exam from, with how many questions each has, for the form. With a student, also how
// many generated practice questions they have for this course.
export async function getMockExamOptions(courseId: string, userId?: string): Promise<MockExamOptions> {
  try {
    const [pool, generated] = await Promise.all([buildPool(courseId), userId ? generatedCandidates(userId, courseId) : Promise.resolve([])]);
    const topics = new Map<string, { key: string; label: string; count: number }>();
    for (const question of pool) {
      if (!question.topicKey || !question.topic) continue;
      const entry = topics.get(question.topicKey) ?? { key: question.topicKey, label: question.topic, count: 0 };
      entry.count++;
      topics.set(question.topicKey, entry);
    }
    return { total: pool.length, topics: [...topics.values()].sort((a, b) => a.label.localeCompare(b.label)), generated: generated.length };
  } catch (error) {
    logError("mock_exam_retrieval_failed", { courseId, entity: "options", errorType: errorType(error) });
    throw error;
  }
}

export type CreateMockExamInput = { courseId: string; length: string; difficulty: string; topics: string[]; includeGenerated?: boolean };
// `difficultyApplied` is false when an EASY, MEDIUM or HARD exam needed every matching past-paper question, so the
// difficulty could not choose between them.
export type CreateMockExamResult = { ok: true; id: string; difficultyApplied: boolean } | { ok: false; error: MockExamError; available?: number };

const paperLabel = (paper: { title: string; year: number | null }) => (paper.year ? `${paper.title} (${paper.year})` : paper.title);

// US-46 (Lea Tass): an alternative version passes the original exam's ID and the questions its family already used.
export type VersionOf = { originalId: string; avoid: AvoidSet };

// Generates a mock exam for the given student. The exam has exactly the length asked for, only questions of the chosen
// topics, and the chosen difficulty; if the course cannot give that, nothing is saved and the error says how many questions match.
// With `version` (US-46) the questions already used by the exam's versions are left out (selectMockQuestions' `exclude`),
// and the new exam is linked to the original; without it, nothing changes.
// The per-hour limit counts exams that are made: a refused attempt (too few questions, an unknown topic) does not use it up.
export async function createMockExam(userId: string, input: CreateMockExamInput, version?: VersionOf): Promise<CreateMockExamResult> {
  const context = { userId, courseId: input.courseId.slice(0, 100) || undefined };
  const refuse = (error: MockExamError, available?: number): CreateMockExamResult => {
    logError("mock_exam_refused", { ...context, reason: error });
    return { ok: false, error, available };
  };
  const parsed = parseMockExamConfig(input);
  if (!parsed.ok) return refuse(parsed.error);
  const { config } = parsed;
  try {
    const course = await db.course.findUnique({ where: { id: input.courseId }, select: { id: true } });
    if (!course) return refuse("course_not_found");
    const pool = await buildPool(course.id);
    if (!pool.length) return refuse("no_questions");
    const generated = config.includeGenerated ? await generatedCandidates(userId, course.id) : [];
    const selected = selectMockQuestions(pool, config, { generated, ...(version ? { exclude: excludedIds(pool, generated, version.avoid) } : {}) });
    if (!selected.ok) return refuse(selected.error, selected.available);
    const limit = checkRateLimit(`mock-exam:${userId}`, mockExamLimit(), MOCK_EXAM_RATE_WINDOW_MS);
    if (!limit.ok) {
      logError("mock_exam_rate_limited", { ...context, retryAfterSeconds: String(limit.retryAfterSeconds) });
      return { ok: false, error: "rate_limited" };
    }
    // Each past-paper pick records one source question of its group (sourceQuestionOf), for US-49's learning events.
    const sources = await db.question.findMany({
      where: { groupId: { in: selected.questions.map(question => question.id) }, file: courseExams(course.id) },
      select: { id: true, number: true, fileId: true, groupId: true },
    });
    const labels = new Map(pool.flatMap(question => (question.topicKey && question.topic ? [[question.topicKey, question.topic] as const] : [])));
    const created = await db.mockExam.create({
      data: {
        userId, courseId: course.id, topicKeys: config.topicKeys, topics: config.topicKeys.map(key => labels.get(key) ?? key),
        length: config.length, difficulty: MockExamDifficulty[config.difficulty], includeGenerated: config.includeGenerated === true,
        ...(version ? { originalId: version.originalId } : {}),
        questions: {
          create: [
            ...selected.questions.map((question, index) => ({
              position: index + 1, groupId: question.id, topicKey: question.topicKey, topic: question.topic, text: question.text,
              questionId: sourceQuestionOf(question.papers.flatMap(paper => (paper.id ? [{ id: paper.id }] : [])), sources.filter(source => source.groupId === question.id)),
              paperCount: question.paperCount, totalPapers: question.totalPapers, sourcePapers: question.papers.map(paperLabel),
            })),
            // Generated questions follow the past-paper ones. They appeared in no paper, so paperCount is 0.
            ...selected.generated.map((item, index) => ({
              position: selected.questions.length + index + 1, generatedQuestionId: item.id, topicKey: item.topicKey, topic: item.topic, text: item.text,
              paperCount: 0, totalPapers: pool[0].totalPapers, sourcePapers: [item.sourcePaper],
            })),
          ],
        },
      },
      select: { id: true },
    });
    logError("mock_exam_created", {
      ...context, mockExamId: created.id, difficulty: config.difficulty, length: String(config.length), topicCount: String(config.topicKeys.length),
      generatedCount: String(selected.generated.length), ...(version ? { originalId: version.originalId } : {}),
    });
    return { ok: true, id: created.id, difficultyApplied: selected.narrowed || config.difficulty === "MIXED" };
  } catch (error) {
    logError("mock_exam_failed", { ...context, errorType: errorType(error), errorCode: errorCode(error) });
    return { ok: false, error: "unexpected" };
  }
}

// One of the student's own mock exams with its questions in sitting order, or null. Another student's exam is also null,
// so the answer never says whether an ID exists.
export async function getMockExam(userId: string, mockExamId: string) {
  try {
    return await db.mockExam.findFirst({
      where: { id: mockExamId, userId },
      select: {
        id: true, courseId: true, length: true, difficulty: true, topics: true, includeGenerated: true, status: true, createdAt: true, submittedAt: true,
        questions: {
          orderBy: { position: "asc" },
          select: { id: true, position: true, topic: true, text: true, paperCount: true, totalPapers: true, sourcePapers: true, answer: true },
        },
      },
    });
  } catch (error) {
    logError("mock_exam_retrieval_failed", { userId, mockExamId: mockExamId.slice(0, 100), errorType: errorType(error) });
    throw error;
  }
}
export type MockExamView = NonNullable<Awaited<ReturnType<typeof getMockExam>>>;

// The student's latest mock exams in one course, newest first.
export async function listMyMockExams(userId: string, courseId: string) {
  try {
    return await db.mockExam.findMany({
      where: { userId, courseId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MOCK_EXAM_LIST_LIMIT,
      select: { id: true, length: true, difficulty: true, topics: true, includeGenerated: true, status: true, createdAt: true, submittedAt: true },
    });
  } catch (error) {
    logError("mock_exam_retrieval_failed", { userId, courseId, entity: "list", errorType: errorType(error) });
    throw error;
  }
}

export type SittingResult = { ok: true; submitted: boolean } | { ok: false; error: SittingError };

class Refused extends Error {
  constructor(readonly reason: SittingError) {
    super(reason);
  }
}

// Saves the student's answers (keyed by the exam question's ID), and with `submit` also submits the exam. Answers of other
// exams' questions are ignored. A submitted exam cannot change: claiming the exam and writing the answers are one
// transaction, so two tabs can never both submit it, and nothing is written once it is submitted.
// Answers are tidied first (cleanAnswer), so the length limit counts a line break once, as the browser's maxLength does.
// All answers are written by one statement that touches only this exam's questions and only the answers that changed: a
// 50-question exam is one round trip, not 50, which matters on a remote database.
export async function saveMockExam(userId: string, mockExamId: string, answers: Record<string, string>, submit: boolean): Promise<SittingResult> {
  const context = { userId, mockExamId: mockExamId.slice(0, 100), submit: String(submit) };
  const cleaned = Object.entries(answers).map(([id, raw]) => [id, cleanAnswer(raw)] as const);
  if (cleaned.some(([, answer]) => answer.length > MOCK_ANSWER_MAX_LENGTH)) {
    logError("mock_exam_save_refused", { ...context, reason: "answer_too_long" });
    return { ok: false, error: "answer_too_long" };
  }
  try {
    await db.$transaction(async tx => {
      const now = new Date();
      const claimed = await tx.mockExam.updateMany({
        where: { id: mockExamId, userId, status: MockExamStatus.IN_PROGRESS },
        data: submit ? { status: MockExamStatus.SUBMITTED, submittedAt: now } : { updatedAt: now },
      });
      if (claimed.count === 0) {
        const exists = await tx.mockExam.findFirst({ where: { id: mockExamId, userId }, select: { id: true } });
        throw new Refused(exists ? "already_submitted" : "not_found");
      }
      if (!cleaned.length) return;
      const ids = cleaned.map(([id]) => id);
      // An empty answer is sent as '' and stored as NULL.
      const texts = cleaned.map(([, answer]) => answer);
      await tx.$executeRaw`
        UPDATE "MockExamQuestion" AS question
        SET "answer" = NULLIF(sent.answer, ''), "answeredAt" = CASE WHEN sent.answer = '' THEN NULL ELSE ${now}::timestamp END
        FROM unnest(${ids}::text[], ${texts}::text[]) AS sent(id, answer)
        WHERE question."id" = sent.id AND question."mockExamId" = ${mockExamId}
          AND question."answer" IS DISTINCT FROM NULLIF(sent.answer, '')`;
    }, SAVE_TRANSACTION);
    logError(submit ? "mock_exam_submitted" : "mock_exam_saved", context);
    return { ok: true, submitted: submit };
  } catch (error) {
    if (error instanceof Refused) {
      logError("mock_exam_save_refused", { ...context, reason: error.reason });
      return { ok: false, error: error.reason };
    }
    logError("mock_exam_save_failed", { ...context, errorType: errorType(error), errorCode: errorCode(error) });
    return { ok: false, error: "unexpected" };
  }
}
