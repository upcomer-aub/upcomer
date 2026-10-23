import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// M4 cross-tests for M5's US-14 (automatic question extraction) and US-76 (see failed file processing), against a real
// database, the real upload route, real stored files, and the real PDF.js extractor. Only the admin session is faked.
// The issues these tests found (page footers, section headings, numbered instructions, scanner watermarks, simultaneous
// retries, slow regrouping of large papers) are fixed on this branch, and the tests now check the fixed behavior.

const { getAdminUser } = vi.hoisted(() => ({ getAdminUser: vi.fn() }));
vi.mock("@/lib/auth", async original => ({ ...(await original<typeof import("@/lib/auth")>()), getAdminUser }));

import { POST as upload } from "@/app/api/admin/uploads/route";
import { getConsolidatedExam } from "@/lib/consolidated-exam";
import { db } from "@/lib/db";
import { extractExamQuestions } from "@/lib/exam-extraction";
import { processExamFile, processingReason, retryFailedExam } from "@/lib/exam-processing";
import { publishSubmission, rejectSubmission, saveSubmission } from "@/lib/submissions";
import { corruptPdf, imageOnlyPdf } from "./fixtures/pdf";
import { blankPagesPdf, layoutPdf, linesPdf, watermarkedScanPdf } from "./fixtures/layout-pdf";

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const faculty = { id: `it-m4-faculty-${stamp}`, code: `IMF${stamp}`.toUpperCase().slice(0, 20), name: "Cross-test Faculty" };
const student = `it-m4-student-${stamp}`;
const courseIds: string[] = [];
let root: string;
const originalRoot = process.env.FILE_STORAGE_ROOT;

async function newCourse() {
  const course = await db.course.create({ data: { id: `it-m4-course${courseIds.length}-${stamp}`, code: `IM${courseIds.length}${stamp}`.toUpperCase().slice(0, 20), name: "Cross-test Course", facultyId: faculty.id } });
  courseIds.push(course.id);
  return course.id;
}

async function uploadExam(courseId: string, bytes: Uint8Array, name = "exam.pdf", category = "EXAM") {
  const form = new FormData();
  for (const [key, value] of Object.entries({ category, courseId, title: `Cross ${name}`, year: "2024" })) form.set(key, value);
  form.set("file", new File([Buffer.from(bytes)], name, { type: "application/pdf" }));
  const started = performance.now();
  const response = await upload(new Request("http://localhost/api/admin/uploads", { method: "POST", body: form }));
  const ms = performance.now() - started;
  expect(response.status).toBe(201);
  return { fileId: (await response.json()).file.id as string, ms };
}
const runsOf = (fileId: string) => db.fileProcessingRun.findMany({ where: { fileId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const questionsOf = async (fileId: string) => (await db.question.findMany({ where: { fileId }, orderBy: { number: "asc" } })).map(question => question.text);
const storedPath = async (fileId: string) => path.join(root, (await db.courseFile.findUniqueOrThrow({ where: { id: fileId } })).storageKey);

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "upcomer-m4-"));
  process.env.FILE_STORAGE_ROOT = root;
  await db.faculty.create({ data: faculty });
  await db.user.create({ data: { id: student, email: `${student}@cross.test`, name: "Cross Student", passwordHash: "x" } });
});
afterAll(async () => {
  try {
    await db.course.deleteMany({ where: { id: { in: courseIds } } });
    await db.faculty.deleteMany({ where: { id: faculty.id } });
    await db.user.deleteMany({ where: { id: student } });
  } finally {
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
    if (originalRoot === undefined) delete process.env.FILE_STORAGE_ROOT;
    else process.env.FILE_STORAGE_ROOT = originalRoot;
  }
});
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  getAdminUser.mockReset().mockResolvedValue({ id: "admin-m4", role: "ADMIN" });
});
afterEach(() => vi.restoreAllMocks());

