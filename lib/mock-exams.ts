import { MockExamDifficulty, MockExamMix, MockExamStatus, Prisma } from "@prisma/client";
import { getConsolidatedExam } from "@/lib/consolidated-exam";
import { db } from "@/lib/db";
import { PUBLISHED_FILES } from "@/lib/file-visibility";
import { getLearningProfile, questionTopic, type LearningProfile } from "@/lib/learning-profile";
import { errorCode, logError } from "@/lib/logger";
import {
  cleanAnswer, MOCK_ANSWER_MAX_LENGTH, parseMockExamConfig, sourceQuestionOf,
  type GeneratedCandidate, type MockExamError, type MockExamOptions, type PoolQuestion, type SittingError,
} from "@/lib/mock-exam-rules";
import { selectMockQuestions } from "@/lib/mock-exam-mix";
import { finishesNow, isExpired, oldestOpenDeadline, timeLeftMs } from "@/lib/mock-exam-timing";
import { excludedIds, type AvoidSet } from "@/lib/mock-exam-version-rules";
import { getGeneratedPracticeQuestions } from "@/lib/practice-generation";
import { courseExams } from "@/lib/question-bank";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";

// Configurable mock exams (US-45). A student picks topics, a length, and a difficulty; the exam is drawn from the course's
// consolidated exam (lib/consolidated-exam.ts), copied into MockExam/MockExamQuestion so it never changes afterwards, and
// then sat: answers are saved and the exam is submitted. Marking and results are US-49 and US-50.
// When the student asks for it, up to half of the exam is their own generated practice questions (US-44). Those are read
// only through getGeneratedPracticeQuestions (Ali Slim's contract), never from the table, and nothing is generated here.
// The topic mix is weighted by the student's learning profile in this course and by exam frequency (US-47, the rules are
// in lib/mock-exam-mix.ts). Topics marked as covered (US-32) are not read.
// An exam can have a time limit (US-48, the rules are in lib/mock-exam-timing.ts). The server is the only clock: the
// deadline is stored when the student presses Start, a save after it (plus a few seconds of grace) is refused, and an exam
// whose time ran out is submitted with the answers saved by then, the next time anything reads or writes it
// (finalizeExpiredMockExams). Until a timed exam is started, its questions are not returned to anyone.
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
type SourcedCandidate = GeneratedCandidate & { sourceQuestionId: string };
const withoutSource = ({ sourceQuestionId, ...item }: SourcedCandidate): GeneratedCandidate => (void sourceQuestionId, item);
async function generatedCandidates(userId: string, courseId: string): Promise<SourcedCandidate[]> {
  const items = await getGeneratedPracticeQuestions(userId, courseId);
  return items.map(item => ({
    id: item.id, topicKey: item.topicKey, topic: item.topic, difficulty: item.difficulty, text: item.prompt, sourcePaper: item.sourceQuestion.file.title,
    sourceQuestionId: item.sourceQuestionId,
  }));
}

