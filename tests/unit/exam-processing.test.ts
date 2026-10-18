import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  file: { findUnique: vi.fn(), findMany: vi.fn() },
  run: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
  countQuestions: vi.fn(), deleteQuestions: vi.fn(), createQuestions: vi.fn(), transaction: vi.fn(),
  getOriginalFile: vi.fn(), extract: vi.fn(), rebuild: vi.fn(), log: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {
  courseFile: mocks.file, fileProcessingRun: mocks.run,
  question: { count: mocks.countQuestions }, $transaction: mocks.transaction,
} }));
vi.mock("@/lib/files", () => ({ getOriginalFile: mocks.getOriginalFile, FileUnavailableError: class FileUnavailableError extends Error {} }));
vi.mock("@/lib/exam-extraction", () => ({
  extractExamQuestions: mocks.extract,
  ExtractionError: class ExtractionError extends Error { constructor(public reason: string) { super(reason); } },
}));
vi.mock("@/lib/question-bank", () => ({ rebuildQuestionBank: mocks.rebuild }));
vi.mock("@/lib/logger", () => ({ logError: mocks.log }));
import { ExtractionError } from "@/lib/exam-extraction";
import { FileUnavailableError } from "@/lib/files";
import { canRetryRun, processExamFile, retryFailedExam } from "@/lib/exam-processing";

beforeEach(() => {
  for (const mock of [mocks.file.findUnique, mocks.file.findMany, mocks.run.create, mocks.run.update, mocks.run.findFirst,
    mocks.countQuestions, mocks.deleteQuestions, mocks.createQuestions, mocks.transaction, mocks.getOriginalFile, mocks.extract, mocks.rebuild, mocks.log]) mock.mockReset();
  mocks.file.findUnique.mockResolvedValue({ id: "file-a", courseId: "course-a", category: "EXAM", status: "PUBLISHED", mimeType: "application/pdf" });
  mocks.run.create.mockResolvedValue({ id: "run-a" });
  mocks.run.update.mockResolvedValue({});
  mocks.getOriginalFile.mockResolvedValue({ bytes: new Uint8Array([1]) });
  mocks.extract.mockResolvedValue(["1. First question?", "2. Second question?"]);
  mocks.countQuestions.mockResolvedValue(0);
  mocks.rebuild.mockResolvedValue({ ok: true });
  mocks.transaction.mockImplementation((work: (tx: object) => unknown) => work({ question: { deleteMany: mocks.deleteQuestions, createMany: mocks.createQuestions } }));
});

describe("exam processing and retry", () => {
  it("stores extracted questions, groups them, and records success", async () => {
    expect(await processExamFile("file-a")).toEqual({ ok: true, runId: "run-a", questionCount: 2 });
    expect(mocks.createQuestions).toHaveBeenCalledWith({ data: [
      { fileId: "file-a", number: 1, text: "1. First question?" },
      { fileId: "file-a", number: 2, text: "2. Second question?" },
    ] });
    expect(mocks.rebuild).toHaveBeenCalledWith("course-a");
    expect(mocks.run.update).toHaveBeenLastCalledWith({ where: { id: "run-a" }, data: { status: "SUCCEEDED" } });
  });

  it("records the extraction stage and reason for an image-only PDF", async () => {
    mocks.extract.mockRejectedValue(new ExtractionError("no_text"));
    expect(await processExamFile("file-a")).toMatchObject({ ok: false, reason: "no_text" });
    expect(mocks.run.update).toHaveBeenCalledWith({ where: { id: "run-a" }, data: { status: "FAILED", stage: "EXTRACTION", reason: "no_text" } });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("records a grouping failure and allows retry", async () => {
    mocks.rebuild.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });
    expect(await processExamFile("file-a")).toMatchObject({ ok: false, reason: "grouping_failed" });
    mocks.run.findFirst.mockResolvedValue({ status: "FAILED" });
    expect(await retryFailedExam("file-a")).toMatchObject({ ok: true });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
  });

  it("retries successfully after a missing stored file becomes available", async () => {
    mocks.getOriginalFile.mockRejectedValueOnce(new FileUnavailableError("missing_file")).mockResolvedValueOnce({ bytes: new Uint8Array([1]) });
    expect(await processExamFile("file-a")).toMatchObject({ ok: false, reason: "missing_file" });
    mocks.run.findFirst.mockResolvedValue({ status: "FAILED" });
    expect(await retryFailedExam("file-a")).toMatchObject({ ok: true, questionCount: 2 });
  });

  it("ranks existing questions without replacing them", async () => {
    mocks.countQuestions.mockResolvedValue(2);
    expect(await processExamFile("file-a")).toMatchObject({ ok: true, questionCount: 2 });
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.rebuild).toHaveBeenCalledWith("course-a");
  });

  it("does not process pending exams or retry a successful run", async () => {
    mocks.file.findUnique.mockResolvedValue({ id: "file-a", category: "EXAM", status: "PENDING" });
    expect(await processExamFile("file-a")).toEqual({ ok: false, reason: "not_eligible" });
    expect(mocks.run.create).not.toHaveBeenCalled();
    mocks.run.findFirst.mockResolvedValue({ status: "SUCCEEDED" });
    expect(await retryFailedExam("file-a")).toEqual({ ok: false, reason: "not_failed" });
  });

  it("does not throw after an upload when a processing run cannot be created", async () => {
    mocks.run.create.mockRejectedValue(new Error("database unavailable"));
    expect(await processExamFile("file-a")).toEqual({ ok: false, reason: "unexpected" });
    expect(mocks.log).toHaveBeenCalledWith("exam_processing_failed", expect.objectContaining({ fileId: "file-a", stage: "EXTRACTION", reason: "unexpected" }));
  });

  it("allows retry of an interrupted run, while a recent running attempt stays protected", async () => {
    const now = new Date("2026-10-18T12:00:00Z");
    expect(canRetryRun({ status: "RUNNING", createdAt: new Date("2026-10-18T11:59:00Z") }, now)).toBe(false);
    expect(canRetryRun({ status: "RUNNING", createdAt: new Date("2026-10-18T11:30:00Z") }, now)).toBe(true);
    mocks.run.findFirst.mockResolvedValue({ status: "RUNNING", createdAt: new Date(Date.now() - 30 * 60_000) });
    expect(await retryFailedExam("file-a")).toMatchObject({ ok: true });
  });
});
