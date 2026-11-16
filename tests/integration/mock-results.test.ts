import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getMockResults } from "@/lib/mock-results";

// US-50 against a real, migrated database: the report is built from the stored marking of the student's own exam, an
// unmarked submitted exam is marked first, and nobody else gets the report.

const run = randomUUID().slice(0, 8);
const ids = {} as { faculty: string; course: string; student: string; other: string };
const exam = (id: string, status: "SUBMITTED" | "IN_PROGRESS", markedAt: Date | null, questions: Array<Record<string, unknown>>) => db.mockExam.create({ data: {
  id, userId: ids.student, courseId: ids.course, topicKeys: [], topics: [], length: questions.length, difficulty: "MIXED", status, markedAt,
  submittedAt: status === "SUBMITTED" ? new Date() : null,
  questions: { create: questions.map((question, index) => ({ position: index + 1, text: `Q${index + 1}`, paperCount: 1, totalPapers: 1, sourcePapers: [], ...question })) },
} });

beforeAll(async () => {
  const faculty = await db.faculty.create({ data: { code: `RS${run}`, name: `Faculty ${run}` } });
  const [course, student, other] = await Promise.all([
    db.course.create({ data: { code: `RS${run}`, name: "Results course", facultyId: faculty.id } }),
    db.user.create({ data: { email: `rs-student-${run}@example.com`, passwordHash: "x", name: `Student ${run}` } }),
    db.user.create({ data: { email: `rs-other-${run}@example.com`, passwordHash: "x", name: `Other ${run}` } }),
  ]);
  Object.assign(ids, { faculty: faculty.id, course: course.id, student: student.id, other: other.id });
});

afterAll(async () => {
  await db.course.deleteMany({ where: { id: ids.course } });
  await db.user.deleteMany({ where: { id: { in: [ids.student, ids.other].filter(Boolean) } } });
  if (ids.faculty) await db.faculty.deleteMany({ where: { id: ids.faculty } });
  await db.$disconnect();
});

describe("US-50: mock exam results", () => {
  it("builds the score and topic breakdown from the stored marking", async () => {
    await exam(`rs-marked-${run}`, "SUBMITTED", new Date(), [
      { topic: "TCP", outcome: "CORRECT", matchedPoints: ["a"] },
      { topic: "TCP", outcome: "PARTIAL", matchedPoints: ["a"], missedPoints: ["b", "c"] },
      { topic: "DNS", outcome: "NO_KEY" },
    ]);
    const results = await getMockResults(ids.student, `rs-marked-${run}`);
    if (!results.ok) throw new Error(results.error);
    expect(results.report).toMatchObject({ questions: 3, marked: 2, counts: { CORRECT: 1, PARTIAL: 1, NO_KEY: 1 } });
    expect(results.report.credit).toBeCloseTo((1 + 1 / 3) / 2);
    expect(results.report.topics.map(topic => topic.topic)).toEqual(["TCP", "DNS"]);
    expect(results.report.missed.map(item => item.position)).toEqual([2]);
  });

  it("marks a submitted exam that was not marked yet before building the report", async () => {
    await exam(`rs-unmarked-${run}`, "SUBMITTED", null, [{ topic: "TCP", answer: "x" }, { topic: "TCP" }, { topic: "TCP" }]);
    const results = await getMockResults(ids.student, `rs-unmarked-${run}`);
    if (!results.ok) throw new Error(results.error);
    // No group, so no answer key: nothing is guessed.
    expect(results.report).toMatchObject({ marked: 0, credit: null, counts: { NO_KEY: 3 } });
    expect((await db.mockExam.findUniqueOrThrow({ where: { id: `rs-unmarked-${run}` } })).markedAt).not.toBeNull();
  });

  it("refuses an exam in progress, another student's exam, and an unknown one", async () => {
    await exam(`rs-open-${run}`, "IN_PROGRESS", null, [{}, {}, {}]);
    expect(await getMockResults(ids.student, `rs-open-${run}`)).toEqual({ ok: false, error: "not_submitted" });
    expect(await getMockResults(ids.other, `rs-marked-${run}`)).toEqual({ ok: false, error: "not_found" });
    expect(await getMockResults(ids.student, "nope")).toEqual({ ok: false, error: "not_found" });
  });
});