describe("US-14: a typed PDF gives the correct question count", () => {
  it("ignores a header full of numbers and counts 12 questions numbered past 9", async () => {
    const questions = Array.from({ length: 12 }, (_, index) => `${index + 1}. Explain concept ${index + 1} of computer networks.`);
    const pdf = linesPdf([["EECE 350 - Fall 2024 - Final Exam", "Duration: 2 hours. Total: 100 points.", "Name: ________  ID: ________", "Page 1 of 1", ...questions]]);
    const extracted = await extractExamQuestions(pdf);
    expect(extracted).toHaveLength(12);
    expect(extracted.at(-1)).toBe("12. Explain concept 12 of computer networks.");
  });

  it("reads a number and its text drawn as separate pieces on one line", async () => {
    const pdf = layoutPdf([[
      { x: 72, y: 700, text: "1." }, { x: 90, y: 700, text: "Define TCP." },
      { x: 72, y: 680, text: "2." }, { x: 90, y: 680, text: "Define UDP." },
    ]]);
    expect(await extractExamQuestions(pdf)).toEqual(["1. Define TCP.", "2. Define UDP."]);
  });

  it("keeps wrapped lines and lettered sub-parts with their question", async () => {
    const pdf = linesPdf([[
      "1. A host sends a 4000-byte datagram over a link with an MTU of",
      "1500 bytes. How many fragments are made?",
      "(a) Give the offset of each fragment.",
      "b) Give the length of each fragment.",
      "i. Explain the More Fragments flag.",
      "2. Explain ARP.",
    ]]);
    const extracted = await extractExamQuestions(pdf);
    expect(extracted).toHaveLength(2);
    expect(extracted[0].split("\n")).toHaveLength(5);
  });

  it("does not start a question at a line that begins with a decimal or a plain number", async () => {
    const pdf = linesPdf([["1. A link carries", "3.5 Mbps on average and", "100 packets per second. Find the delay.", "2. Explain DNS."]]);
    expect(await extractExamQuestions(pdf)).toHaveLength(2);
  });

  it("counts a question that runs across a page break once", async () => {
    const pdf = linesPdf([["1. Explain TCP congestion control, including", "slow start and"], ["congestion avoidance.", "2. Explain flow control."]]);
    const extracted = await extractExamQuestions(pdf);
    expect(extracted).toHaveLength(2);
    expect(extracted[0]).toContain("congestion avoidance.");
  });

  it("counts every question when each section restarts its numbering", async () => {
    const pdf = linesPdf([["Part A: Short answers", "1. Define latency.", "2. Define jitter.", "Part B: Problems", "1. Compute the throughput.", "2. Compute the delay."]]);
    expect(await extractExamQuestions(pdf)).toHaveLength(4);
  });

  it("keeps a page footer out of the question text", async () => {
    const pdf = linesPdf([["1. Explain TCP congestion control, including", "slow start.", "Page 1 of 2"], ["2. Explain flow control.", "Page 2 of 2"]]);
    const extracted = await extractExamQuestions(pdf);
    expect(extracted[0]).not.toContain("Page 1 of 2");
  });

  it("keeps a section heading out of the previous question's text", async () => {
    const pdf = linesPdf([["Part A", "1. Define latency.", "Part B: Problems", "1. Compute the throughput."]]);
    const extracted = await extractExamQuestions(pdf);
    expect(extracted[0]).toBe("1. Define latency.");
  });

  it("does not count numbered instructions before the first question as questions", async () => {
    const pdf = linesPdf([["Instructions:", "1. Calculators are not allowed.", "2. Write your answers in the booklet.", "Questions", "1. Define TCP.", "2. Define UDP.", "3. Define IP."]]);
    expect(await extractExamQuestions(pdf)).toHaveLength(3);
  });
});

