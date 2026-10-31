import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// US-92: the exam pipeline end to end against a real database, with the real upload route, the real stored files,
// the real grouping and ranking, and the real consolidated ordered exam. Only the admin session is faked, and
// extraction (US-14) and processing runs (US-76) are part of the real upload flow.

const { getAdminUser } = vi.hoisted(() => ({ getAdminUser: vi.fn() }));
vi.mock("@/lib/auth", async original => ({ ...(await original<typeof import("@/lib/auth")>()), getAdminUser }));

import { POST as upload } from "@/app/api/admin/uploads/route";
import { getConsolidatedExam, type ConsolidatedExam } from "@/lib/consolidated-exam";
import { db } from "@/lib/db";
import { tierFor } from "@/lib/likelihood-tiers";
import { rebuildQuestionBank } from "@/lib/question-bank";
import { isNearIdentical, normalizeQuestionText } from "@/lib/question-grouping";
import { publishSubmission, rejectSubmission } from "@/lib/submissions";
import { EXPECTED_EXAM, FAILING_SAMPLES, SAMPLE_EXAMS, samplePdf, type SampleExam } from "./fixtures/sample-exams";
import { extractQuestions } from "./fixtures/pipeline";

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const faculty = { id: `it-pipe-faculty-${stamp}`, code: `IPF${stamp}`.toUpperCase().slice(0, 20), name: "Pipeline Faculty" };
const student = `it-pipe-student-${stamp}`;
const courseIds: string[] = [];
let courseCounter = 0;
let root: string;
const originalRoot = process.env.FILE_STORAGE_ROOT;

async function newCourse() {
  courseCounter++;
  const course = await db.course.create({ data: { id: `it-pipe-course${courseCounter}-${stamp}`, code: `IP${courseCounter}${stamp}`.toUpperCase().slice(0, 20), name: `Pipeline Course ${courseCounter}`, facultyId: faculty.id } });
  courseIds.push(course.id);
  return course.id;
}

function uploadRequest(fields: Record<string, string>, file: { name: string; bytes: Uint8Array }) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  form.set("file", new File([Buffer.from(file.bytes)], file.name, { type: "application/pdf" }));
  return new Request("http://localhost/api/admin/uploads", { method: "POST", body: form });
}

// Uploads one sample through the real route, checks the stored copy, and returns the new file's ID.
async function uploadSample(courseId: string, exam: SampleExam) {
  const bytes = samplePdf(exam);
  const response = await upload(uploadRequest({ category: "EXAM", courseId, title: exam.title, year: String(exam.year), examType: exam.examType }, { name: exam.fileName, bytes }));
  expect(response.status).toBe(201);
  const { file } = await response.json();
  const saved = await db.courseFile.findUniqueOrThrow({ where: { id: file.id } });
  expect(saved).toMatchObject({ courseId, status: "PUBLISHED", category: "EXAM", year: exam.year, examType: exam.examType, mimeType: "application/pdf" });
  expect(Buffer.compare(await readFile(path.join(root, saved.storageKey)), Buffer.from(bytes))).toBe(0);
  const questions = await db.question.findMany({ where: { fileId: file.id }, orderBy: { number: "asc" } });
  expect(questions.map(question => question.text)).toEqual(exam.questions);
  expect((await db.fileProcessingRun.findFirst({ where: { fileId: file.id }, orderBy: { createdAt: "desc" } }))?.status).toBe("SUCCEEDED");
  return file.id as string;
}

async function uploadAndProcess(courseId: string, exams: SampleExam[]) {
  for (const exam of exams) await uploadSample(courseId, exam);
  return getConsolidatedExam(courseId);
}

// The first line of a question, as its grouping key, so the wording chosen for display does not matter.
const key = (text: string) => normalizeQuestionText(text.split("\n")[0]);
const sameQuestion = (actual: string, expected: string) => isNearIdentical(key(actual), key(expected));

// What a student sees, with each question named by its place in EXPECTED_EXAM: the wording shown comes from the paper whose
// ID sorts first (roughly the earliest upload), so it can differ between runs while the question is the same.
const expectedIndex = (text: string) => EXPECTED_EXAM.questions.findIndex(expected => sameQuestion(text, expected.text));
const shape = (exam: ConsolidatedExam) => ({
  totalPapers: exam.totalPapers, lowConfidence: exam.lowConfidence,
  questions: exam.questions.map(question => [expectedIndex(question.text), question.paperCount, question.tier, question.papers.map(paper => paper.year)]),
});

