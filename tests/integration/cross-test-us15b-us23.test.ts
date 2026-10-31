import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getConsolidatedExam } from "@/lib/consolidated-exam";
import { rebuildQuestionBank } from "@/lib/question-bank";
import { getReportQueue, reportQuestion } from "@/lib/question-reports";
import { resetRateLimits } from "@/lib/rate-limit";

// Ali Slim's assigned Sprint 3 cross-tests of Ali Shammakh's US-15b and US-23.
// Real database, grouping, ranking and report services; no mocked decisions or writes.
const stamp = `slim-${Date.now().toString(36)}`;
const facultyId = `${stamp}-faculty`;
const students = [`${stamp}-student-a`, `${stamp}-student-b`];
const courses: string[] = [];

async function course() {
  const id = `${stamp}-course-${courses.length}`;
  await db.course.create({ data: { id, code: `SL${courses.length}${Date.now().toString(36)}`.toUpperCase(), name: "Cross-test course", facultyId } });
  courses.push(id);
  return id;
}

async function paper(courseId: string, name: string, texts: string[], status: "PUBLISHED" | "PENDING" = "PUBLISHED") {
  return db.courseFile.create({ data: {
    id: `${courseId}-${name}`, courseId, title: name, year: 2025, category: "EXAM", status,
    originalFileName: "fixture.pdf", storageKey: "fixture.pdf", mimeType: "application/pdf",
    questions: { create: texts.map((text, index) => ({ number: index + 1, text })) },
  } });
}

async function reportedGroup() {
  const courseId = await course();
  await paper(courseId, "a", ["What is the difference between TCP and UDP?"]);
  await paper(courseId, "b", ["Compare TCP and UDP."]);
  expect(await rebuildQuestionBank(courseId)).toMatchObject({ ok: true, groupCount: 1 });
  return { courseId, groupId: (await getConsolidatedExam(courseId)).questions[0].id };
}

beforeAll(async () => {
  await db.faculty.create({ data: { id: facultyId, code: stamp.toUpperCase(), name: "Cross-test faculty" } });
  await db.user.createMany({ data: students.map(id => ({ id, email: `${id}@cross.test`, name: "Cross-test student", passwordHash: "unused" })) });
});
beforeEach(() => resetRateLimits());
afterAll(async () => {
  try {
    await db.course.deleteMany({ where: { id: { in: courses } } });
    await db.user.deleteMany({ where: { id: { in: students } } });
    await db.faculty.deleteMany({ where: { id: facultyId } });
  } finally { await db.$disconnect(); }
});

describe("Ali Slim cross-test: reworded grouping (US-15b)", () => {
  it("groups rewording and changed numerical values, but keeps different questions on the same topic apart", async () => {
    const courseId = await course();
    await paper(courseId, "a", [
      "What is the difference between TCP and UDP?",
      "Calculate the transmission delay of a 1500-byte packet on a 10 Mbps link.",
      "Explain TCP congestion control.",
    ]);
    await paper(courseId, "b", [
      "Compare TCP and UDP.",
      "Find the transmission delay for a 1000 byte packet over a 100 Mbps link.",
      "What is the difference between TCP and IP?",
    ]);
    expect(await rebuildQuestionBank(courseId)).toMatchObject({ ok: true, groupCount: 4, questionCount: 6 });
    const exam = await getConsolidatedExam(courseId);
    expect(exam.questions.map(q => q.paperCount)).toEqual([2, 2, 1, 1]);
    expect(exam.questions.filter(q => q.text.includes("TCP and IP"))).toHaveLength(1);
    expect(exam.questions.filter(q => q.text.includes("congestion control"))).toHaveLength(1);
    const before = exam.questions.map(q => [q.id, q.paperCount, q.position]);
    await rebuildQuestionBank(courseId);
    expect((await getConsolidatedExam(courseId)).questions.map(q => [q.id, q.paperCount, q.position])).toEqual(before);
  });

  it("never combines equal text across courses or counts pending papers", async () => {
    const first = await course();
    const second = await course();
    await paper(first, "a", ["Compare TCP and UDP."]);
    await paper(first, "pending", ["Distinguish between TCP and UDP."], "PENDING");
    await paper(second, "a", ["Compare TCP and UDP."]);
    for (const id of [first, second]) {
      expect(await rebuildQuestionBank(id)).toMatchObject({ ok: true, groupCount: 1, questionCount: 1 });
      expect((await getConsolidatedExam(id)).questions[0].paperCount).toBe(1);
    }
    const groups = await db.questionGroup.findMany({ where: { courseId: { in: [first, second] } } });
    expect(new Set(groups.map(g => g.id)).size).toBe(2);
  });
});

describe("Ali Slim cross-test: question reports (US-23)", () => {
  it("accepts one of five simultaneous duplicate reports and stores the real course and question", async () => {
    const { courseId, groupId } = await reportedGroup();
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => reportQuestion(students[0], { groupId, reason: "WRONG_GROUPING", note: "Please check the grouping." })));
    expect(outcomes.filter(o => o.ok)).toHaveLength(1);
    expect(outcomes.filter(o => !o.ok)).toEqual(Array(4).fill({ ok: false, error: "duplicate" }));
    const reports = await db.questionReport.findMany({ where: { courseId } });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ courseId, groupId, reporterId: students[0], status: "OPEN", questionText: "What is the difference between TCP and UDP?" });
  });

  it("joins two students' reports into one admin item with the course, question and notes", async () => {
    const { courseId, groupId } = await reportedGroup();
    for (const id of students) expect(await reportQuestion(id, { groupId, reason: "WRONG_TEXT", note: "Check the wording." })).toMatchObject({ ok: true, courseId });
    const items = (await getReportQueue()).items.filter(item => item.course.id === courseId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ groupId, paperCount: 2, reasons: [{ reason: "WRONG_TEXT", count: 2 }] });
    expect(items[0].reports).toHaveLength(2);
    expect(items[0].reports.every(report => report.note === "Check the wording.")).toBe(true);
  });

  it("refuses invalid reasons, oversized notes, nonexistent groups and unpublished questions", async () => {
    const { courseId, groupId } = await reportedGroup();
    expect(await reportQuestion(students[0], { groupId, reason: "invented" })).toEqual({ ok: false, error: "invalid_reason" });
    expect(await reportQuestion(students[0], { groupId, reason: "OTHER", note: "x".repeat(501) })).toEqual({ ok: false, error: "note_too_long" });
    expect(await reportQuestion(students[0], { groupId: "missing", reason: "OTHER" })).toEqual({ ok: false, error: "not_found" });
    await db.courseFile.updateMany({ where: { courseId }, data: { status: "PENDING" } });
    expect(await reportQuestion(students[0], { groupId, reason: "OTHER" })).toEqual({ ok: false, error: "not_found" });
    expect(await db.questionReport.count({ where: { courseId } })).toBe(0);
  });

  it("preserves the report snapshot when its question group disappears after a regroup", async () => {
    const { courseId, groupId } = await reportedGroup();
    expect(await reportQuestion(students[0], { groupId, reason: "WRONG_GROUPING" })).toMatchObject({ ok: true });
    await db.courseFile.deleteMany({ where: { courseId } });
    expect(await rebuildQuestionBank(courseId)).toMatchObject({ ok: true, groupCount: 0 });
    const item = (await getReportQueue()).items.find(item => item.course.id === courseId);
    expect(item).toMatchObject({ groupId: null, text: "What is the difference between TCP and UDP?" });
    expect(item?.reports).toHaveLength(1);
  });
});