describe("US-14: an image-only PDF fails with \"no extractable text\"", () => {
  it("records a failed run at the extraction stage with no_text, shown as \"No extractable text\"", async () => {
    const courseId = await newCourse();
    const { fileId } = await uploadExam(courseId, imageOnlyPdf(), "scan.pdf");
    const [run] = await runsOf(fileId);
    expect(run).toMatchObject({ status: "FAILED", stage: "EXTRACTION", reason: "no_text" });
    expect(processingReason(run.reason)).toMatch(/^No extractable text/);
    expect(await questionsOf(fileId)).toEqual([]);
  });

  it("gives every unprocessable PDF its own reason", async () => {
    const courseId = await newCourse();
    const cases = [
      { bytes: blankPagesPdf(3), reason: "no_text" },
      { bytes: corruptPdf(), reason: "unreadable_pdf" },
      { bytes: linesPdf([["Formula sheet", "Throughput equals window over RTT"]]), reason: "no_questions" },
    ];
    for (const { bytes, reason } of cases) {
      const { fileId } = await uploadExam(courseId, bytes);
      expect((await runsOf(fileId))[0]).toMatchObject({ status: "FAILED", stage: "EXTRACTION", reason });
    }
  });

  it("reports a scanned page with a scanner-app watermark as having no extractable text", async () => {
    const courseId = await newCourse();
    const { fileId } = await uploadExam(courseId, watermarkedScanPdf("Scanned with CamScanner"), "watermarked-scan.pdf");
    expect((await runsOf(fileId))[0]).toMatchObject({ reason: "no_text" });
  });
});

describe("US-76: failed runs show the stage and reason, and retry works", () => {
  it("retries an image-only exam after the admin replaces the file, and the exam then joins the ordered exam", async () => {
    const courseId = await newCourse();
    const { fileId } = await uploadExam(courseId, imageOnlyPdf(), "scan.pdf");
    expect((await runsOf(fileId))[0].status).toBe("FAILED");
    // The admin swaps in a typed copy of the same exam.
    await writeFile(await storedPath(fileId), Buffer.from(linesPdf([["Final", "1. Define TCP.", "2. Define UDP."]])));

    expect(await retryFailedExam(fileId)).toMatchObject({ ok: true, questionCount: 2 });
    expect((await runsOf(fileId)).map(run => run.status)).toEqual(["FAILED", "SUCCEEDED"]);
    expect(await questionsOf(fileId)).toEqual(["1. Define TCP.", "2. Define UDP."]);
    expect((await getConsolidatedExam(courseId)).questions.map(question => question.text)).toEqual(["Define TCP.", "Define UDP."]);
  });

  it("records missing_file when the stored file is gone, and succeeds on retry once it is back", async () => {
    const courseId = await newCourse();
    const { fileId } = await uploadExam(courseId, imageOnlyPdf(), "scan.pdf");
    const stored = await storedPath(fileId);
    await rm(stored);
    expect(await retryFailedExam(fileId)).toMatchObject({ ok: false, reason: "missing_file" });
    expect((await runsOf(fileId)).at(-1)).toMatchObject({ status: "FAILED", stage: "EXTRACTION", reason: "missing_file" });
    await writeFile(stored, Buffer.from(linesPdf([["1. Define TCP."]])));
    expect(await retryFailedExam(fileId)).toMatchObject({ ok: true, questionCount: 1 });
  });

  it("refuses to retry a successful run, an unknown file, or a material, and adds no run", async () => {
    const courseId = await newCourse();
    const { fileId } = await uploadExam(courseId, linesPdf([["1. Define TCP."]]));
    expect(await retryFailedExam(fileId)).toEqual({ ok: false, reason: "not_failed" });
    expect(await runsOf(fileId)).toHaveLength(1);
    expect(await retryFailedExam(`nope-${stamp}`)).toEqual({ ok: false, reason: "not_failed" });
    const material = await uploadExam(courseId, linesPdf([["1. Define TCP."]]), "notes.pdf", "MATERIAL");
    expect(await runsOf(material.fileId)).toEqual([]);
    expect(await processExamFile(material.fileId)).toEqual({ ok: false, reason: "not_eligible" });
  });

  it("starts exactly one run when five retries arrive at the same moment, and ends with the right questions", async () => {
    const courseId = await newCourse();
    const { fileId } = await uploadExam(courseId, imageOnlyPdf(), "scan.pdf");
    await writeFile(await storedPath(fileId), Buffer.from(linesPdf([["1. Define TCP.", "2. Define UDP."]])));
    const results = await Promise.all(Array.from({ length: 5 }, () => retryFailedExam(fileId)));
    // A per-file lock lets exactly one of them start a run; the others see it running and are refused.
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual(Array(4).fill({ ok: false, reason: "not_failed" }));
    expect((await runsOf(fileId)).map(run => run.status)).toEqual(["FAILED", "SUCCEEDED"]);
    expect(await questionsOf(fileId)).toEqual(["1. Define TCP.", "2. Define UDP."]);
    expect((await getConsolidatedExam(courseId)).questions).toHaveLength(2);
  });

  it("processes a student's exam only once it is published, never while pending or after a rejection", async () => {
    const courseId = await newCourse();
    const typed = linesPdf([["Submitted Final", "1. Define TCP.", "2. Explain the sliding window protocol."]]);
    const accepted = await saveSubmission(student, { courseId, category: "EXAM", title: "Submitted Final", fileName: "final.pdf", bytes: typed });
    const refused = await saveSubmission(student, { courseId, category: "EXAM", title: "Submitted Quiz", fileName: "quiz.pdf", bytes: typed });
    expect(await runsOf(accepted.id)).toEqual([]);
    expect(await processExamFile(accepted.id)).toEqual({ ok: false, reason: "not_eligible" });

    expect(await rejectSubmission(refused.id, "Duplicate")).toMatchObject({ ok: true });
    expect(await publishSubmission(accepted.id)).toMatchObject({ ok: true });
    expect(await runsOf(refused.id)).toEqual([]);
    expect((await runsOf(accepted.id)).map(run => run.status)).toEqual(["SUCCEEDED"]);
    expect((await getConsolidatedExam(courseId)).questions).toHaveLength(2);
  });

  it("deletes an exam's runs with the exam", async () => {
    const courseId = await newCourse();
    const { fileId } = await uploadExam(courseId, imageOnlyPdf(), "scan.pdf");
    await db.courseFile.delete({ where: { id: fileId } });
    expect(await runsOf(fileId)).toEqual([]);
  });
});

