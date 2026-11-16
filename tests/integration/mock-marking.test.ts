import { randomUUID } from "node:crypto";
import { FileCategory } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createMockExam, getMockExam, saveMockExam } from "@/lib/mock-exams";
import { markMockExam, mockEventId, saveAnswerKey } from "@/lib/mock-marking";
import { rebuildQuestionBank } from "@/lib/question-bank";
import { resetRateLimits } from "@/lib/rate-limit";

// Marking mock exams (US-49) against a real, migrated database and the real question bank: papers are created, the bank is
// rebuilt, an admin writes answer keys for some questions, and a student's exam is generated, answered, submitted and
// marked. Records are created with a unique suffix and deleted in afterAll.

process.env.MOCK_EXAM_RATE_LIMIT_PER_HOUR = "1000";
process.env.ANSWER_KEY_RATE_LIMIT_PER_MINUTE = "1000";

const run = randomUUID().slice(0, 8);
const ids = {} as { faculty: string; course: string; otherCourse: string; student: string; other: string; admin: string };
const QUESTIONS = [
  "Explain how the TCP three way handshake establishes a connection",
  "Describe congestion control in TCP and compare slow start with congestion avoidance",
  "State the OSI model layers",
];

// The question bank's group of a question, found by its text.
const groupOf = async (text: string) => (await db.questionGroup.findFirstOrThrow({ where: { courseId: ids.course, text } })).id;
const newExam = async (userId = ids.student) => {
  const result = await createMockExam(userId, { courseId: ids.course, length: "3", difficulty: "MIXED", topics: [] });
  if (!result.ok) throw new Error(`generate failed: ${result.error}`);
  return (await getMockExam(userId, result.id))!;
};
const answer = (exam: Awaited<ReturnType<typeof newExam>>, byText: Record<string, string>) =>
  Object.fromEntries(exam.questions.map(question => [question.id, byText[question.text] ?? ""]));
const stored = (mockExamId: string) => db.mockExamQuestion.findMany({ where: { mockExamId }, orderBy: { position: "asc" } });

beforeAll(async () => {
  const faculty = await db.faculty.create({ data: { code: `MK${run}`, name: `Faculty ${run}` } });
  const [course, otherCourse, student, other, admin] = await Promise.all([
    db.course.create({ data: { code: `MK${run}`, name: "Marking course", facultyId: faculty.id } }),
    db.course.create({ data: { code: `MO${run}`, name: "Other course", facultyId: faculty.id } }),
    db.user.create({ data: { email: `mk-student-${run}@example.com`, passwordHash: "x", name: `Student ${run}` } }),
    db.user.create({ data: { email: `mk-other-${run}@example.com`, passwordHash: "x", name: `Other ${run}` } }),
    db.user.create({ data: { email: `mk-admin-${run}@example.com`, passwordHash: "x", name: `Admin ${run}`, role: "ADMIN" } }),
  ]);
  const paper = await db.courseFile.create({
    data: { courseId: course.id, title: "Networks final", originalFileName: "n.pdf", storageKey: `test/${run}/n`, category: FileCategory.EXAM, year: 2025, topic: "Networking" },
  });
  await db.question.createMany({ data: QUESTIONS.map((text, index) => ({ fileId: paper.id, number: index + 1, text })) });
  const rebuilt = await rebuildQuestionBank(course.id);
  if (!rebuilt.ok) throw new Error("question bank rebuild failed");
  Object.assign(ids, { faculty: faculty.id, course: course.id, otherCourse: otherCourse.id, student: student.id, other: other.id, admin: admin.id });
  resetRateLimits();
  // Keys for the first two questions only; the third has none.
  for (const [text, keyPoints] of [[QUESTIONS[0], "SYN, SYN-ACK, ACK\nsequence numbers are synchronised"], [QUESTIONS[1], "slow start\ncongestion avoidance"]] as const) {
    const saved = await saveAnswerKey(ids.admin, { courseId: ids.course, groupId: await groupOf(text), keyPoints, explanation: "See lecture 4." });
    if (!saved.ok) throw new Error(`key failed: ${saved.error}`);
  }
});

afterAll(async () => {
  await db.course.deleteMany({ where: { id: { in: [ids.course, ids.otherCourse].filter(Boolean) } } });
  await db.user.deleteMany({ where: { id: { in: [ids.student, ids.other, ids.admin].filter(Boolean) } } });
  if (ids.faculty) await db.faculty.deleteMany({ where: { id: ids.faculty } });
  await db.$disconnect();
});

