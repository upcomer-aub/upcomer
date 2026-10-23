import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { course, courseProfessor, term, courseFile, processExamFile } = vi.hoisted(() => ({
  course: { findUnique: vi.fn() }, courseProfessor: { findUnique: vi.fn() }, term: { findUnique: vi.fn() },
  courseFile: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  processExamFile: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { course, courseProfessor, term, courseFile } }));
vi.mock("@/lib/exam-processing", () => ({ processExamFile }));
import {
  canViewFile, getMySubmissions, listPendingSubmissions, MAX_REJECTION_REASON_LENGTH, publishSubmission, PUBLISHED_FILES,
  rejectSubmission, saveSubmission, submissionMessage, validateSubmissionFile,
} from "@/lib/submissions";

const pdf = new Uint8Array(Buffer.from("%PDF-1.4\nexample"));
const input = { courseId: "course-a", category: "EXAM" as const, title: "Secret Title 2025", fileName: "my-final.pdf", bytes: pdf };

const originalRoot = process.env.FILE_STORAGE_ROOT;
let root: string;
let errors: ReturnType<typeof vi.spyOn>;
const logged = () => errors.mock.calls.map(call => JSON.parse(String(call[0])));

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "upcomer-submissions-"));
  process.env.FILE_STORAGE_ROOT = root;
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  course.findUnique.mockReset().mockResolvedValue({ id: "course-a" });
  courseProfessor.findUnique.mockReset().mockResolvedValue({ courseId: "course-a" });
  term.findUnique.mockReset().mockResolvedValue({ id: "term-fall" });
  courseFile.create.mockReset().mockImplementation(async ({ data }) => ({ id: "file-new", ...data }));
  courseFile.findMany.mockReset().mockResolvedValue([]);
  courseFile.findUnique.mockReset().mockResolvedValue({ id: "file-a", courseId: "course-a", category: "EXAM" });
  courseFile.updateMany.mockReset().mockResolvedValue({ count: 1 });
  processExamFile.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  errors.mockRestore();
  await rm(root, { recursive: true, force: true });
});
afterAll(() => {
  if (originalRoot === undefined) delete process.env.FILE_STORAGE_ROOT;
  else process.env.FILE_STORAGE_ROOT = originalRoot;
});

describe("validateSubmissionFile (acceptance test 3)", () => {
  it("accepts a real PDF", () => {
    expect(validateSubmissionFile("Final.PDF", pdf)).toEqual({ extension: "pdf", mimeType: "application/pdf" });
  });
  it.each(["notes.docx", "slides.pptx", "scan.png", "photo.jpg", "exam", "exam.pdf.exe"])("refuses %s, even with PDF bytes", name => {
    expect(() => validateSubmissionFile(name, pdf)).toThrow(expect.objectContaining({ reason: "unsupported_type", status: 415, message: "Only PDF files can be submitted." }));
  });
  it("refuses an empty PDF", () => {
    expect(() => validateSubmissionFile("exam.pdf", new Uint8Array())).toThrow(expect.objectContaining({ reason: "empty_file", message: "The selected file is empty." }));
  });
  it("refuses a renamed file that is not a PDF", () => {
    expect(() => validateSubmissionFile("exam.pdf", new Uint8Array(Buffer.from("not a pdf")))).toThrow(expect.objectContaining({ reason: "content_mismatch" }));
  });
  it("refuses a file over the upload limit", () => {
    expect(() => validateSubmissionFile("exam.pdf", new Uint8Array(20 * 1024 * 1024 + 1))).toThrow(expect.objectContaining({ reason: "file_too_large", status: 413 }));
  });
});

describe("saveSubmission (acceptance test 1)", () => {
  it("stores the PDF safely and creates a PENDING file with its submitter", async () => {
    const record = await saveSubmission("student-a", { ...input, professorId: "prof-a", termId: "term-fall", year: 2025, examType: "FINAL" });
    expect(record).toMatchObject({ status: "PENDING", submittedById: "student-a", courseId: "course-a", category: "EXAM", termId: "term-fall", examType: "FINAL" });
    expect(record.storageKey).toMatch(/^exams\/[0-9a-f-]{36}\.pdf$/);
    const stored = (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
    expect(stored).toHaveLength(1);
  });
  it("uses the shared metadata rules", async () => {
    courseProfessor.findUnique.mockResolvedValue(null);
    await expect(saveSubmission("student-a", { ...input, professorId: "prof-b" })).rejects.toMatchObject({ reason: "professor_not_assigned" });
    expect(courseFile.create).not.toHaveBeenCalled();
  });
  it("stores nothing for a refused file", async () => {
    await expect(saveSubmission("student-a", { ...input, fileName: "notes.docx" })).rejects.toMatchObject({ reason: "unsupported_type" });
    await expect(saveSubmission("student-a", { ...input, bytes: new Uint8Array() })).rejects.toMatchObject({ reason: "empty_file" });
    expect(courseFile.create).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
  it("marks storage failures as coming from a submission, without the title or file name", async () => {
    courseFile.create.mockRejectedValue(new Error("connection lost"));
    await expect(saveSubmission("student-a", input)).rejects.toMatchObject({ reason: "record_failed" });
    expect(logged()).toContainEqual(expect.objectContaining({ event: "upload_record_failed", source: "submission", courseId: "course-a" }));
    expect(JSON.stringify(logged())).not.toMatch(/Secret Title|my-final/);
  });
});

describe("visibility", () => {
  it("only lets the submitter and admins see an unpublished file", () => {
    const pending = { status: "PENDING" as const, submittedById: "student-a" };
    expect(canViewFile(pending, null)).toBe(false);
    expect(canViewFile(pending, { id: "student-b", role: "STUDENT" })).toBe(false);
    expect(canViewFile(pending, { id: "student-a", role: "STUDENT" })).toBe(true);
    expect(canViewFile(pending, { id: "admin", role: "ADMIN" })).toBe(true);
    expect(canViewFile({ status: "REJECTED", submittedById: "student-a" }, { id: "student-b", role: "STUDENT" })).toBe(false);
    expect(canViewFile({ status: "PUBLISHED", submittedById: null }, null)).toBe(true);
    expect(PUBLISHED_FILES).toEqual({ status: "PUBLISHED" });
  });
});

describe("listing submissions", () => {
  it("lists a student's own submissions, newest first", async () => {
    await getMySubmissions("student-a");
    expect(courseFile.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { submittedById: "student-a" }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] }));
  });
  it("lists the review queue oldest first, with the submitter", async () => {
    await listPendingSubmissions();
    const query = courseFile.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ status: "PENDING" });
    expect(query.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    expect(query.include.submittedBy).toEqual({ select: { id: true, name: true } });
  });
  it("logs and rethrows a failure", async () => {
    courseFile.findMany.mockRejectedValue(new TypeError("boom"));
    await expect(getMySubmissions("student-a")).rejects.toThrow("boom");
    expect(logged()).toContainEqual(expect.objectContaining({ event: "submission_retrieval_failed", userId: "student-a", errorType: "TypeError" }));
  });
});