// Each generated question's source question's group in the pool, by its paper count (US-47 ranks generated questions by
// it, since they appeared in no paper). A source outside the pool is left unknown, which the rules count as one paper.
async function withSourcePaperCounts(items: SourcedCandidate[], pool: PoolQuestion[]): Promise<GeneratedCandidate[]> {
  const ids = [...new Set(items.map(item => item.sourceQuestionId))];
  const sources = ids.length ? await db.question.findMany({ where: { id: { in: ids } }, select: { id: true, groupId: true } }) : [];
  const groups = new Map(sources.map(source => [source.id, source.groupId]));
  const counts = new Map(pool.map(question => [question.id, question.paperCount]));
  return items.map(item => {
    const group = groups.get(item.sourceQuestionId);
    const count = group ? counts.get(group) : undefined;
    return count === undefined ? withoutSource(item) : { ...withoutSource(item), sourcePaperCount: count };
  });
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

export type CreateMockExamInput = { courseId: string; length: string; difficulty: string; topics: string[]; includeGenerated?: boolean; timeLimit?: string };
// `difficultyApplied` is false when an EASY, MEDIUM or HARD exam needed every matching past-paper question, so the
// difficulty could not choose between them.
export type CreateMockExamResult = { ok: true; id: string; difficultyApplied: boolean; length: number } | { ok: false; error: MockExamError; available?: number };

const paperLabel = (paper: { title: string; year: number | null }) => (paper.year ? `${paper.title} (${paper.year})` : paper.title);

export type VersionOf = { originalId: string; avoid: AvoidSet };

// Generates a mock exam for the given student, with only questions of the chosen topics and the chosen difficulty. It has
// the length asked for, or the largest length those allow (US-45): the exam keeps both, and its page says it is shorter.
// It is refused only when nothing matches.
// The topic mix follows the student's profile in this course and exam frequency (US-47). If the profile cannot be read,
// the exam is still made, by exam frequency only, and says so; the failure is logged.
// The per-hour limit counts exams that are made: a refused attempt (an unknown topic, nothing matching) does not use it up.
export async function createMockExam(userId: string, input: CreateMockExamInput, version?: VersionOf): Promise<CreateMockExamResult> {
  const context = { userId, courseId: input.courseId.slice(0, 100) || undefined };
  const refuse = (error: MockExamError, available?: number): CreateMockExamResult => {
    logError("mock_exam_refused", { ...context, reason: error });
    return { ok: false, error, available };
  };
  const parsed = parseMockExamConfig(input);
  if (!parsed.ok) return refuse(parsed.error);
  const { config, timeLimitMinutes } = parsed;
  try {
    const course = await db.course.findUnique({ where: { id: input.courseId }, select: { id: true } });
    if (!course) return refuse("course_not_found");
    const pool = await buildPool(course.id);
    if (!pool.length) return refuse("no_questions");
    const weighting = (step: string, error: unknown) => logError("mock_exam_weighting_failed", { ...context, step, errorType: errorType(error) });
    let generated: GeneratedCandidate[] = [];
    if (config.includeGenerated) {
      const items = await generatedCandidates(userId, course.id);
      generated = await withSourcePaperCounts(items, pool).catch(error => {
        weighting("generated_sources", error);
        return items.map(withoutSource);
      });
    }
    let profile: LearningProfile | null = null;
    try {
      profile = await getLearningProfile(userId, course.id);
    } catch (error) {
      weighting("profile", error);
    }
    const selected = selectMockQuestions(pool, config, { generated, profile: profile ?? undefined, ...(version ? { requireFullLength: true, exclude: excludedIds(pool, generated, version.avoid) } : {}) });
    if (!selected.ok) return refuse(selected.error, selected.available);
    if (version && selected.length !== config.length) return refuse("not_enough_questions", selected.length);
    const mixBasis = !profile ? MockExamMix.PROFILE_UNAVAILABLE : selected.hasProfile ? MockExamMix.PROFILE : MockExamMix.NO_PROFILE;
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
        length: selected.length, requestedLength: selected.requested, difficulty: MockExamDifficulty[config.difficulty], includeGenerated: config.includeGenerated === true,
        mixBasis, weakTopics: mixBasis === MockExamMix.PROFILE ? selected.weakTopics : [], timeLimitMinutes,
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
    if (selected.invalidTopics) {
      logError("mock_exam_weighting_invalid_inputs", { ...context, mockExamId: created.id, affectedTopics: String(selected.invalidTopics), reasons: selected.reasons.join(",") });
    }
    logError("mock_exam_created", {
      ...context, mockExamId: created.id, difficulty: config.difficulty, length: String(selected.length), requestedLength: String(selected.requested),
      topicCount: String(config.topicKeys.length), generatedCount: String(selected.generated.length), mixBasis, weakTopicCount: String(selected.weakTopics.length),
      ...(timeLimitMinutes !== null && { timeLimitMinutes: String(timeLimitMinutes) }),
      ...(version ? { originalId: version.originalId } : {}),
    });
    return { ok: true, id: created.id, difficultyApplied: selected.narrowed || config.difficulty === "MIXED", length: selected.length };
  } catch (error) {
    logError("mock_exam_failed", { ...context, errorType: errorType(error), errorCode: errorCode(error) });
    return { ok: false, error: "unexpected" };
  }
}

// Submits every exam whose time ran out (the deadline plus the grace is past) and that is still in progress, with the
// answers saved by then: SUBMITTED, timedOut, and submittedAt = the deadline. One conditional statement, so it is safe to
// call from anywhere, any number of times, at once: each exam is finalized exactly once. It runs before every read of an
// exam here; US-49 calls it before it looks for exams to mark, so an exam whose student never came back is still marked.
// At least one of the filters is required. Returns the IDs it finalized.
export async function finalizeExpiredMockExams(
  filter: { userId?: string; courseId?: string; mockExamId?: string }, trigger: "read" | "late_save" = "read", now = new Date(),
  client: Pick<typeof db, "$queryRaw"> = db,
): Promise<string[]> {
  if (!filter.userId && !filter.courseId && !filter.mockExamId) return [];
  const rows = await client.$queryRaw<Array<{ id: string; userId: string; answered: number }>>`
    UPDATE "MockExam" AS exam
    SET "status" = 'SUBMITTED'::"MockExamStatus", "timedOut" = true, "submittedAt" = exam."deadlineAt", "updatedAt" = (${now}::timestamptz AT TIME ZONE 'UTC')
    WHERE exam."status" = 'IN_PROGRESS'::"MockExamStatus" AND exam."deadlineAt" < (${oldestOpenDeadline(now)}::timestamptz AT TIME ZONE 'UTC')
      ${filter.userId ? Prisma.sql`AND exam."userId" = ${filter.userId}` : Prisma.empty}
      ${filter.courseId ? Prisma.sql`AND exam."courseId" = ${filter.courseId}` : Prisma.empty}
      ${filter.mockExamId ? Prisma.sql`AND exam."id" = ${filter.mockExamId}` : Prisma.empty}
    RETURNING exam."id", exam."userId",
      (SELECT count(*)::int FROM "MockExamQuestion" AS question WHERE question."mockExamId" = exam."id" AND question."answer" IS NOT NULL) AS answered`;
  for (const row of rows) logError("mock_exam_expired", { userId: row.userId, mockExamId: row.id, trigger, answeredCount: String(row.answered) });
  return rows.map(row => row.id);
}

// One of the student's own mock exams with its questions in sitting order, or null. Another student's exam is also null,
// so the answer never says whether an ID exists. An exam whose time ran out is submitted first.
// `locked`: a timed exam that was not started yet. Its questions are left out here, on the server, so nothing can show
// them before the clock runs. `remainingMs`: the server's time left on a running timed exam, otherwise null.
export async function getMockExam(userId: string, mockExamId: string) {
  try {
    const now = new Date();
    await finalizeExpiredMockExams({ userId, mockExamId }, "read", now);
    const exam = await db.mockExam.findFirst({
      where: { id: mockExamId, userId },
      select: {
        id: true, courseId: true, length: true, requestedLength: true, difficulty: true, topics: true, includeGenerated: true, mixBasis: true, weakTopics: true,
        status: true, createdAt: true, submittedAt: true, timeLimitMinutes: true, startedAt: true, deadlineAt: true, timedOut: true,
        markedAt: true,
        questions: {
          orderBy: { position: "asc" },
          select: {
            id: true, position: true, topic: true, text: true, paperCount: true, totalPapers: true, sourcePapers: true, answer: true,
            outcome: true, matchedPoints: true, missedPoints: true, feedback: true,
            // US-51: the past-paper source question, for the walkthrough link once the exam is submitted (null for generated).
            questionId: true,
          },
        },
      },
    });
    if (!exam) return null;
    const locked = exam.timeLimitMinutes !== null && exam.startedAt === null && exam.status === MockExamStatus.IN_PROGRESS;
    const remainingMs = exam.deadlineAt && exam.status === MockExamStatus.IN_PROGRESS ? timeLeftMs(exam.deadlineAt, now) : null;
    return { ...exam, questions: locked ? [] : exam.questions, locked, remainingMs };
  } catch (error) {
    logError("mock_exam_retrieval_failed", { userId, mockExamId: mockExamId.slice(0, 100), errorType: errorType(error) });
    throw error;
  }
}
export type MockExamView = NonNullable<Awaited<ReturnType<typeof getMockExam>>>;

// The student's latest mock exams in one course, newest first. Exams whose time ran out are submitted first.
export async function listMyMockExams(userId: string, courseId: string) {
  try {
    await finalizeExpiredMockExams({ userId, courseId });
    return await db.mockExam.findMany({
      where: { userId, courseId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MOCK_EXAM_LIST_LIMIT,
      select: {
        id: true, length: true, difficulty: true, topics: true, includeGenerated: true, status: true, createdAt: true, submittedAt: true,
        markedAt: true, timeLimitMinutes: true, startedAt: true, timedOut: true,
      },
    });
  } catch (error) {
    logError("mock_exam_retrieval_failed", { userId, courseId, entity: "list", errorType: errorType(error) });
    throw error;
  }
}

export type StartResult = { ok: true; started: boolean } | { ok: false; error: "not_found" | "unexpected" };

// Starts the student's timed exam: the start and the deadline are set from the server's clock, once. Pressing Start again
// (or on an untimed or submitted exam) changes nothing, so the deadline can never move.
export async function startMockExam(userId: string, mockExamId: string): Promise<StartResult> {
  const context = { userId, mockExamId: mockExamId.slice(0, 100) };
  try {
    const now = new Date();
    const started = await db.$queryRaw<Array<{ courseId: string; timeLimitMinutes: number; length: number }>>`
      UPDATE "MockExam" AS exam
      SET "startedAt" = (${now}::timestamptz AT TIME ZONE 'UTC'), "deadlineAt" = (${now}::timestamptz AT TIME ZONE 'UTC') + exam."timeLimitMinutes" * interval '1 minute', "updatedAt" = (${now}::timestamptz AT TIME ZONE 'UTC')
      WHERE exam."id" = ${mockExamId} AND exam."userId" = ${userId} AND exam."status" = 'IN_PROGRESS'::"MockExamStatus"
        AND exam."timeLimitMinutes" IS NOT NULL AND exam."startedAt" IS NULL
      RETURNING exam."courseId", exam."timeLimitMinutes", exam."length"`;
    if (started.length) {
      const [exam] = started;
      logError("mock_exam_timer_started", { ...context, courseId: exam.courseId, timeLimitMinutes: String(exam.timeLimitMinutes), questionCount: String(exam.length) });
      return { ok: true, started: true };
    }
    const exists = await db.mockExam.findFirst({ where: { id: mockExamId, userId }, select: { id: true } });
    return exists ? { ok: true, started: false } : { ok: false, error: "not_found" };
  } catch (error) {
    logError("mock_exam_save_failed", { ...context, submit: "false", errorType: errorType(error), errorCode: errorCode(error) });
    return { ok: false, error: "unexpected" };
  }
}

// `save` keeps the answers; `submit` also locks the exam; `finish` is the browser's final save when its countdown reaches
// zero: it locks the exam as timed out if the server agrees the time is up, and is otherwise only a save.
export type SaveMode = "save" | "submit" | "finish";
// On a timed exam the result also carries the server's time left, so the countdown can correct itself.
export type SittingResult = { ok: true; submitted: boolean; timedOut?: true; remainingMs?: number } | { ok: false; error: SittingError };

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
// A timed exam (US-48) accepts a save only between its start and its deadline plus the grace, by the server's clock. A
// later one saves nothing: the exam is submitted as timed out with the answers saved before, and the save is refused
// with `time_up`. The claim repeats the deadline, so a save racing the deadline cannot slip through.
export async function saveMockExam(userId: string, mockExamId: string, answers: Record<string, string>, submit: boolean | SaveMode): Promise<SittingResult> {
  const mode: SaveMode = submit === true ? "submit" : submit === false ? "save" : submit;
  const context = { userId, mockExamId: mockExamId.slice(0, 100), submit: String(mode === "submit") };
  const cleaned = Object.entries(answers).map(([id, raw]) => [id, cleanAnswer(raw)] as const);
  if (cleaned.some(([, answer]) => answer.length > MOCK_ANSWER_MAX_LENGTH)) {
    logError("mock_exam_save_refused", { ...context, reason: "answer_too_long" });
    return { ok: false, error: "answer_too_long" };
  }
  try {
    const outcome = await db.$transaction(async tx => {
      const now = new Date();
      const exam = await tx.mockExam.findFirst({ where: { id: mockExamId, userId }, select: { status: true, timeLimitMinutes: true, startedAt: true, deadlineAt: true, timedOut: true } });
      if (!exam) throw new Refused("not_found");
      if (exam.status !== MockExamStatus.IN_PROGRESS) throw new Refused(exam.timedOut ? "time_up" : "already_submitted");
      const timed = exam.timeLimitMinutes !== null;
      if (timed && !exam.deadlineAt) throw new Refused("not_started");
      const deadline = timed ? exam.deadlineAt : null;
      if (deadline && isExpired(deadline, now)) {
        // Too late: nothing of this save is kept. The exam ends here, in this transaction, so it commits.
        await finalizeExpiredMockExams({ userId, mockExamId }, "late_save", now, tx);
        return { late: true as const, lateBySeconds: Math.round((now.getTime() - deadline.getTime()) / 1000) };
      }
      const finishing = mode === "finish" && finishesNow(deadline, now);
      const claimed = await tx.mockExam.updateMany({
        where: { id: mockExamId, userId, status: MockExamStatus.IN_PROGRESS, ...(deadline && { deadlineAt: { gte: oldestOpenDeadline(now) } }) },
        data: mode === "submit" ? { status: MockExamStatus.SUBMITTED, submittedAt: now }
          : finishing ? { status: MockExamStatus.SUBMITTED, submittedAt: deadline, timedOut: true }
          : { updatedAt: now },
      });
      // Another tab submitted it between the read and the claim.
      if (claimed.count === 0) throw new Refused("already_submitted");
      if (cleaned.length) {
        const ids = cleaned.map(([id]) => id);
        // An empty answer is sent as '' and stored as NULL.
        const texts = cleaned.map(([, answer]) => answer);
        await tx.$executeRaw`
          UPDATE "MockExamQuestion" AS question
          SET "answer" = NULLIF(sent.answer, ''), "answeredAt" = CASE WHEN sent.answer = '' THEN NULL ELSE (${now}::timestamptz AT TIME ZONE 'UTC') END
          FROM unnest(${ids}::text[], ${texts}::text[]) AS sent(id, answer)
          WHERE question."id" = sent.id AND question."mockExamId" = ${mockExamId}
            AND question."answer" IS DISTINCT FROM NULLIF(sent.answer, '')`;
      }
      const answered = finishing ? await tx.mockExamQuestion.count({ where: { mockExamId, answer: { not: null } } }) : 0;
      return { late: false as const, finishing, answered, remainingMs: deadline ? timeLeftMs(deadline, now) : undefined };
    }, SAVE_TRANSACTION);
    if (outcome.late) {
      logError("mock_exam_late_save_refused", { userId, mockExamId: context.mockExamId, mode, lateBySeconds: String(outcome.lateBySeconds) });
      return { ok: false, error: "time_up" };
    }
    if (outcome.finishing) {
      logError("mock_exam_expired", { userId, mockExamId: context.mockExamId, trigger: "final_save", answeredCount: String(outcome.answered) });
      return { ok: true, submitted: true, timedOut: true, remainingMs: 0 };
    }
    logError(mode === "submit" ? "mock_exam_submitted" : "mock_exam_saved", context);
    return { ok: true, submitted: mode === "submit", ...(outcome.remainingMs !== undefined && { remainingMs: mode === "submit" ? 0 : outcome.remainingMs }) };
  } catch (error) {
    if (error instanceof Refused) {
      logError("mock_exam_save_refused", { ...context, reason: error.reason });
      return { ok: false, error: error.reason };
    }
    logError("mock_exam_save_failed", { ...context, errorType: errorType(error), errorCode: errorCode(error) });
    return { ok: false, error: "unexpected" };
  }
}