// Rules every ordered exam must follow, whatever its content. `ranked` is false only right after a paper left the course
// without a regroup, when counts are already current but the order is the previous regroup's.
function expectWellFormed(exam: ConsolidatedExam, ranked = true) {
  exam.questions.forEach((question, index) => {
    expect(question.position).toBe(index + 1);
    expect(question.totalPapers).toBe(exam.totalPapers);
    expect(question.paperCount).toBe(question.papers.length);
    expect(question.tier).toBe(tierFor(question.paperCount, exam.totalPapers));
    if (ranked && index > 0) expect(question.paperCount).toBeLessThanOrEqual(exam.questions[index - 1].paperCount);
    const years = question.papers.map(paper => paper.year ?? 0);
    expect(years).toEqual([...years].sort((a, b) => b - a));
  });
  expect(exam.sections.flatMap(section => section.questions)).toEqual(exam.questions);
}

function expectSampleExam(exam: ConsolidatedExam) {
  expectWellFormed(exam);
  expect(exam).toMatchObject({ totalPapers: EXPECTED_EXAM.totalPapers, lowConfidence: EXPECTED_EXAM.lowConfidence });
  expect(exam.questions).toHaveLength(EXPECTED_EXAM.questions.length);
  EXPECTED_EXAM.questions.forEach((expected, index) => {
    const actual = exam.questions[index];
    expect(sameQuestion(actual.text, expected.text), `position ${index + 1}: "${actual.text}" should be "${expected.text}"`).toBe(true);
    expect(actual).toMatchObject({ paperCount: expected.paperCount, tier: expected.tier });
    expect(actual.papers.map(paper => paper.year)).toEqual(expected.years);
  });
  expect(exam.sections.map(section => [section.tier, section.questions.length])).toEqual(EXPECTED_EXAM.sections);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "upcomer-pipeline-"));
  process.env.FILE_STORAGE_ROOT = root;
  await db.faculty.create({ data: faculty });
  await db.user.create({ data: { id: student, email: `${student}@pipeline.test`, name: "Pipeline Student", passwordHash: "x" } });
});
afterAll(async () => {
  try {
    // Deleting the courses deletes their files, questions, and question groups.
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
  getAdminUser.mockReset().mockResolvedValue({ id: "admin-pipeline", role: "ADMIN" });
});
afterEach(() => vi.restoreAllMocks());

describe.sequential("exam pipeline end to end", () => {
  it("turns the uploaded sample exams into the expected ordered exam (acceptance test 1)", async () => {
    const courseId = await newCourse();
    const exam = await uploadAndProcess(courseId, SAMPLE_EXAMS);
    expectSampleExam(exam);
    // A multi-part question keeps its sub-parts, one per line.
    expect(exam.questions[6].text).toBe(EXPECTED_EXAM.questions[6].text);
    // Near-identical wordings (numbering, case, marks, a typo) became one question; different acronyms and exponents did not.
    expect(exam.questions.filter(question => /tcp/i.test(question.text))).toHaveLength(3);
  });

  it("gives the same ordered exam whatever order the papers are uploaded in", async () => {
    const reference = shape(await uploadAndProcess(await newCourse(), SAMPLE_EXAMS));
    for (const order of [[4, 3, 2, 1, 0], [2, 0, 4, 1, 3]]) {
      const exam = await uploadAndProcess(await newCourse(), order.map(index => SAMPLE_EXAMS[index]));
      expectSampleExam(exam);
      expect(shape(exam)).toEqual(reference);
    }
  });

  it("ends in the expected exam when all five papers are uploaded and regrouped at the same moment", async () => {
    const courseId = await newCourse();
    await Promise.all(SAMPLE_EXAMS.map(exam => uploadSample(courseId, exam)));
    // Each regroup holds the course lock, so the last one to run saw every paper.
    expectSampleExam(await getConsolidatedExam(courseId));
  });

  it("grows one paper at a time to the same exam, with a low-confidence note until there are 5 papers", async () => {
    const courseId = await newCourse();
    for (const [index, sample] of SAMPLE_EXAMS.entries()) {
      const exam = await uploadAndProcess(courseId, [sample]);
      expectWellFormed(exam);
      expect(exam).toMatchObject({ totalPapers: index + 1, lowConfidence: index + 1 < 5 });
    }
    expectSampleExam(await getConsolidatedExam(courseId));
  });

  it("accepts image-only and corrupt PDFs as uploads, and they add nothing to the ordered exam", async () => {
    const courseId = await newCourse();
    await uploadAndProcess(courseId, SAMPLE_EXAMS);
    for (const sample of FAILING_SAMPLES) {
      const response = await upload(uploadRequest({ category: "EXAM", courseId, title: sample.title }, { name: sample.fileName, bytes: sample.bytes }));
      // They start with %PDF-, so the upload check lets them through; only extraction can tell they have no text.
      expect(response.status).toBe(201);
      const fileId = (await response.json()).file.id;
      expect(await db.question.count({ where: { fileId } })).toBe(0);
      expect(await db.fileProcessingRun.findFirst({ where: { fileId }, orderBy: { createdAt: "desc" } })).toMatchObject({ status: "FAILED", stage: "EXTRACTION", reason: sample.reason });
    }
    await rebuildQuestionBank(courseId);
    expectSampleExam(await getConsolidatedExam(courseId));
  });

  it("retries a failed image-only PDF and records another failed attempt", async () => {
    const courseId = await newCourse();
    const sample = FAILING_SAMPLES[0];
    const response = await upload(uploadRequest({ category: "EXAM", courseId, title: sample.title }, { name: sample.fileName, bytes: sample.bytes }));
    const fileId = (await response.json()).file.id;
    const { retryFailedExam } = await import("@/lib/exam-processing");
    expect(await retryFailedExam(fileId)).toMatchObject({ ok: false, reason: "no_text" });
    expect(await db.fileProcessingRun.count({ where: { fileId, status: "FAILED" } })).toBe(2);
  });

  it("leaves out a pending or rejected student submission, and takes a submission in once it is published", async () => {
    const courseId = await newCourse();
    await uploadAndProcess(courseId, SAMPLE_EXAMS);
    const submit = async (title: string) => db.courseFile.create({ data: {
      courseId, title, category: "EXAM", status: "PENDING", submittedById: student, year: 2025,
      originalFileName: "s.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf",
    } });
    const accepted = await submit("Submitted Final 2025");
    const refused = await submit("Submitted Quiz 2025");
    await extractQuestions(accepted.id, ["1. Define TCP and explain the three-way handshake.", "2. Explain the sliding window protocol."]);
    await extractQuestions(refused.id, ["1. Define TCP and explain the three-way handshake."]);
    await rebuildQuestionBank(courseId);
    expectSampleExam(await getConsolidatedExam(courseId));

    expect(await rejectSubmission(refused.id, "Duplicate")).toMatchObject({ ok: true });
    // Publishing regroups the course itself.
    expect(await publishSubmission(accepted.id)).toMatchObject({ ok: true });
    const exam = await getConsolidatedExam(courseId);
    expectWellFormed(exam);
    expect(exam.totalPapers).toBe(6);
    expect(exam.questions[0]).toMatchObject({ paperCount: 6, tier: "VERY_LIKELY" });
    expect(exam.questions[0].papers[0].year).toBe(2025);
    // The sliding window is now in 3 of 6 papers, ahead of the TCP/UDP question's 3 by its newer year.
    expect(sameQuestion(exam.questions[1].text, "Explain the sliding window protocol.")).toBe(true);
    expect(exam.questions[1]).toMatchObject({ paperCount: 3, tier: "VERY_LIKELY" });
  });

  it("never puts a material in the ordered exam, even with extracted text", async () => {
    const courseId = await newCourse();
    await uploadAndProcess(courseId, SAMPLE_EXAMS);
    const response = await upload(uploadRequest({ category: "MATERIAL", courseId, title: "Lecture Notes" }, { name: "notes.pdf", bytes: samplePdf(SAMPLE_EXAMS[0]) }));
    expect(response.status).toBe(201);
    await extractQuestions((await response.json()).file.id, SAMPLE_EXAMS[0].questions);
    await rebuildQuestionBank(courseId);
    expectSampleExam(await getConsolidatedExam(courseId));
  });

  it("drops a deleted paper from the ordered exam at once, and re-ranks on the next regroup", async () => {
    const courseId = await newCourse();
    await uploadAndProcess(courseId, SAMPLE_EXAMS);
    const final2024 = await db.courseFile.findFirstOrThrow({ where: { courseId, title: "Final 2024" } });
    await db.courseFile.delete({ where: { id: final2024.id } });

    const before = await getConsolidatedExam(courseId);
    // Found by this test: until a regroup, the order is the old one, so the sliding window (now 1 paper) still sits
    // above ARP (2 papers).
    expectWellFormed(before, false);
    expect(before.questions.map(question => question.paperCount).slice(0, 4)).toEqual([4, 2, 1, 2]);
    expect(before.totalPapers).toBe(4);
    expect(before.questions.some(question => question.papers.some(paper => paper.id === final2024.id))).toBe(false);
    // Questions only that paper had are gone at once.
    expect(before.questions.some(question => sameQuestion(question.text, "Compute x^2 + 1 for x = 3."))).toBe(false);

    await rebuildQuestionBank(courseId);
    const after = await getConsolidatedExam(courseId);
    expectWellFormed(after);
    // ARP (2 papers) now ranks above the sliding window (1 paper left).
    expect(after.questions.slice(0, 3).map(question => [key(question.text), question.paperCount])).toEqual([
      [key("Define TCP and explain the three-way handshake."), 4], [key("Explain how ARP resolves an IP address to a MAC address."), 2], [key("What is the difference between TCP and UDP?"), 2],
    ]);
  });

  it("moves a re-tagged paper out of the old course's exam at once, and into the new one after the new course is regrouped", async () => {
    const oldCourse = await newCourse();
    const newCourseId = await newCourse();
    await uploadAndProcess(oldCourse, SAMPLE_EXAMS);
    const moved = await db.courseFile.findFirstOrThrow({ where: { courseId: oldCourse, title: "Midterm 2023" } });
    // As the file details page saves it (Member 4): only the course changes.
    await db.courseFile.update({ where: { id: moved.id }, data: { courseId: newCourseId } });

    const oldExam = await getConsolidatedExam(oldCourse);
    expectWellFormed(oldExam, false);
    expect(oldExam.totalPapers).toBe(4);
    expect(oldExam.questions.some(question => question.papers.some(paper => paper.id === moved.id))).toBe(false);
    // Found by this test: until someone regroups the new course, the paper is in no course's exam.
    expect((await getConsolidatedExam(newCourseId)).questions).toEqual([]);

    await rebuildQuestionBank(newCourseId);
    await rebuildQuestionBank(oldCourse);
    const newExam = await getConsolidatedExam(newCourseId);
    expect(newExam.totalPapers).toBe(1);
    expect(newExam.questions.map(question => key(question.text))).toEqual(SAMPLE_EXAMS[3].questions.map(key).sort((a, b) => (a < b ? -1 : 1)));
  });

  it("refuses an upload from someone who is not an admin, and stores nothing", async () => {
    const courseId = await newCourse();
    getAdminUser.mockResolvedValue(null);
    const response = await upload(uploadRequest({ category: "EXAM", courseId, title: "Sneaky" }, { name: "sneaky.pdf", bytes: samplePdf(SAMPLE_EXAMS[0]) }));
    expect(response.status).toBe(403);
    expect(await db.courseFile.count({ where: { courseId } })).toBe(0);
  });

  it("processes a course of 20 papers with 25 questions each within the 1 s target per stage", async () => {
    const courseId = await newCourse();
    const topics = Array.from({ length: 60 }, (_, index) => `Explain networking concept number ${index} with an example.`);
    const timings = { upload: [] as number[], regroup: [] as number[] };
    for (let paper = 0; paper < 20; paper++) {
      const exam: SampleExam = { title: `Paper ${paper}`, year: 2005 + paper, examType: "FINAL", fileName: `paper-${paper}.pdf`, header: [`Paper ${paper}`], questions: topics.slice(paper, paper + 25).map((text, index) => `${index + 1}. ${text}`) };
      let started = performance.now();
      await uploadSample(courseId, exam);
      timings.upload.push(performance.now() - started);
      started = performance.now();
      expect(await rebuildQuestionBank(courseId)).toMatchObject({ ok: true });
      timings.regroup.push(performance.now() - started);
    }
    const started = performance.now();
    const exam = await getConsolidatedExam(courseId);
    const examMs = performance.now() - started;
    expectWellFormed(exam);
    expect(exam.totalPapers).toBe(20);
    expect(exam.questions).toHaveLength(44);
    expect(Math.max(...timings.upload)).toBeLessThan(1000);
    expect(Math.max(...timings.regroup)).toBeLessThan(1000);
    expect(examMs).toBeLessThan(1000);
  });
});
