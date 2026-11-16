import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getConsolidatedExam } from "@/lib/consolidated-exam";
import { db } from "@/lib/db";
import { processExamFile } from "@/lib/exam-processing";
import { manageFile } from "@/lib/file-management";
import { resolveStoragePath } from "@/lib/files";
import { recordLearningEvents, recordMockOutcomes, recordPracticeOutcome } from "@/lib/learning-evidence";
import { getLearningProfile } from "@/lib/learning-profile";
import { explainPriority, personalPriority } from "@/lib/personal-order";
import { generatePracticeQuestions, getGeneratedPracticeQuestions } from "@/lib/practice-generation";
import { resetRateLimits } from "@/lib/rate-limit";
import { saveTopicConfidence } from "@/lib/topic-confidence";
import { textPdf } from "./fixtures/pdf";

// M4 (Mohammed Al-Haiqi) cross-test of M5 Ali Slim's Sprint 4 stories, against a real, migrated database and real PDFs.
// Written from the sprint plan's tester checks, independently of Ali Slim's own tests:
//   US-25  Question and mock outcomes update the correct student/course/topic, without duplicate events.
//   US-29  The rationale matches the saved confidence, the correct/incorrect outcomes, and the exam frequency.
//   US-44  Generated questions reflect the course papers, stay in course scope, and avoid exact repeats.
//   US-73  An admin replaces or removes a file without leaving stale source links or incorrect rankings.
// Every record is created with a unique suffix and deleted in afterAll; stored PDFs are unlinked.

process.env.PRACTICE_RATE_LIMIT_PER_MINUTE = "1000";
process.env.PRACTICE_GENERATION_RATE_LIMIT_PER_MINUTE = "1000";

const run = `xm4-${randomUUID().slice(0, 8)}`;
const ids = {} as { faculty: string; courseA: string; courseB: string; student: string; other: string; admin: string };
const keys = new Set<string>();

async function paper(courseId: string, title: string, topic: string, lines: string[], status: "PUBLISHED" | "PENDING" = "PUBLISHED") {
  const key = `exams/${run}-${randomUUID()}.pdf`;
  keys.add(key);
  await mkdir(path.dirname(resolveStoragePath(key)), { recursive: true });
  const bytes = textPdf([lines]);
  await writeFile(resolveStoragePath(key), bytes);
  const file = await db.courseFile.create({ data: {
    courseId, topic, title, originalFileName: "paper.pdf", storageKey: key, category: "EXAM", status, mimeType: "application/pdf", sizeBytes: bytes.length, year: 2025,
  } });
  if (status === "PUBLISHED") expect(await processExamFile(file.id)).toMatchObject({ ok: true });
  return file;
}
const questionOf = async (courseId: string, contains: string) =>
  (await db.question.findFirstOrThrow({ where: { file: { courseId }, text: { contains } }, select: { id: true } })).id;
const topicRow = (userId: string, courseId: string, topicKey: string) =>
  db.learningTopic.findUnique({ where: { userId_courseId_topicKey: { userId, courseId, topicKey } } });

beforeAll(async () => {
  ids.faculty = (await db.faculty.create({ data: { code: run.toUpperCase(), name: "M4 cross-test" } })).id;
  const [courseA, courseB, student, other, admin] = await Promise.all([
    db.course.create({ data: { code: `${run}A`.toUpperCase(), name: "Cross-test A", facultyId: ids.faculty } }),
    db.course.create({ data: { code: `${run}B`.toUpperCase(), name: "Cross-test B", facultyId: ids.faculty } }),
    db.user.create({ data: { email: `${run}-s@example.com`, passwordHash: "x", name: "Cross Student" } }),
    db.user.create({ data: { email: `${run}-o@example.com`, passwordHash: "x", name: "Other Student" } }),
    db.user.create({ data: { email: `${run}-a@example.com`, passwordHash: "x", name: "Cross Admin", role: "ADMIN" } }),
  ]);
  Object.assign(ids, { courseA: courseA.id, courseB: courseB.id, student: student.id, other: other.id, admin: admin.id });
  await paper(ids.courseA, `TCP final ${run}`, "TCP", ["1. Explain how TCP guarantees reliable delivery of segments.", "2. Describe how TCP flow control protects a slow receiver."]);
  await paper(ids.courseA, `DNS final ${run}`, "DNS", ["1. Explain how a recursive resolver finds an unknown host name."]);
  await paper(ids.courseA, `Pending ${run}`, "TCP", ["1. This pending paper question must never be used as a source."], "PENDING");
  await paper(ids.courseB, `Other course ${run}`, "TCP", ["1. Explain how another course grades its TCP labs in detail."]);
});

