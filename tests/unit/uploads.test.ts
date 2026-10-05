import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { course, courseProfessor, term, courseFile } = vi.hoisted(() => ({
  course: { findUnique: vi.fn(), findMany: vi.fn() }, courseProfessor: { findUnique: vi.fn() }, term: { findUnique: vi.fn() }, courseFile: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: { course, courseProfessor, term, courseFile } }));
import { MAX_UPLOAD_BYTES } from "@/lib/upload-rules";
import { getUploadOptions, parseUploadForm, saveUpload, validateUploadFile } from "@/lib/uploads";

const pdf = new Uint8Array(Buffer.from("%PDF-1.4\nexample"));
// A ZIP signature plus the entry names a real Office document has (ZIP stores names uncompressed).
const office = (folder: string) => new Uint8Array(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`[Content_Types].xml ${folder}/document.xml`)]));
const input = { courseId: "course-a", category: "EXAM" as const, title: "Final Exam 2025", fileName: "final.pdf", bytes: pdf };

const originalRoot = process.env.FILE_STORAGE_ROOT;
let root: string;
let errors: ReturnType<typeof vi.spyOn>;
const logged = () => errors.mock.calls.map(call => JSON.parse(String(call[0])));
const storedFiles = async () => (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "upcomer-uploads-"));
  process.env.FILE_STORAGE_ROOT = root;
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  course.findUnique.mockReset().mockResolvedValue({ id: "course-a" });
  course.findMany.mockReset();
  courseProfessor.findUnique.mockReset().mockResolvedValue({ courseId: "course-a" });
  term.findUnique.mockReset().mockResolvedValue({ id: "term-fall" });
  courseFile.create.mockReset().mockImplementation(async ({ data }) => ({ id: "file-new", ...data }));
});
afterEach(async () => {
  errors.mockRestore();
  await rm(root, { recursive: true, force: true });
});
afterAll(() => {
  if (originalRoot === undefined) delete process.env.FILE_STORAGE_ROOT;
  else process.env.FILE_STORAGE_ROOT = originalRoot;
});