describe("US-14 speed: the upload now waits for extraction", () => {
  const examPages = (pages: number, perPage: number) => Array.from({ length: pages }, (_, page) =>
    Array.from({ length: perPage }, (_, row) => `${page * perPage + row + 1}. Explain networking concept number ${page * perPage + row + 1} with an example.`));

  it("uploads and processes a typical 10-page exam with 30 questions within 1 s", async () => {
    const courseId = await newCourse();
    const { fileId, ms } = await uploadExam(courseId, linesPdf(examPages(10, 3)), "typical.pdf");
    console.info(`TYPICAL_UPLOAD ms=${Math.round(ms)}`);
    expect(await questionsOf(fileId)).toHaveLength(30);
    expect(ms).toBeLessThan(1000);
  });

  it("uploads and processes a 40-page exam with 160 questions, within 3 s (over the 1 s target; see the report)", async () => {
    const courseId = await newCourse();
    const { fileId, ms } = await uploadExam(courseId, linesPdf(examPages(40, 4)), "long.pdf");
    console.info(`LONG_UPLOAD ms=${Math.round(ms)}`);
    expect(await questionsOf(fileId)).toHaveLength(160);
    expect(ms).toBeLessThan(3000);
  });

  it("answers an upload of a 2,000-page blank PDF within 5 s, as a failed run", async () => {
    const courseId = await newCourse();
    const bytes = blankPagesPdf(2000);
    const { fileId, ms } = await uploadExam(courseId, bytes, "blank.pdf");
    console.info(`BLANK_PAGES_UPLOAD bytes=${bytes.length} ms=${Math.round(ms)}`);
    expect((await runsOf(fileId))[0]).toMatchObject({ status: "FAILED", reason: "no_text" });
    expect(ms).toBeLessThan(5000);
  });
});