afterAll(async () => {
  await db.course.deleteMany({ where: { id: { in: [ids.courseA, ids.courseB].filter(Boolean) } } });
  await db.user.deleteMany({ where: { id: { in: [ids.student, ids.other, ids.admin].filter(Boolean) } } });
  if (ids.faculty) await db.faculty.deleteMany({ where: { id: ids.faculty } });
  for (const key of keys) await unlink(resolveStoragePath(key)).catch(() => undefined);
  await db.$disconnect();
});

beforeEach(() => resetRateLimits());

describe("US-25: outcomes update the right student, course, and topic, without duplicates", () => {
  it("a question-bank outcome updates only this student's profile, for this course and the question's topic", async () => {
    const questionId = await questionOf(ids.courseA, "reliable delivery");
    expect(await recordPracticeOutcome(ids.student, ids.courseA, { eventId: `${run}-p1`, questionId, outcome: "INCORRECT" })).toMatchObject({ ok: true, recorded: 1 });
    expect(await topicRow(ids.student, ids.courseA, "tcp")).toMatchObject({ correctCount: 0, incorrectCount: 1 });
    expect(await topicRow(ids.student, ids.courseA, "dns")).toBeNull();
    expect(await topicRow(ids.other, ids.courseA, "tcp")).toBeNull();
    expect(await topicRow(ids.student, ids.courseB, "tcp")).toBeNull();
  });

  it("a replay of the same event is a duplicate and changes nothing; a replay with another outcome is refused", async () => {
    const questionId = await questionOf(ids.courseA, "reliable delivery");
    const before = await topicRow(ids.student, ids.courseA, "tcp");
    expect(await recordPracticeOutcome(ids.student, ids.courseA, { eventId: `${run}-p1`, questionId, outcome: "INCORRECT" })).toMatchObject({ ok: true, recorded: 0, duplicates: 1 });
    expect(await recordPracticeOutcome(ids.student, ids.courseA, { eventId: `${run}-p1`, questionId, outcome: "CORRECT" })).toEqual({ ok: false, error: "duplicate_conflict" });
    expect(await topicRow(ids.student, ids.courseA, "tcp")).toMatchObject({ correctCount: before!.correctCount, incorrectCount: before!.incorrectCount, weakness: before!.weakness });
    expect(await db.learningEvent.count({ where: { userId: ids.student, eventId: `${run}-p1` } })).toBe(1);
  });

  it("two deliveries of the same event at the same moment record it once", async () => {
    const questionId = await questionOf(ids.courseA, "recursive resolver");
    const results = await Promise.all([1, 2, 3].map(() => recordPracticeOutcome(ids.student, ids.courseA, { eventId: `${run}-race`, questionId, outcome: "CORRECT" })));
    expect(results.filter(result => result.ok && result.recorded === 1)).toHaveLength(1);
    expect(await topicRow(ids.student, ids.courseA, "dns")).toMatchObject({ correctCount: 1, incorrectCount: 0 });
  });

  it("a mock exam outcome (MOCK_EXAM) updates the same topic, once", async () => {
    const questionId = await questionOf(ids.courseA, "flow control");
    const event = { source: "MOCK_EXAM" as const, eventId: `${run}-mock-1`, questionId, correct: true };
    expect(await recordLearningEvents(ids.student, ids.courseA, [event])).toMatchObject({ ok: true, recorded: 1 });
    expect(await recordLearningEvents(ids.student, ids.courseA, [event])).toMatchObject({ ok: true, recorded: 0, duplicates: 1 });
    expect(await topicRow(ids.student, ids.courseA, "tcp")).toMatchObject({ correctCount: 1, incorrectCount: 1 });
  });

  it("weakness follows the documented formula (2 x baseline + incorrect) / (2 + correct + incorrect)", async () => {
    const row = (await topicRow(ids.student, ids.courseA, "tcp"))!;
    expect(row.weakness).toBeCloseTo((2 * (row.baselineWeakness ?? 0.5) + row.incorrectCount) / (2 + row.correctCount + row.incorrectCount));
  });

  it("an outcome for another course's question, or a pending paper's, is refused and changes no profile", async () => {
    const otherCourseQuestion = await questionOf(ids.courseB, "another course");
    expect(await recordPracticeOutcome(ids.student, ids.courseA, { eventId: `${run}-x1`, questionId: otherCourseQuestion, outcome: "CORRECT" })).toEqual({ ok: false, error: "not_found" });
    expect(await recordLearningEvents(ids.student, ids.courseB, [{ source: "MOCK_EXAM", eventId: `${run}-x2`, questionId: await questionOf(ids.courseA, "flow control"), correct: true }]))
      .toEqual({ ok: false, error: "not_found" });
    expect(await topicRow(ids.student, ids.courseB, "tcp")).toBeNull();
  });

  it("a generated item's mock outcome goes through recordMockOutcomes, once, and only for its owner", async () => {
    const generated = await generatePracticeQuestions(ids.student, ids.courseA, { count: 1, difficulty: "MEDIUM", topicKey: "dns" });
    if (!generated.ok) return expect(generated).toMatchObject({ ok: true });
    const item = generated.questions[0];
    const before = (await topicRow(ids.student, ids.courseA, "dns"))!;
    expect(await recordMockOutcomes(ids.student, ids.courseA, `${run}-attempt`, [{ itemId: "i1", generatedQuestionId: item.id, correct: false }])).toMatchObject({ ok: true, recorded: 1 });
    expect(await recordMockOutcomes(ids.student, ids.courseA, `${run}-attempt`, [{ itemId: "i1", generatedQuestionId: item.id, correct: false }])).toMatchObject({ ok: true, duplicates: 1 });
    expect(await recordMockOutcomes(ids.other, ids.courseA, `${run}-stolen`, [{ itemId: "i1", generatedQuestionId: item.id, correct: true }])).toEqual({ ok: false, error: "not_found" });
    expect(await topicRow(ids.student, ids.courseA, "dns")).toMatchObject({ incorrectCount: before.incorrectCount + 1 });
    expect(await topicRow(ids.other, ids.courseA, "dns")).toBeNull();
  });
});

