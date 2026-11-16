import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const tx = {
    mockExam: { updateMany: vi.fn(), findFirst: vi.fn() },
    mockExamQuestion: { count: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
  };
  return {
    tx,
    course: { findUnique: vi.fn() },
    courseFile: { findMany: vi.fn() },
    question: { findMany: vi.fn() },
    learningTopic: { findMany: vi.fn() },
    mockExam: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>, options?: unknown) => { void options; return callback(tx); }),
  };
});
const consolidated = vi.hoisted(() => ({ getConsolidatedExam: vi.fn() }));
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/consolidated-exam", () => consolidated);
// Generated practice questions (US-44) are covered in mock-exam-generated.test.ts; here the student has none.
vi.mock("@/lib/practice-generation", () => ({ getGeneratedPracticeQuestions: vi.fn(async () => []) }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(), errorCode: (error: unknown) => (error as { code?: string } | null)?.code }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(() => ({ ok: true })), limitFromEnv: (_name: string, fallback: number) => fallback }));

import { logError } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { createMockExam, finalizeExpiredMockExams, getMockExam, getMockExamOptions, listMyMockExams, saveMockExam, startMockExam } from "@/lib/mock-exams";

const paper = (id: string, title: string) => ({ id, title, year: 2025, examType: null, term: null, professor: null });
const examQuestion = (index: number, paperId: string) => ({
  id: `g${index}`, position: index, rank: index, text: "x".repeat(index * 10), paperCount: 1, totalPapers: 2, papers: [paper(paperId, `Paper ${paperId}`)], tier: "HIGH",
});
const input = (over: Record<string, unknown> = {}) => ({ courseId: "course-1", length: "3", difficulty: "EASY", topics: [] as string[], ...over });

beforeEach(() => {
  vi.clearAllMocks();
  db.course.findUnique.mockResolvedValue({ id: "course-1" });
  db.courseFile.findMany.mockResolvedValue([{ id: "p1", topic: "Networking Basics" }, { id: "p2", topic: " databases " }]);
  consolidated.getConsolidatedExam.mockResolvedValue({ totalPapers: 2, questions: [1, 2, 3, 4].map(index => examQuestion(index, "p1")).concat([5, 6, 7, 8].map(index => examQuestion(index, "p2"))) });
  db.mockExam.create.mockResolvedValue({ id: "mock-1" });
  db.question.findMany.mockResolvedValue([]);
  db.learningTopic.findMany.mockResolvedValue([]);
  // No exam has run out of time, and the exam being saved is an untimed one in progress.
  db.$queryRaw.mockResolvedValue([]);
  db.tx.$queryRaw.mockResolvedValue([]);
  db.tx.mockExam.findFirst.mockResolvedValue(untimed);
  db.tx.mockExam.updateMany.mockResolvedValue({ count: 1 });
});
const untimed = { status: "IN_PROGRESS", timeLimitMinutes: null, startedAt: null, deadlineAt: null, timedOut: false };

