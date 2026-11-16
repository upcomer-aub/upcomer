import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { rebuildQuestionBank, getQuestionBank } from "@/lib/question-bank";
import { getConsolidatedExam } from "@/lib/consolidated-exam";
import { correctQuestion, getCorrectionPage } from "@/lib/question-corrections";
import { processExamFile } from "@/lib/exam-processing";
import { generatePracticeQuestions, getGeneratedPracticeQuestions } from "@/lib/practice-generation";
import { recordPracticeOutcome } from "@/lib/learning-evidence";
import { resetRateLimits } from "@/lib/rate-limit";

const stamp = `content-${randomUUID().slice(0, 8)}`;
let facultyId: string;
let courseId: string;
let adminId: string;
let studentId: string;
let fileId: string;
let questionId: string;
let ruleId: string;

beforeAll(async () => {
  resetRateLimits();
  facultyId = (await db.faculty.create({ data: { code: stamp, name: "Content filtering" } })).id;
  courseId = (await db.course.create({ data: { code: stamp, name: "Content filtering", facultyId } })).id;
  adminId = (await db.user.create({ data: { email: `${stamp}-admin@test.invalid`, name: "Filter admin", passwordHash: "x", role: "ADMIN" } })).id;
  studentId = (await db.user.create({ data: { email: `${stamp}-student@test.invalid`, name: "Filter student", passwordHash: "x" } })).id;
  for (let i = 0; i < 2; i++) {
    const file = await db.courseFile.create({ data: { courseId, title: `Paper ${i}`, category: "EXAM", topic: "TCP", year: 2025 - i, originalFileName: "paper.pdf", storageKey: `${stamp}-${i}.pdf`, mimeType: "application/pdf" } });
    const rule = await db.question.create({ data: { fileId: file.id, number: 1, text: "1. This is an open book exam" } });
    if (i === 0) {
      fileId = file.id; ruleId = rule.id;
      questionId = (await db.question.create({ data: { fileId, number: 2, text: "2. Explain TCP flow control.\nTime allowed: 90 minutes\nGood luck!" } })).id;
    }
  }
});

afterAll(async () => {
  if (courseId) await db.course.deleteMany({ where: { id: courseId } });
  if (facultyId) await db.faculty.deleteMany({ where: { id: facultyId } });
  await db.user.deleteMany({ where: { id: { in: [adminId, studentId].filter(Boolean) } } });
  await db.$disconnect();
});

describe("legacy question cleanup and persistent exclusion", () => {
  it("counts usable pending questions before their first grouping", async () => {
    const bank = await getQuestionBank(courseId);
    expect(bank.totalPapers).toBe(2);
    expect(bank.groups).toEqual([]);
    const exam = await getConsolidatedExam(courseId);
    expect(exam.totalPapers).toBe(2);
    expect(exam.questions).toEqual([]);
  });

  it("cleans legacy text and ranks real questions, retaining excluded source records for review", async () => {
    expect(await rebuildQuestionBank(courseId)).toMatchObject({ ok: true, groupCount: 1, questionCount: 3 });
    expect((await getQuestionBank(courseId)).totalPapers).toBe(1);
    expect((await getConsolidatedExam(courseId)).totalPapers).toBe(1);
    expect((await getQuestionBank(courseId)).groups.map(group => group.text)).toEqual(["Explain TCP flow control."]);
    expect((await getConsolidatedExam(courseId)).questions.map(question => question.text)).toEqual(["Explain TCP flow control."]);
    expect(await db.question.findUniqueOrThrow({ where: { id: questionId } })).toMatchObject({ text: "2. Explain TCP flow control." });
    expect(await db.question.findUniqueOrThrow({ where: { id: ruleId } })).toMatchObject({ groupId: null, excludedFromBank: true, text: "1. This is an open book exam" });
    expect((await getCorrectionPage(courseId))?.ungrouped.some(question => question.id === ruleId)).toBe(true);
  });

  it("excludes a source from ranking, generation and new evidence, without deleting its history", async () => {
    const generated = await generatePracticeQuestions(studentId, courseId, { count: 1, difficulty: "EASY" });
    expect(generated.ok).toBe(true);
    expect(await recordPracticeOutcome(studentId, courseId, { eventId: "before-exclusion", questionId, outcome: "CORRECT" })).toMatchObject({ ok: true });
    expect(await correctQuestion(adminId, courseId, { kind: "exclude", questionId })).toEqual({ ok: true, regrouped: true });
    expect((await getQuestionBank(courseId)).groups).toEqual([]);
    expect(await getGeneratedPracticeQuestions(studentId, courseId)).toEqual([]);
    expect(await recordPracticeOutcome(studentId, courseId, { eventId: "after-exclusion", questionId, outcome: "INCORRECT" })).toEqual({ ok: false, error: "not_found" });
    expect(await db.learningEvent.count({ where: { userId: studentId, eventId: "before-exclusion" } })).toBe(1);
    expect(await db.questionCorrection.findFirst({ where: { questionId, kind: "EXCLUDE" } })).toMatchObject({ adminId });
    expect(await db.question.findUniqueOrThrow({ where: { id: questionId } })).toMatchObject({ excludedFromBank: true });
    // A normal processing retry keeps existing rows: the exclusion must survive it.
    expect(await processExamFile(fileId)).toMatchObject({ ok: true });
    expect((await getConsolidatedExam(courseId)).questions).toEqual([]);
    expect(await correctQuestion(adminId, courseId, { kind: "exclude", questionId })).toEqual({ ok: false, error: "already_excluded" });
    expect(await correctQuestion(adminId, `${courseId}-wrong`, { kind: "restore", questionId })).toEqual({ ok: false, error: "not_found" });
  });

  it("restores a valid entry and keeps the exclusion/restore audit trail", async () => {
    expect(await correctQuestion(adminId, courseId, { kind: "restore", questionId })).toEqual({ ok: true, regrouped: true });
    expect((await getQuestionBank(courseId)).groups).toHaveLength(1);
    expect(await getGeneratedPracticeQuestions(studentId, courseId)).toHaveLength(1);
    expect(await db.questionCorrection.count({ where: { questionId, kind: { in: ["EXCLUDE", "RESTORE"] } } })).toBe(2);
    expect(await correctQuestion(adminId, courseId, { kind: "restore", questionId })).toEqual({ ok: false, error: "not_excluded" });
  });

  it("leaves admin-edited source text intact when cleaning an old paper", async () => {
    const text = "3. Explain this exam policy.\nGood luck!";
    const corrected = await db.question.create({ data: { fileId, number: 3, text, textCorrectedAt: new Date() } });
    expect(await rebuildQuestionBank(courseId)).toMatchObject({ ok: true });
    expect((await db.question.findUniqueOrThrow({ where: { id: corrected.id } })).text).toBe(text);
  });
});