describe("US-29: the rationale matches the saved inputs", () => {
  it("states the saved confidence, the outcome counts, and the exam frequency, and its priority is the sorting priority", async () => {
    expect(await saveTopicConfidence(ids.other, ids.courseA, [["rating:tcp", "2"]])).toMatchObject({ ok: true });
    const questionId = await questionOf(ids.courseA, "reliable delivery");
    await recordPracticeOutcome(ids.other, ids.courseA, { eventId: `${run}-o1`, questionId, outcome: "CORRECT" });
    await recordPracticeOutcome(ids.other, ids.courseA, { eventId: `${run}-o2`, questionId, outcome: "INCORRECT" });
    await recordPracticeOutcome(ids.other, ids.courseA, { eventId: `${run}-o3`, questionId, outcome: "INCORRECT" });
    const profile = (await getLearningProfile(ids.other, ids.courseA)).get("tcp")!;
    const text = explainPriority({ paperCount: 1, totalPapers: 2 }, "TCP", profile);
    expect(text).toContain("Appeared in 1 of 2 published exam papers");
    expect(profile.confidence).toBe(2);
    expect(text).toContain("Saved confidence: 2 of 5");
    expect(text).toContain("1 correct and 2 incorrect recorded outcomes");
    expect(text).toContain(`= ${personalPriority(1, 2, profile.weakness).toFixed(3)}`);
    expect(text).toContain("not a guarantee");
  });

  it("claims no mastery without evidence", () => {
    const text = explainPriority({ paperCount: 2, totalPapers: 2 }, null, undefined);
    expect(text).toContain("No saved confidence rating");
    expect(text).toContain("No recorded performance evidence");
    expect(text).toContain("Neutral weakness is used; your strength is unknown");
  });
});

describe("US-44: generated questions reflect the course papers, stay in scope, and do not repeat", () => {
  it("uses only this course's published exam questions as sources, and keeps the requested topic", async () => {
    const result = await generatePracticeQuestions(ids.other, ids.courseA, { count: 2, difficulty: "MEDIUM", topicKey: "tcp" });
    if (!result.ok) return expect(result).toMatchObject({ ok: true });
    expect(result.questions).toHaveLength(2);
    const sources = await db.question.findMany({ where: { id: { in: result.questions.map(item => item.sourceQuestionId) } }, include: { file: true } });
    for (const source of sources) {
      expect(source.file).toMatchObject({ courseId: ids.courseA, status: "PUBLISHED", category: "EXAM", topic: "TCP" });
    }
    for (const item of result.questions) {
      const source = sources.find(entry => entry.id === item.sourceQuestionId)!;
      // The task is grounded in its source: the source's words appear in it.
      expect(item.prompt).toContain(source.text.replace(/^\d+\.\s*/, "").slice(0, 30));
      expect(item.prompt).not.toContain("pending paper");
      expect(item.prompt).not.toContain("another course");
    }
  });

  it("never gives the student the exact same question twice, and refuses once the sources are used up", async () => {
    const texts: string[] = [];
    let refused = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await generatePracticeQuestions(ids.other, ids.courseA, { count: 1, difficulty: "MEDIUM", topicKey: "dns" });
      if (!result.ok) {
        expect(result.error).toBe("insufficient_novel_questions");
        refused = true;
        break;
      }
      texts.push(...result.questions.map(item => item.prompt));
    }
    // The DNS paper has one question, so the sources run out after a few tasks instead of repeating one.
    expect(refused).toBe(true);
    expect(texts.length).toBeGreaterThan(0);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("keeps each student's library private and in its course", async () => {
    const mine = await getGeneratedPracticeQuestions(ids.other, ids.courseA);
    const theirs = await getGeneratedPracticeQuestions(ids.student, ids.courseA);
    const otherCourse = await getGeneratedPracticeQuestions(ids.other, ids.courseB);
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.some(item => mine.some(own => own.id === item.id))).toBe(false);
    expect(otherCourse).toEqual([]);
  });
});