describe("createMockExam (US-45)", () => {
  it("stores the settings and a copy of exactly the questions asked for", async () => {
    expect(await createMockExam("user-1", input({ topics: ["Databases"], difficulty: "HARD" }))).toEqual({ ok: true, id: "mock-1", difficultyApplied: true, length: 3 });
    const data = db.mockExam.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: "user-1", courseId: "course-1", length: 3, requestedLength: 3, difficulty: "HARD", topicKeys: ["databases"], topics: ["databases"] });
    expect(data.questions.create).toHaveLength(3);
    expect(data.questions.create.map((item: { position: number }) => item.position)).toEqual([1, 2, 3]);
    expect(data.questions.create.every((item: { topicKey: string; groupId: string; text: string; sourcePapers: string[] }) =>
      item.topicKey === "databases" && item.groupId.startsWith("g") && item.text.length > 0 && item.sourcePapers[0] === "Paper p2 (2025)")).toBe(true);
  });

  it("uses the topic's display name from the course, not what was typed", async () => {
    await createMockExam("user-1", input({ topics: ["  NETWORKING   basics "] }));
    expect(db.mockExam.create.mock.calls[0][0].data.topics).toEqual(["Networking Basics"]);
  });

  it("refuses bad settings before touching the database", async () => {
    expect(await createMockExam("user-1", input({ length: "1" }))).toMatchObject({ ok: false, error: "length_invalid" });
    expect(await createMockExam("user-1", input({ difficulty: "NOPE" }))).toMatchObject({ ok: false, error: "difficulty_invalid" });
    expect(db.course.findUnique).not.toHaveBeenCalled();
    expect(db.mockExam.create).not.toHaveBeenCalled();
  });

  it("makes the largest valid exam when the topics have too few questions, and keeps both lengths", async () => {
    expect(await createMockExam("user-1", input({ topics: ["databases"], length: "5" }))).toEqual({ ok: true, id: "mock-1", difficultyApplied: false, length: 4 });
    const data = db.mockExam.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ length: 4, requestedLength: 5, topicKeys: ["databases"], difficulty: "EASY" });
    expect(data.questions.create).toHaveLength(4);
    expect(logError).toHaveBeenCalledWith("mock_exam_created", expect.objectContaining({ length: "4", requestedLength: "5" }));
  });

  it("refuses an unknown topic, an unknown course, and a course without questions", async () => {
    expect(await createMockExam("user-1", input({ topics: ["quantum"] }))).toMatchObject({ ok: false, error: "topic_invalid" });
    db.course.findUnique.mockResolvedValueOnce(null);
    expect(await createMockExam("user-1", input())).toMatchObject({ ok: false, error: "course_not_found" });
    consolidated.getConsolidatedExam.mockResolvedValueOnce({ totalPapers: 0, questions: [] });
    expect(await createMockExam("user-1", input())).toMatchObject({ ok: false, error: "no_questions" });
    expect(db.mockExam.create).not.toHaveBeenCalled();
  });

  it("builds the exam only from the course it was asked for", async () => {
    await createMockExam("user-1", input());
    expect(consolidated.getConsolidatedExam).toHaveBeenCalledWith("course-1");
    expect(db.courseFile.findMany.mock.calls[0][0].where).toMatchObject({ courseId: "course-1" });
  });

  it("does not count a refused attempt towards the hourly limit", async () => {
    expect(await createMockExam("user-1", input({ topics: ["quantum"] }))).toMatchObject({ ok: false, error: "topic_invalid" });
    consolidated.getConsolidatedExam.mockResolvedValueOnce({ totalPapers: 0, questions: [] });
    expect(await createMockExam("user-1", input())).toMatchObject({ ok: false, error: "no_questions" });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(await createMockExam("user-1", input())).toMatchObject({ ok: true });
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(checkRateLimit).mock.calls[0][0]).toBe("mock-exam:user-1");
  });

  it("says when the difficulty could not choose between the questions", async () => {
    // Databases has four questions: an exam of four needs them all, whatever the difficulty.
    expect(await createMockExam("user-1", input({ topics: ["databases"], length: "4", difficulty: "EASY" }))).toMatchObject({ ok: true, difficultyApplied: false });
    expect(await createMockExam("user-1", input({ topics: ["databases"], length: "4", difficulty: "MIXED" }))).toMatchObject({ ok: true, difficultyApplied: true });
    expect(await createMockExam("user-1", input({ topics: ["databases"], length: "3", difficulty: "EASY" }))).toMatchObject({ ok: true, difficultyApplied: true });
  });

  it("stops a student who generates too much", async () => {
    vi.mocked(checkRateLimit).mockReturnValueOnce({ ok: false, retryAfterSeconds: 30 } as ReturnType<typeof checkRateLimit>);
    expect(await createMockExam("user-1", input())).toEqual({ ok: false, error: "rate_limited" });
    expect(db.mockExam.create).not.toHaveBeenCalled();
  });

  it("reports an unexpected failure without saving", async () => {
    db.mockExam.create.mockRejectedValueOnce(new Error("boom"));
    expect(await createMockExam("user-1", input())).toEqual({ ok: false, error: "unexpected" });
  });
});

