import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const tx = {
    mockExam: { updateMany: vi.fn(), findFirst: vi.fn() },
    $executeRaw: vi.fn(),
  };
  return {
    tx,
    course: { findUnique: vi.fn() },
    courseFile: { findMany: vi.fn() },
    question: { findMany: vi.fn() },
    learningTopic: { findMany: vi.fn() },
    mockExam: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
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
import { createMockExam, getMockExam, getMockExamOptions, saveMockExam } from "@/lib/mock-exams";

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
});

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
    db.tx.mockExam.updateMany.mockResolvedValue({ count: 0 });
    db.tx.mockExam.findFirst.mockResolvedValue({ id: "mock-1" });
    expect(await saveMockExam("user-1", "mock-1", { q1: "late" }, false)).toEqual({ ok: false, error: "already_submitted" });
    expect(db.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("says not found for an exam that is not the student's", async () => {
    db.tx.mockExam.updateMany.mockResolvedValue({ count: 0 });
    db.tx.mockExam.findFirst.mockResolvedValue(null);
    expect(await saveMockExam("user-2", "mock-1", {}, true)).toEqual({ ok: false, error: "not_found" });
  });

  it("refuses an answer that is too long without starting a transaction", async () => {
    expect(await saveMockExam("user-1", "mock-1", { q1: "x".repeat(5001) }, false)).toEqual({ ok: false, error: "answer_too_long" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