describe("upload file validation", () => {
  it.each([
    ["exam.pdf", pdf, "application/pdf"],
    ["EXAM.PDF", pdf, "application/pdf"],
    ["notes.docx", office("word"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["slides.pptx", office("ppt"), "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["scan.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    ["scan.jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
  ])("accepts %s", (name, bytes, mimeType) => {
    expect(validateUploadFile(name, bytes).mimeType).toBe(mimeType);
  });
  it.each(["script.exe", "page.html", "archive.zip", "no-extension", "exam.pdf.js"])("rejects unsupported type %s", name => {
    expect(() => validateUploadFile(name, pdf)).toThrow(expect.objectContaining({ reason: "unsupported_type", status: 415 }));
  });
  it("rejects an empty file", () => {
    expect(() => validateUploadFile("exam.pdf", new Uint8Array())).toThrow(expect.objectContaining({ reason: "empty_file", status: 400 }));
  });
  it("rejects a file over the size limit", () => {
    expect(() => validateUploadFile("exam.pdf", new Uint8Array(MAX_UPLOAD_BYTES + 1))).toThrow(expect.objectContaining({ reason: "file_too_large", status: 413 }));
  });
  it.each([
    ["exam.pdf", new Uint8Array(Buffer.from("<html>not a pdf</html>"))],
    ["exam.pdf", new Uint8Array(Buffer.from("%PD"))],
    ["notes.docx", pdf],
    ["archive.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])],
    ["slides.pptx", office("word")],
    ["scan.png", new Uint8Array([0xff, 0xd8, 0xff, 0xe0])],
  ])("rejects corrupt or mislabelled content in %s", (name, bytes) => {
    expect(() => validateUploadFile(name, bytes)).toThrow(expect.objectContaining({ reason: "content_mismatch", status: 400 }));
  });
});

describe("upload form parsing", () => {
  const form = (fields: Record<string, string> = {}, withFile = true) => {
    const data = new FormData();
    for (const [name, value] of Object.entries({ category: "EXAM", courseId: "course-a", title: "Final Exam", ...fields })) data.set(name, value);
    if (withFile) data.set("file", new File([pdf], "final.pdf"));
    return data;
  };
  const now = new Date("2026-10-03T00:00:00Z");

  it("reads required and optional fields", () => {
    const parsed = parseUploadForm(form({ title: "  Final Exam  ", year: "2025", termId: "term-fall", examType: "FINAL", topic: "Routing", professorId: "prof-a" }), now);
    expect(parsed).toMatchObject({ category: "EXAM", courseId: "course-a", title: "Final Exam", year: 2025, termId: "term-fall", examType: "FINAL", topic: "Routing", professorId: "prof-a" });
    expect(parsed.file.name).toBe("final.pdf");
  });
  it("leaves blank optional fields undefined", () => {
    expect(parseUploadForm(form({ year: "", termId: " ", examType: "", topic: "", professorId: "" }), now)).toMatchObject({ year: undefined, termId: undefined, examType: undefined, topic: undefined, professorId: undefined });
  });
  it.each([
    [{ category: "OTHER" }, "invalid_fields"], [{ category: "" }, "invalid_fields"], [{ title: "   " }, "invalid_fields"], [{ title: "x".repeat(151) }, "invalid_fields"],
    [{ courseId: "" }, "course_required"], [{ courseId: "   " }, "course_required"],
    [{ year: "25" }, "invalid_year"], [{ year: "abcd" }, "invalid_year"], [{ year: "1949" }, "invalid_year"], [{ year: "2028" }, "invalid_year"], [{ year: "2025.5" }, "invalid_year"],
    [{ topic: "x".repeat(101) }, "topic_too_long"], [{ examType: "SESSION" }, "invalid_type"], [{ category: "MATERIAL", examType: "FINAL" }, "type_not_allowed"],
  ])("rejects invalid fields %o as %s", (fields, reason) => {
    expect(() => parseUploadForm(form(fields), now)).toThrow(expect.objectContaining({ reason, status: 400 }));
  });
  it("uses the same messages as the admin edit page", () => {
    expect(() => parseUploadForm(form({ courseId: "" }), now)).toThrow("Choose a course.");
    expect(() => parseUploadForm(form({ year: "1949" }), now)).toThrow("Year must be a 4-digit year between 1950 and 2027.");
    expect(() => parseUploadForm(form({ category: "MATERIAL", examType: "FINAL" }), now)).toThrow("Only exams have a type.");
  });
  it("accepts next year's exams and rejects a missing file", () => {
    expect(parseUploadForm(form({ year: "2027" }), now).year).toBe(2027);
    expect(() => parseUploadForm(form({}, false), now)).toThrow(expect.objectContaining({ reason: "invalid_fields" }));
    expect(() => parseUploadForm(form({ file: "just text" }, false), now)).toThrow(expect.objectContaining({ reason: "invalid_fields" }));
  });
});

describe("saving an upload", () => {
  it("stores the bytes and creates a matching record", async () => {
    const record = await saveUpload({ ...input, professorId: "prof-a", year: 2025, termId: "term-fall", examType: "FINAL" });
    expect(record.id).toBe("file-new");
    const data = courseFile.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      courseId: "course-a", professorId: "prof-a", title: "Final Exam 2025", category: "EXAM", originalFileName: "final.pdf",
      year: 2025, termId: "term-fall", examType: "FINAL", mimeType: "application/pdf", sizeBytes: pdf.length,
    });
    expect(data.storageKey).toMatch(/^exams\/[0-9a-f-]{36}\.pdf$/);
    expect(new Uint8Array(await readFile(path.join(root, data.storageKey)))).toEqual(pdf);
  });
  it("stores materials separately and never uses the original name as the storage key", async () => {
    await saveUpload({ ...input, category: "MATERIAL", fileName: "..\\..\\evil/../Lecture 1.PDF" });
    const data = courseFile.create.mock.calls[0][0].data;
    expect(data.storageKey).toMatch(/^materials\/[0-9a-f-]{36}\.pdf$/);
    expect(data.originalFileName).toBe("Lecture 1.PDF");
    expect(await storedFiles()).toHaveLength(1);
  });
  it("gives two uploads of the same file different storage keys", async () => {
    await saveUpload(input);
    await saveUpload(input);
    const keys = courseFile.create.mock.calls.map(call => call[0].data.storageKey);
    expect(new Set(keys).size).toBe(2);
  });
  it("rejects an invalid file before touching the database or storage", async () => {
    await expect(saveUpload({ ...input, bytes: new Uint8Array(Buffer.from("not a pdf")) })).rejects.toMatchObject({ reason: "content_mismatch" });
    expect(course.findUnique).not.toHaveBeenCalled();
    expect(await storedFiles()).toHaveLength(0);
  });
  it("rejects an unknown course, a professor who doesn't teach the course, or an unknown term without storing anything", async () => {
    course.findUnique.mockResolvedValueOnce(null);
    await expect(saveUpload(input)).rejects.toMatchObject({ reason: "course_not_found", status: 404 });
    courseProfessor.findUnique.mockResolvedValueOnce(null);
    await expect(saveUpload({ ...input, professorId: "prof-b" })).rejects.toMatchObject({ reason: "professor_not_assigned", status: 404, message: "The selected professor doesn't teach the selected course." });
    expect(courseProfessor.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { courseId_professorId: { courseId: "course-a", professorId: "prof-b" } } }));
    term.findUnique.mockResolvedValueOnce(null);
    await expect(saveUpload({ ...input, termId: "ghost" })).rejects.toMatchObject({ reason: "term_not_found", status: 400 });
    expect(await storedFiles()).toHaveLength(0);
    expect(courseFile.create).not.toHaveBeenCalled();
  });
  it("reports and logs a storage failure without creating a record", async () => {
    // A regular file where the storage folder should be makes every write fail.
    const blocked = path.join(root, "blocked");
    await writeFile(blocked, "");
    process.env.FILE_STORAGE_ROOT = blocked;
    await expect(saveUpload(input)).rejects.toMatchObject({ reason: "storage_failed", status: 500 });
    expect(courseFile.create).not.toHaveBeenCalled();
    expect(logged()).toEqual([expect.objectContaining({ event: "upload_storage_failed", courseId: "course-a", resourceCategory: "EXAM" })]);
  });
  it("removes the stored file and logs when the record cannot be created", async () => {
    courseFile.create.mockRejectedValue(new Error("database down"));
    await expect(saveUpload(input)).rejects.toMatchObject({ reason: "record_failed", status: 500 });
    expect(await storedFiles()).toHaveLength(0);
    expect(logged()).toEqual([expect.objectContaining({ event: "upload_record_failed", courseId: "course-a", errorType: "Error" })]);
    expect(JSON.stringify(logged())).not.toContain("database down");
  });
});

describe("upload options", () => {
  it("lists courses with their professors", async () => {
    course.findMany.mockResolvedValue([{ id: "course-a", code: "EECE350", name: "Computer Networks", professors: [{ professor: { id: "prof-a", name: "Professor A" } }] }]);
    expect(await getUploadOptions()).toEqual([{ id: "course-a", code: "EECE350", name: "Computer Networks", professors: [{ id: "prof-a", name: "Professor A" }] }]);
  });
  it("logs and rethrows a retrieval failure", async () => {
    course.findMany.mockRejectedValue(new Error("database down"));
    await expect(getUploadOptions()).rejects.toThrow("database down");
    expect(logged()).toEqual([expect.objectContaining({ event: "upload_options_retrieval_failed" })]);
  });
});