describe("createMockExam weighting (US-47)", () => {
  const profileRow = (topicKey: string, weakness: number) => ({ topicKey, topic: topicKey, weakness, confidence: null, baselineWeakness: null, correctCount: 0, incorrectCount: 0 });
  const topicsOf = () => (db.mockExam.create.mock.calls.at(-1)![0].data.questions.create as Array<{ topicKey: string }>).map(item => item.topicKey).sort();

  it("reads the profile of this student in this course only", async () => {
    await createMockExam("user-1", input());
    expect(db.learningTopic.findMany.mock.calls[0][0].where).toEqual({ userId: "user-1", courseId: "course-1" });
  });

  it("weights the mix toward the student's weaker topic and stores why", async () => {
    db.learningTopic.findMany.mockResolvedValue([profileRow("networking basics", 0.9)]);
    await createMockExam("user-1", input());
    expect(topicsOf()).toEqual(["databases", "networking basics", "networking basics"]);
    expect(db.mockExam.create.mock.calls[0][0].data).toMatchObject({ mixBasis: "PROFILE", weakTopics: ["Networking Basics"] });
    expect(logError).toHaveBeenCalledWith("mock_exam_created", expect.objectContaining({ mixBasis: "PROFILE", weakTopicCount: "1" }));
  });

  it("follows exam frequency only without a profile, and names no weak topic", async () => {
    await createMockExam("user-1", input());
    expect(topicsOf()).toEqual(["databases", "databases", "networking basics"]);
    expect(db.mockExam.create.mock.calls[0][0].data).toMatchObject({ mixBasis: "NO_PROFILE", weakTopics: [] });
  });

  it("still makes the exam by frequency when the profile cannot be read, and logs the failure without text", async () => {
    db.learningTopic.findMany.mockRejectedValue(Object.assign(new TypeError("Secret detail"), {}));
    expect(await createMockExam("user-1", input())).toMatchObject({ ok: true });
    expect(topicsOf()).toEqual(["databases", "databases", "networking basics"]);
    expect(db.mockExam.create.mock.calls[0][0].data).toMatchObject({ mixBasis: "PROFILE_UNAVAILABLE", weakTopics: [] });
    expect(logError).toHaveBeenCalledWith("mock_exam_weighting_failed", { userId: "user-1", courseId: "course-1", step: "profile", errorType: "TypeError" });
  });

  it("logs invalid weight inputs once per exam, with counts and reason codes only", async () => {
    db.learningTopic.findMany.mockResolvedValue([profileRow("networking basics", 7), profileRow("databases", Number.NaN)]);
    expect(await createMockExam("user-1", input())).toMatchObject({ ok: true });
    const lines = vi.mocked(logError).mock.calls.filter(([event]) => event === "mock_exam_weighting_invalid_inputs");
    expect(lines).toEqual([["mock_exam_weighting_invalid_inputs", { userId: "user-1", courseId: "course-1", mockExamId: "mock-1", affectedTopics: "2", reasons: "invalid_weakness" }]]);
    expect(JSON.stringify(vi.mocked(logError).mock.calls)).not.toMatch(/networking|databases|xxxx/i);
  });
});

describe("getMockExamOptions", () => {
  it("counts the questions of each topic", async () => {
    expect(await getMockExamOptions("course-1")).toEqual({
      total: 8, topics: [{ key: "databases", label: "databases", count: 4 }, { key: "networking basics", label: "Networking Basics", count: 4 }], generated: 0,
    });
  });
});

describe("getMockExam", () => {
  it("only reads an exam of the student asking", async () => {
    db.mockExam.findFirst.mockResolvedValue(null);
    expect(await getMockExam("user-2", "mock-1")).toBeNull();
    expect(db.mockExam.findFirst.mock.calls[0][0].where).toEqual({ id: "mock-1", userId: "user-2" });
  });
});