describe("US-49: marking against answer keys", () => {
  it("marks each answer by its key, flags the question with no key, and explains the mistakes", async () => {
    const exam = await newExam();
    await saveMockExam(ids.student, exam.id, answer(exam, {
      [QUESTIONS[0]]: "SYN then SYN-ACK then ACK, and both sides synchronise sequence numbers.",
      [QUESTIONS[1]]: "TCP uses slow start.",
      [QUESTIONS[2]]: "Physical, data link, network, transport, session, presentation, application.",
    }), true);
    const result = await markMockExam(ids.student, exam.id);
    expect(result).toMatchObject({ ok: true, marked: true, counts: { CORRECT: 1, PARTIAL: 1, INCORRECT: 0, UNANSWERED: 0, NO_KEY: 1 } });
    const rows = new Map((await stored(exam.id)).map(row => [row.text, row]));
    expect(rows.get(QUESTIONS[0])).toMatchObject({ outcome: "CORRECT", missedPoints: [] });
    expect(rows.get(QUESTIONS[1])).toMatchObject({ outcome: "PARTIAL", matchedPoints: ["slow start"], missedPoints: ["congestion avoidance"] });
    expect(rows.get(QUESTIONS[1])!.feedback).toContain('Your answer does not cover: "congestion avoidance".');
    expect(rows.get(QUESTIONS[2])).toMatchObject({ outcome: "NO_KEY", matchedPoints: [], missedPoints: [] });
    expect((await db.mockExam.findUniqueOrThrow({ where: { id: exam.id } })).markedAt).not.toBeNull();
  });

  it("records one MOCK_EXAM learning event per marked past-paper question, none for the unkeyed one, and none twice", async () => {
    const exam = await newExam();
    await saveMockExam(ids.student, exam.id, answer(exam, { [QUESTIONS[0]]: "SYN SYN-ACK ACK, sequence numbers synchronised" }), true);
    const first = await markMockExam(ids.student, exam.id);
    expect(first).toMatchObject({ ok: true, eventsRecorded: 2, eventsSkipped: 0 });
    const events = await db.learningEvent.findMany({ where: { userId: ids.student, source: "MOCK_EXAM", eventId: { startsWith: `mock:${exam.id}:` } } });
    expect(events).toHaveLength(2);
    const byQuestion = new Map((await stored(exam.id)).map(row => [row.position, row]));
    for (const event of events) {
      const position = Number(event.eventId.split(":")[2]);
      expect(event.eventId).toBe(mockEventId(exam.id, position));
      expect(event.correct).toBe(byQuestion.get(position)!.outcome === "CORRECT");
    }
    // Marking again changes nothing and adds no event.
    expect(await markMockExam(ids.student, exam.id)).toMatchObject({ ok: true, marked: false });
    expect(await db.learningEvent.count({ where: { userId: ids.student, eventId: { startsWith: `mock:${exam.id}:` } } })).toBe(2);
  });

  it("marks an exam once when two requests mark it at the same time", async () => {
    const exam = await newExam();
    await saveMockExam(ids.student, exam.id, answer(exam, {}), true);
    const results = await Promise.all([markMockExam(ids.student, exam.id), markMockExam(ids.student, exam.id), markMockExam(ids.student, exam.id)]);
    expect(results.filter(result => result.ok && result.marked)).toHaveLength(1);
    expect((await stored(exam.id)).map(row => row.outcome).sort()).toEqual(["NO_KEY", "UNANSWERED", "UNANSWERED"]);
  });

  it("refuses an exam that is not submitted, and another student's exam, marking nothing", async () => {
    const exam = await newExam();
    expect(await markMockExam(ids.student, exam.id)).toEqual({ ok: false, error: "not_submitted" });
    await saveMockExam(ids.student, exam.id, answer(exam, {}), true);
    expect(await markMockExam(ids.other, exam.id)).toEqual({ ok: false, error: "not_found" });
    expect((await stored(exam.id)).every(row => row.outcome === null)).toBe(true);
  });

  it("keeps a marked exam's marking when the answer key changes later", async () => {
    const exam = await newExam();
    await saveMockExam(ids.student, exam.id, answer(exam, { [QUESTIONS[1]]: "slow start and congestion avoidance" }), true);
    await markMockExam(ids.student, exam.id);
    const group = await groupOf(QUESTIONS[1]);
    await saveAnswerKey(ids.admin, { courseId: ids.course, groupId: group, keyPoints: "fast retransmit", explanation: "" });
    const row = (await stored(exam.id)).find(item => item.text === QUESTIONS[1])!;
    expect(row).toMatchObject({ outcome: "CORRECT", matchedPoints: ["slow start", "congestion avoidance"] });
    // Put the key back for the other tests.
    await saveAnswerKey(ids.admin, { courseId: ids.course, groupId: group, keyPoints: "slow start\ncongestion avoidance", explanation: "See lecture 4." });
  });

  it("marks a question NO_KEY after its key is removed", async () => {
    const group = await groupOf(QUESTIONS[0]);
    expect(await saveAnswerKey(ids.admin, { courseId: ids.course, groupId: group, keyPoints: "", explanation: "", remove: true })).toEqual({ ok: true, removed: true });
    const exam = await newExam();
    await saveMockExam(ids.student, exam.id, answer(exam, { [QUESTIONS[0]]: "SYN SYN-ACK ACK" }), true);
    await markMockExam(ids.student, exam.id);
    expect((await stored(exam.id)).find(item => item.text === QUESTIONS[0])!.outcome).toBe("NO_KEY");
    await saveAnswerKey(ids.admin, { courseId: ids.course, groupId: group, keyPoints: "SYN, SYN-ACK, ACK\nsequence numbers are synchronised", explanation: "See lecture 4." });
  });
});

describe("US-49: answer keys", () => {
  it("saves a key only for a question group of the given course", async () => {
    const group = await groupOf(QUESTIONS[2]);
    expect(await saveAnswerKey(ids.admin, { courseId: ids.otherCourse, groupId: group, keyPoints: "x", explanation: "" })).toEqual({ ok: false, error: "not_found" });
    expect(await db.answerKey.count({ where: { groupId: group } })).toBe(0);
  });

  it("refuses an empty key and stores nothing", async () => {
    const group = await groupOf(QUESTIONS[2]);
    expect(await saveAnswerKey(ids.admin, { courseId: ids.course, groupId: group, keyPoints: " \n ", explanation: "" })).toEqual({ ok: false, error: "points_required" });
    expect(await db.answerKey.count({ where: { groupId: group } })).toBe(0);
  });
});