describe("reviewing (acceptance test 2)", () => {
  it("publishes a pending file only, and regroups the course's exams", async () => {
    expect(await publishSubmission("file-a")).toEqual({ ok: true, id: "file-a", courseId: "course-a" });
    const update = courseFile.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ id: "file-a", status: "PENDING" });
    expect(update.data).toMatchObject({ status: "PUBLISHED" });
    expect(update.data.reviewedAt).toBeInstanceOf(Date);
    expect(update.data).not.toHaveProperty("rejectionReason");
    expect(processExamFile).toHaveBeenCalledWith("file-a");
  });
  it("does not regroup when a material is published", async () => {
    courseFile.findUnique.mockResolvedValue({ id: "file-a", courseId: "course-a", category: "MATERIAL" });
    await publishSubmission("file-a");
    expect(processExamFile).not.toHaveBeenCalled();
  });
  it("rejects with a trimmed reason, and logs the file ID but never the reason", async () => {
    expect(await rejectSubmission("file-a", "  Wrong course: this is EECE330.  ")).toMatchObject({ ok: true });
    const update = courseFile.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ id: "file-a", status: "PENDING" });
    expect(update.data).toMatchObject({ status: "REJECTED", rejectionReason: "Wrong course: this is EECE330." });
    expect(logged()).toEqual([expect.objectContaining({ event: "submission_rejected", level: "info", fileId: "file-a" })]);
    expect(JSON.stringify(logged())).not.toContain("Wrong course");
    expect(processExamFile).not.toHaveBeenCalled();
  });
  it("requires a reason of at most 500 characters before touching the file", async () => {
    expect(await rejectSubmission("file-a", "   ")).toEqual({ ok: false, error: "reason_required" });
    expect(await rejectSubmission("file-a", "x".repeat(MAX_REJECTION_REASON_LENGTH + 1))).toEqual({ ok: false, error: "reason_too_long" });
    expect(await rejectSubmission("file-a", "x".repeat(MAX_REJECTION_REASON_LENGTH))).toMatchObject({ ok: true });
    expect(courseFile.updateMany).toHaveBeenCalledTimes(1);
  });
  it("refuses to review a file twice, so two admins cannot both decide", async () => {
    courseFile.updateMany.mockResolvedValue({ count: 0 });
    expect(await publishSubmission("file-a")).toEqual({ ok: false, error: "not_pending" });
    expect(await rejectSubmission("file-a", "Duplicate")).toEqual({ ok: false, error: "not_pending" });
    expect(processExamFile).not.toHaveBeenCalled();
    expect(logged()).toEqual([]);
  });
  it("reports an unknown file", async () => {
    courseFile.updateMany.mockResolvedValue({ count: 0 });
    courseFile.findUnique.mockResolvedValue(null);
    expect(await publishSubmission("ghost")).toEqual({ ok: false, error: "not_found" });
  });
  it("logs and rethrows a database failure", async () => {
    courseFile.updateMany.mockRejectedValue(new TypeError("boom"));
    await expect(rejectSubmission("file-a", "Blurry scan")).rejects.toThrow("boom");
    expect(logged()).toEqual([expect.objectContaining({ event: "submission_review_failed", level: "error", fileId: "file-a", operation: "reject", errorType: "TypeError" })]);
  });
});

describe("submissionMessage", () => {
  it("explains every refusal", () => {
    expect(submissionMessage("unsupported_type")).toBe("Only PDF files can be submitted.");
    expect(submissionMessage("empty_file")).toBe("The selected file is empty.");
    expect(submissionMessage("file_too_large")).toBe("The file is larger than 20 MB.");
    expect(submissionMessage("professor_not_assigned")).toBe("The selected professor doesn't teach the selected course.");
    expect(submissionMessage("record_failed")).toBe("The file could not be saved. Please try again.");
    expect(submissionMessage("<script>")).toBe("Something went wrong. Please try again.");
  });
});