describe("US-73: replacing or removing a file leaves no stale links or wrong rankings", () => {
  it("replacing a paper replaces its questions, its rankings, and the practice items generated from it", async () => {
    const file = await paper(ids.courseA, `Replace me ${run}`, "Routing", ["1. Explain distance vector routing and the count to infinity problem."]);
    const generated = await generatePracticeQuestions(ids.other, ids.courseA, { count: 1, difficulty: "MEDIUM", topicKey: "routing" });
    expect(generated.ok).toBe(true);
    const fresh = await db.courseFile.findUniqueOrThrow({ where: { id: file.id } });
    const result = await manageFile(ids.admin, file.id, fresh.updatedAt.toISOString(), {
      operation: "replace", fileName: "new.pdf", bytes: textPdf([["1. Compare link state routing with distance vector routing in large networks."]]),
    });
    expect(result).toMatchObject({ ok: true });
    const questions = await db.question.findMany({ where: { fileId: file.id }, select: { text: true } });
    expect(questions.map(question => question.text).join(" ")).toContain("link state");
    expect(questions.map(question => question.text).join(" ")).not.toContain("count to infinity");
    const exam = await getConsolidatedExam(ids.courseA);
    expect(exam.questions.some(question => question.text.includes("count to infinity"))).toBe(false);
    expect(exam.questions.some(question => question.text.includes("link state"))).toBe(true);
    // The generated item pointed at a question that no longer exists.
    expect(await db.generatedPracticeQuestion.count({ where: { userId: ids.other, courseId: ids.courseA, topicKey: "routing" } })).toBe(0);
  });

  it("removing a paper removes it from the rankings and the paper counts, and leaves no empty question group", async () => {
    const file = await paper(ids.courseA, `Remove me ${run}`, "TCP", ["1. Explain how TCP guarantees reliable delivery of segments."]);
    const before = await getConsolidatedExam(ids.courseA);
    const reliable = before.questions.find(question => question.text.includes("reliable delivery"))!;
    expect(reliable.paperCount).toBe(2);
    const fresh = await db.courseFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(await manageFile(ids.admin, file.id, fresh.updatedAt.toISOString(), { operation: "remove", confirmed: true })).toMatchObject({ ok: true });
    const after = await getConsolidatedExam(ids.courseA);
    expect(after.totalPapers).toBe(before.totalPapers - 1);
    const stillThere = after.questions.find(question => question.text.includes("reliable delivery"))!;
    expect(stillThere.paperCount).toBe(1);
    expect(stillThere.papers.some(entry => JSON.stringify(entry).includes("Remove me"))).toBe(false);
    expect(await db.questionGroup.count({ where: { courseId: ids.courseA, questions: { none: {} } } })).toBe(0);
    // Learning events recorded before keep their history (they do not point at a deleted row).
    expect(await db.learningEvent.count({ where: { userId: ids.student, eventId: `${run}-p1` } })).toBe(1);
  });

  it("refuses a stale page and an unconfirmed removal, changing nothing", async () => {
    const file = await db.courseFile.findFirstOrThrow({ where: { courseId: ids.courseA, title: `DNS final ${run}` } });
    expect(await manageFile(ids.admin, file.id, new Date(0).toISOString(), { operation: "remove", confirmed: true })).toMatchObject({ ok: false, error: "stale" });
    expect(await manageFile(ids.admin, file.id, file.updatedAt.toISOString(), { operation: "remove", confirmed: false })).toMatchObject({ ok: false, error: "confirmation_required" });
    expect(await db.courseFile.count({ where: { id: file.id } })).toBe(1);
  });
});
