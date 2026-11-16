import { beforeEach, describe, expect, it, vi } from "vitest";

// The marking service (US-49) with the database mocked: what is marked against what, the learning events and their
// one-by-one fallback, idempotence, the answer-key limit, and that nothing typed is logged.

const { db, tx, recordLearningEvents } = vi.hoisted(() => {
  const tx = { mockExam: { updateMany: vi.fn() }, $executeRaw: vi.fn() };
  return {
    tx,
    db: {
      mockExam: { findFirst: vi.fn() },
      answerKey: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
      questionGroup: { findFirst: vi.fn() },
      $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
    },
    recordLearningEvents: vi.fn(),
  };
});
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/learning-evidence", () => ({ recordLearningEvents }));
import { markMockExam, mockEventId, saveAnswerKey } from "@/lib/mock-marking";
import { resetRateLimits } from "@/lib/rate-limit";

let errors: ReturnType<typeof vi.spyOn>;
const logged = () => [...errors.mock.calls, ...(console.log as unknown as ReturnType<typeof vi.fn>).mock.calls, ...(console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls]
  .flatMap(call => { try { return [JSON.parse(String(call[0]))]; } catch { return []; } });
const question = (position: number, over: Record<string, unknown> = {}) => ({
  id: `mq-${position}`, position, groupId: `group-${position}`, questionId: `q-${position}`, generatedQuestionId: null, answer: "secret answer text", ...over,
});
const exam = (over: Record<string, unknown> = {}) => ({
  id: "mock-1", courseId: "course-a", status: "SUBMITTED", markedAt: null, questions: [question(1), question(2), question(3, { groupId: null })], ...over,
});

beforeEach(() => {
  resetRateLimits();
  delete process.env.ANSWER_KEY_RATE_LIMIT_PER_MINUTE;
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  db.mockExam.findFirst.mockReset().mockResolvedValue(exam());
  db.answerKey.findMany.mockReset().mockResolvedValue([
    { groupId: "group-1", keyPoints: ["secret answer"], explanation: "secret explanation" },
    { groupId: "group-2", keyPoints: ["something else entirely"], explanation: "" },
  ]);
  db.answerKey.upsert.mockReset().mockResolvedValue({});
  db.answerKey.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  db.questionGroup.findFirst.mockReset().mockResolvedValue({ id: "group-1" });
  tx.mockExam.updateMany.mockReset().mockResolvedValue({ count: 1 });
  tx.$executeRaw.mockReset().mockResolvedValue(3);
  recordLearningEvents.mockReset().mockResolvedValue({ ok: true, recorded: 2, duplicates: 0 });
});

describe("markMockExam", () => {
  it("marks against the keys of this course's groups, claims the exam once, and records events for keyed questions only", async () => {
    const result = await markMockExam("student-1", "mock-1");
    expect(result).toEqual({ ok: true, marked: true, counts: { CORRECT: 1, PARTIAL: 0, INCORRECT: 1, UNANSWERED: 0, NO_KEY: 1 }, eventsRecorded: 2, eventsSkipped: 0 });
    expect(db.mockExam.findFirst.mock.calls[0][0].where).toEqual({ id: "mock-1", userId: "student-1" });
    expect(db.answerKey.findMany.mock.calls[0][0].where).toEqual({ groupId: { in: ["group-1", "group-2"] }, courseId: "course-a" });
    expect(tx.mockExam.updateMany.mock.calls[0][0].where).toEqual({ id: "mock-1", userId: "student-1", status: "SUBMITTED", markedAt: null });
    expect(recordLearningEvents).toHaveBeenCalledWith("student-1", "course-a", [
      { source: "MOCK_EXAM", eventId: mockEventId("mock-1", 1), questionId: "q-1", correct: true },
      { source: "MOCK_EXAM", eventId: mockEventId("mock-1", 2), questionId: "q-2", correct: false },
    ]);
  });

  it("never uses a key for a generated question", async () => {
    db.mockExam.findFirst.mockResolvedValue(exam({ questions: [question(1, { generatedQuestionId: "gen-1", questionId: null })] }));
    const result = await markMockExam("student-1", "mock-1");
    expect(result).toMatchObject({ ok: true, counts: { NO_KEY: 1 } });
    expect(db.answerKey.findMany).not.toHaveBeenCalled();
    expect(recordLearningEvents).not.toHaveBeenCalled();
  });

  it("refuses an exam that is not the student's or not submitted, and leaves a marked exam alone", async () => {
    db.mockExam.findFirst.mockResolvedValueOnce(null);
    expect(await markMockExam("student-2", "mock-1")).toEqual({ ok: false, error: "not_found" });
    db.mockExam.findFirst.mockResolvedValueOnce(exam({ status: "IN_PROGRESS" }));
    expect(await markMockExam("student-1", "mock-1")).toEqual({ ok: false, error: "not_submitted" });
    db.mockExam.findFirst.mockResolvedValueOnce(exam({ markedAt: new Date() }));
    expect(await markMockExam("student-1", "mock-1")).toMatchObject({ ok: true, marked: false });
    expect(tx.mockExam.updateMany).not.toHaveBeenCalled();
  });

  it("delivers no events when another request claimed the exam first", async () => {
    tx.mockExam.updateMany.mockResolvedValue({ count: 0 });
    expect(await markMockExam("student-1", "mock-1")).toMatchObject({ ok: true, marked: false });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(recordLearningEvents).not.toHaveBeenCalled();
  });

  it("falls back to one event at a time when a source is no longer published, skipping only that one", async () => {
    recordLearningEvents
      .mockResolvedValueOnce({ ok: false, error: "not_found" })
      .mockResolvedValueOnce({ ok: true, recorded: 1, duplicates: 0 })
      .mockResolvedValueOnce({ ok: false, error: "not_found" });
    expect(await markMockExam("student-1", "mock-1")).toMatchObject({ ok: true, marked: true, eventsRecorded: 1, eventsSkipped: 1 });
    expect(recordLearningEvents).toHaveBeenCalledTimes(3);
  });

  it("keeps the marking when the events cannot be delivered, and logs it", async () => {
    recordLearningEvents.mockRejectedValue(new Error("down"));
    expect(await markMockExam("student-1", "mock-1")).toMatchObject({ ok: true, marked: true, eventsRecorded: 0, eventsSkipped: 2 });
    expect(logged().some(entry => entry.event === "mock_exam_marking_evidence_failed")).toBe(true);
  });

  it("logs counts only, never an answer, a key point, or an explanation", async () => {
    await markMockExam("student-1", "mock-1");
    const text = JSON.stringify(logged());
    expect(text).toContain("mock_exam_marked");
    expect(text).not.toMatch(/secret/);
  });

  it("returns unexpected, with the error type logged, when the database fails", async () => {
    db.mockExam.findFirst.mockRejectedValue(new TypeError("secret boom"));
    expect(await markMockExam("student-1", "mock-1")).toEqual({ ok: false, error: "unexpected" });
    const entry = logged().find(item => item.event === "mock_exam_marking_failed");
    expect(entry).toMatchObject({ errorType: "TypeError" });
    expect(JSON.stringify(logged())).not.toContain("secret boom");
  });
});

describe("saveAnswerKey", () => {
  const input = { courseId: "course-a", groupId: "group-1", keyPoints: "SYN, SYN-ACK, ACK\nsecret point", explanation: "secret why" };

  it("saves the parsed key for a group of the course, by the session admin", async () => {
    expect(await saveAnswerKey("admin-1", input)).toEqual({ ok: true, removed: false });
    expect(db.questionGroup.findFirst.mock.calls[0][0].where).toEqual({ id: "group-1", courseId: "course-a" });
    expect(db.answerKey.upsert.mock.calls[0][0]).toMatchObject({
      where: { groupId: "group-1" },
      create: { groupId: "group-1", courseId: "course-a", keyPoints: ["SYN, SYN-ACK, ACK", "secret point"], explanation: "secret why", updatedById: "admin-1" },
    });
    expect(JSON.stringify(logged())).not.toMatch(/secret/);
  });

  it("removes a key without checking its text", async () => {
    expect(await saveAnswerKey("admin-1", { ...input, keyPoints: "", remove: true })).toEqual({ ok: true, removed: true });
    expect(db.answerKey.deleteMany).toHaveBeenCalledWith({ where: { groupId: "group-1" } });
  });

  it("refuses a group of another course and an invalid key, writing nothing", async () => {
    db.questionGroup.findFirst.mockResolvedValueOnce(null);
    expect(await saveAnswerKey("admin-1", input)).toEqual({ ok: false, error: "not_found" });
    expect(await saveAnswerKey("admin-1", { ...input, keyPoints: "  " })).toEqual({ ok: false, error: "points_required" });
    expect(db.answerKey.upsert).not.toHaveBeenCalled();
  });

  it("stops an admin over the limit before touching the database", async () => {
    process.env.ANSWER_KEY_RATE_LIMIT_PER_MINUTE = "1";
    await saveAnswerKey("admin-1", input);
    db.questionGroup.findFirst.mockClear();
    expect(await saveAnswerKey("admin-1", input)).toEqual({ ok: false, error: "rate_limited" });
    expect(db.questionGroup.findFirst).not.toHaveBeenCalled();
  });
});