// The one statement that writes the answers: its SQL text, and its values in order (now, IDs, answers, exam ID).
const written = () => {
  const [strings, ...values] = db.tx.$executeRaw.mock.calls[0] as [string[], ...unknown[]];
  return { sql: strings.join("?"), values };
};

describe("saveMockExam (the sitting flow)", () => {
  it("writes every answer in one statement, tidied, for this exam's questions only", async () => {
    db.tx.mockExam.updateMany.mockResolvedValue({ count: 1 });
    expect(await saveMockExam("user-1", "mock-1", { q1: "  my answer \r\n", q2: "   ", other: "not mine" }, false)).toEqual({ ok: true, submitted: false });
    expect(db.tx.mockExam.updateMany.mock.calls[0][0].where).toMatchObject({ id: "mock-1", userId: "user-1", status: "IN_PROGRESS" });
    expect(db.tx.$executeRaw).toHaveBeenCalledTimes(1);
    const { sql, values } = written();
    expect(values).toEqual([expect.any(Date), ["q1", "q2", "other"], ["my answer", "", "not mine"], "mock-1"]);
    // An ID of another exam's question matches no row, an empty answer is stored as NULL, and an unchanged one is not rewritten.
    expect(sql).toContain('question."mockExamId" = ?');
    expect(sql).toContain("NULLIF(sent.answer, '')");
    expect(sql).toContain("IS DISTINCT FROM");
  });

  it("gives the transaction time on a remote database", async () => {
    db.tx.mockExam.updateMany.mockResolvedValue({ count: 1 });
    await saveMockExam("user-1", "mock-1", { q1: "a" }, false);
    expect(db.$transaction.mock.calls[0][1]).toEqual({ maxWait: 10_000, timeout: 20_000 });
  });

  it("counts a line break once, as the browser's limit does", async () => {
    db.tx.mockExam.updateMany.mockResolvedValue({ count: 1 });
    // 2500 lines of one character: 4999 characters as typed, 7498 as a browser posts them.
    const posted = Array.from({ length: 2500 }, () => "x").join("\r\n");
    expect(posted.length).toBeGreaterThan(5000);
    expect(await saveMockExam("user-1", "mock-1", { q1: posted }, false)).toEqual({ ok: true, submitted: false });
    expect((written().values[2] as string[])[0]).toHaveLength(4999);
  });

  it("submits by moving the exam to SUBMITTED in the same transaction", async () => {
    db.tx.mockExam.updateMany.mockResolvedValue({ count: 1 });
    expect(await saveMockExam("user-1", "mock-1", { q1: "final" }, true)).toEqual({ ok: true, submitted: true });
    expect(db.tx.mockExam.updateMany.mock.calls[0][0].data).toMatchObject({ status: "SUBMITTED" });
    expect(db.tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("submits without answers without writing any", async () => {
    db.tx.mockExam.updateMany.mockResolvedValue({ count: 1 });
    expect(await saveMockExam("user-1", "mock-1", {}, true)).toEqual({ ok: true, submitted: true });
    expect(db.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("refuses to change an exam that was already submitted", async () => {
    db.tx.mockExam.findFirst.mockResolvedValue({ ...untimed, status: "SUBMITTED" });
    expect(await saveMockExam("user-1", "mock-1", { q1: "late" }, false)).toEqual({ ok: false, error: "already_submitted" });
    expect(db.tx.mockExam.updateMany).not.toHaveBeenCalled();
    expect(db.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("refuses when another tab submitted the exam between the read and the claim", async () => {
    db.tx.mockExam.updateMany.mockResolvedValue({ count: 0 });
    expect(await saveMockExam("user-1", "mock-1", { q1: "late" }, true)).toEqual({ ok: false, error: "already_submitted" });
    expect(db.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("says not found for an exam that is not the student's", async () => {
    db.tx.mockExam.findFirst.mockResolvedValue(null);
    expect(await saveMockExam("user-2", "mock-1", {}, true)).toEqual({ ok: false, error: "not_found" });
    expect(db.tx.mockExam.findFirst.mock.calls[0][0].where).toEqual({ id: "mock-1", userId: "user-2" });
  });

  it("refuses an answer that is too long without starting a transaction", async () => {
    expect(await saveMockExam("user-1", "mock-1", { q1: "x".repeat(5001) }, false)).toEqual({ ok: false, error: "answer_too_long" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

// US-48. The clock is a fake one: the service reads the server's time, and these tests set it.
describe("timed mock exams (US-48)", () => {
  const start = new Date("2026-11-16T10:00:00.000Z");
  const deadline = new Date("2026-11-16T10:30:00.000Z");
  const timed = { status: "IN_PROGRESS", timeLimitMinutes: 30, startedAt: start, deadlineAt: deadline, timedOut: false };
  const clock = (msAfterDeadline: number) => vi.setSystemTime(new Date(deadline.getTime() + msAfterDeadline));
  const logged = (event: string) => vi.mocked(logError).mock.calls.filter(([name]) => name === event).map(([, context]) => context);
  // A tagged-template call: its SQL text and its values (nested fragments flattened to their own values).
  const sqlOf = (call: unknown[]) => {
    const [strings, ...values] = call as [string[], ...unknown[]];
    const flat = (value: unknown): unknown[] => (value && typeof value === "object" && "values" in value && "strings" in value
      ? [(value as { strings: string[] }).strings.join("?"), ...(value as { values: unknown[] }).values.flatMap(flat)] : [value]);
    return { sql: strings.join("?"), values: values.flatMap(flat) };
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock(-20 * 60_000);
    db.tx.mockExam.findFirst.mockResolvedValue(timed);
  });
  afterEach(() => { vi.useRealTimers(); });

  describe("creating", () => {
    it("stores the time limit, and no start or deadline: the clock starts with Start", async () => {
      expect(await createMockExam("user-1", input({ timeLimit: "30" }))).toMatchObject({ ok: true });
      const data = db.mockExam.create.mock.calls[0][0].data;
      expect(data.timeLimitMinutes).toBe(30);
      expect(data).not.toHaveProperty("startedAt");
      expect(data).not.toHaveProperty("deadlineAt");
      expect(logged("mock_exam_created")[0]).toMatchObject({ timeLimitMinutes: "30" });
    });

    it("is untimed unless a limit is chosen, and refuses a limit that is not offered", async () => {
      await createMockExam("user-1", input());
      expect(db.mockExam.create.mock.calls[0][0].data.timeLimitMinutes).toBeNull();
      expect(logged("mock_exam_created")[0]).not.toHaveProperty("timeLimitMinutes");
      expect(await createMockExam("user-1", input({ timeLimit: "7" }))).toEqual({ ok: false, error: "time_limit_invalid" });
      expect(db.mockExam.create).toHaveBeenCalledTimes(1);
    });

    it("gives a timed exam exactly the questions and the mix of an untimed one", async () => {
      db.learningTopic.findMany.mockResolvedValue([{ topicKey: "networking basics", topic: "Networking Basics", weakness: 0.9, confidence: null, baselineWeakness: null, correctCount: 0, incorrectCount: 0 }]);
      await createMockExam("user-1", input({ length: "5" }));
      await createMockExam("user-1", input({ length: "5", timeLimit: "45" }));
      const [plain, timedExam] = db.mockExam.create.mock.calls.map(call => call[0].data);
      expect(timedExam.questions).toEqual(plain.questions);
      expect(timedExam).toMatchObject({ mixBasis: plain.mixBasis, weakTopics: plain.weakTopics, length: plain.length });
    });
  });

  describe("starting", () => {
    it("sets the start and the deadline from the server's clock, once", async () => {
      db.$queryRaw.mockResolvedValue([{ courseId: "course-1", timeLimitMinutes: 30, length: 5 }]);
      clock(-30 * 60_000);
      expect(await startMockExam("user-1", "mock-1")).toEqual({ ok: true, started: true });
      const { sql, values } = sqlOf(db.$queryRaw.mock.calls[0]);
      expect(values).toEqual([start, start, start, "mock-1", "user-1"]);
      expect(sql).toContain(`exam."timeLimitMinutes" * interval '1 minute'`);
      // Only its student's, only a timed exam in progress, and only when it has no start yet.
      expect(sql).toContain('exam."userId" = ?');
      expect(sql).toContain('exam."timeLimitMinutes" IS NOT NULL AND exam."startedAt" IS NULL');
      expect(sql).toContain(`exam."status" = 'IN_PROGRESS'`);
      expect(logged("mock_exam_timer_started")).toEqual([{ userId: "user-1", mockExamId: "mock-1", courseId: "course-1", timeLimitMinutes: "30", questionCount: "5" }]);
    });

    it("changes nothing when it was already started, and is not found for another student's exam", async () => {
      db.mockExam.findFirst.mockResolvedValue({ id: "mock-1" });
      expect(await startMockExam("user-1", "mock-1")).toEqual({ ok: true, started: false });
      expect(logged("mock_exam_timer_started")).toEqual([]);
      db.mockExam.findFirst.mockResolvedValue(null);
      expect(await startMockExam("user-2", "mock-1")).toEqual({ ok: false, error: "not_found" });
      expect(db.mockExam.findFirst.mock.calls.at(-1)![0].where).toEqual({ id: "mock-1", userId: "user-2" });
    });

    it("reports a failure without throwing", async () => {
      db.$queryRaw.mockRejectedValue(new Error("down"));
      expect(await startMockExam("user-1", "mock-1")).toEqual({ ok: false, error: "unexpected" });
    });
  });

  describe("saving", () => {
    it("saves before the deadline and returns the server's time left", async () => {
      expect(await saveMockExam("user-1", "mock-1", { q1: "an answer" }, "save")).toEqual({ ok: true, submitted: false, remainingMs: 20 * 60_000 });
      // The claim repeats the deadline, so a save racing it cannot slip through.
      expect(db.tx.mockExam.updateMany.mock.calls[0][0].where).toEqual({
        id: "mock-1", userId: "user-1", status: "IN_PROGRESS", deadlineAt: { gte: new Date(deadline.getTime() - 20 * 60_000 - 5_000) },
      });
      expect(db.tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it("still accepts a save five seconds after the deadline (the grace)", async () => {
      clock(5_000);
      expect(await saveMockExam("user-1", "mock-1", { q1: "just in time" }, "save")).toEqual({ ok: true, submitted: false, remainingMs: 0 });
      expect(db.tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it("refuses a save after the grace, keeps nothing of it, and submits the exam with the answers saved before", async () => {
      clock(5_001);
      db.tx.$queryRaw.mockResolvedValue([{ id: "mock-1", userId: "user-1", answered: 2 }]);
      expect(await saveMockExam("user-1", "mock-1", { q1: "Secret late answer" }, "save")).toEqual({ ok: false, error: "time_up" });
      expect(db.tx.$executeRaw).not.toHaveBeenCalled();
      expect(db.tx.mockExam.updateMany).not.toHaveBeenCalled();
      // Finalized inside the same transaction.
      const { sql, values } = sqlOf(db.tx.$queryRaw.mock.calls[0]);
      expect(sql).toContain(`"status" = 'SUBMITTED'`);
      expect(sql).toContain('"timedOut" = true, "submittedAt" = exam."deadlineAt"');
      expect(values).toContain("mock-1");
      expect(logged("mock_exam_late_save_refused")).toEqual([{ userId: "user-1", mockExamId: "mock-1", mode: "save", lateBySeconds: "5" }]);
      expect(logged("mock_exam_expired")).toEqual([{ userId: "user-1", mockExamId: "mock-1", trigger: "late_save", answeredCount: "2" }]);
      expect(JSON.stringify(vi.mocked(logError).mock.calls)).not.toMatch(/secret/i);
    });

    it("refuses a late submit and a late final save the same way", async () => {
      clock(60_000);
      expect(await saveMockExam("user-1", "mock-1", { q1: "late" }, "submit")).toEqual({ ok: false, error: "time_up" });
      expect(await saveMockExam("user-1", "mock-1", { q1: "late" }, "finish")).toEqual({ ok: false, error: "time_up" });
      expect(db.tx.$executeRaw).not.toHaveBeenCalled();
      expect(logged("mock_exam_late_save_refused").map(line => line?.mode)).toEqual(["submit", "finish"]);
    });

    it("says time is up for an exam that already ran out", async () => {
      db.tx.mockExam.findFirst.mockResolvedValue({ ...timed, status: "SUBMITTED", timedOut: true });
      expect(await saveMockExam("user-1", "mock-1", { q1: "late" }, "save")).toEqual({ ok: false, error: "time_up" });
      expect(db.tx.$executeRaw).not.toHaveBeenCalled();
    });

    it("refuses a save before Start was pressed", async () => {
      db.tx.mockExam.findFirst.mockResolvedValue({ ...timed, startedAt: null, deadlineAt: null });
      expect(await saveMockExam("user-1", "mock-1", { q1: "early" }, "save")).toEqual({ ok: false, error: "not_started" });
      expect(await saveMockExam("user-1", "mock-1", {}, "submit")).toEqual({ ok: false, error: "not_started" });
      expect(db.tx.mockExam.updateMany).not.toHaveBeenCalled();
    });

    it("lets the student submit early, as a normal submit", async () => {
      expect(await saveMockExam("user-1", "mock-1", { q1: "done" }, "submit")).toEqual({ ok: true, submitted: true, remainingMs: 0 });
      const data = db.tx.mockExam.updateMany.mock.calls[0][0].data;
      expect(data).toEqual({ status: "SUBMITTED", submittedAt: new Date(deadline.getTime() - 20 * 60_000) });
      expect(logged("mock_exam_expired")).toEqual([]);
    });
  });

  describe("the final save at zero", () => {
    it("saves the answers and submits the exam as timed out, at the deadline", async () => {
      clock(-1_000);
      db.tx.mockExamQuestion.count.mockResolvedValue(3);
      expect(await saveMockExam("user-1", "mock-1", { q1: "Secret last words" }, "finish")).toEqual({ ok: true, submitted: true, timedOut: true, remainingMs: 0 });
      expect(db.tx.mockExam.updateMany.mock.calls[0][0].data).toEqual({ status: "SUBMITTED", submittedAt: deadline, timedOut: true });
      expect(db.tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(logged("mock_exam_expired")).toEqual([{ userId: "user-1", mockExamId: "mock-1", trigger: "final_save", answeredCount: "3" }]);
      expect(logged("mock_exam_submitted")).toEqual([]);
      expect(JSON.stringify(vi.mocked(logError).mock.calls)).not.toMatch(/secret/i);
    });

    it("works inside the grace too", async () => {
      clock(4_000);
      expect(await saveMockExam("user-1", "mock-1", { q1: "x" }, "finish")).toMatchObject({ ok: true, timedOut: true });
    });

    it("is only a save when the server says there is time left, so a fast browser clock cannot end the exam", async () => {
      clock(-10_000);
      expect(await saveMockExam("user-1", "mock-1", { q1: "x" }, "finish")).toEqual({ ok: true, submitted: false, remainingMs: 10_000 });
      expect(db.tx.mockExam.updateMany.mock.calls[0][0].data).not.toHaveProperty("status");
    });

    it("is only a save on an untimed exam", async () => {
      db.tx.mockExam.findFirst.mockResolvedValue(untimed);
      expect(await saveMockExam("user-1", "mock-1", { q1: "x" }, "finish")).toEqual({ ok: true, submitted: false });
      expect(db.tx.mockExam.updateMany.mock.calls[0][0].where).toEqual({ id: "mock-1", userId: "user-1", status: "IN_PROGRESS" });
    });
  });

  describe("finalizing an exam whose student never came back", () => {
    it("submits every expired exam of the filter in one statement, at its deadline, and logs each once", async () => {
      clock(60_000);
      db.$queryRaw.mockResolvedValue([{ id: "mock-1", userId: "user-1", answered: 4 }, { id: "mock-2", userId: "user-1", answered: 0 }]);
      expect(await finalizeExpiredMockExams({ userId: "user-1", courseId: "course-1" })).toEqual(["mock-1", "mock-2"]);
      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
      const { sql, values } = sqlOf(db.$queryRaw.mock.calls[0]);
      expect(sql).toContain(`exam."status" = 'IN_PROGRESS'`);
      expect(sql).toContain('exam."deadlineAt" < ?');
      expect(sql).toContain('"submittedAt" = exam."deadlineAt"');
      // Only deadlines older than the grace: now minus five seconds.
      expect(values).toContainEqual(new Date(deadline.getTime() + 55_000));
      expect(values).toEqual(expect.arrayContaining(["user-1", "course-1"]));
      expect(logged("mock_exam_expired")).toEqual([
        { userId: "user-1", mockExamId: "mock-1", trigger: "read", answeredCount: "4" }, { userId: "user-1", mockExamId: "mock-2", trigger: "read", answeredCount: "0" },
      ]);
    });

    it("does nothing without a filter", async () => {
      expect(await finalizeExpiredMockExams({})).toEqual([]);
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it("runs before an exam or the list is read", async () => {
      db.mockExam.findFirst.mockResolvedValue(null);
      db.mockExam.findMany.mockResolvedValue([]);
      await getMockExam("user-1", "mock-1");
      expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.mockExam.findFirst.mock.invocationCallOrder[0]);
      expect(sqlOf(db.$queryRaw.mock.calls[0]).values).toEqual(expect.arrayContaining(["user-1", "mock-1"]));
      await listMyMockExams("user-1", "course-1");
      expect(db.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(db.mockExam.findMany.mock.invocationCallOrder[0]);
      expect(sqlOf(db.$queryRaw.mock.calls[1]).values).toEqual(expect.arrayContaining(["user-1", "course-1"]));
    });
  });

  describe("reading", () => {
    const question = { id: "q1", position: 1, topic: "TCP", text: "Secret question text", paperCount: 1, totalPapers: 2, sourcePapers: [], answer: null };
    const stored = (over: Record<string, unknown> = {}) => ({ id: "mock-1", courseId: "course-1", length: 1, ...timed, questions: [question], ...over });

    it("leaves the questions of a timed exam out until it is started", async () => {
      db.mockExam.findFirst.mockResolvedValue(stored({ startedAt: null, deadlineAt: null }));
      const exam = (await getMockExam("user-1", "mock-1"))!;
      expect(exam).toMatchObject({ locked: true, questions: [], remainingMs: null, length: 1 });
      expect(JSON.stringify(exam)).not.toContain("Secret question text");
    });

    it("gives the questions and the server's time left once it runs", async () => {
      db.mockExam.findFirst.mockResolvedValue(stored());
      expect(await getMockExam("user-1", "mock-1")).toMatchObject({ locked: false, questions: [question], remainingMs: 20 * 60_000 });
      clock(10_000);
      expect((await getMockExam("user-1", "mock-1"))!.remainingMs).toBe(0);
    });

    it("gives no time left for a submitted or an untimed exam, and never locks them", async () => {
      db.mockExam.findFirst.mockResolvedValue(stored({ status: "SUBMITTED", timedOut: true }));
      expect(await getMockExam("user-1", "mock-1")).toMatchObject({ locked: false, questions: [question], remainingMs: null });
      db.mockExam.findFirst.mockResolvedValue(stored({ ...untimed }));
      expect(await getMockExam("user-1", "mock-1")).toMatchObject({ locked: false, questions: [question], remainingMs: null });
    });
  });
});
