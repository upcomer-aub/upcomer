import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// US-24 against a real database: ratings saved for one course never change another course's profile, Skip gives the
// neutral default without overwriting a weakness written by other code, tampered input saves nothing, and a failed write
// rolls the whole save back. setTopicWeakness is the real one; a test can make one topic's write fail.

const failure = vi.hoisted(() => ({ topic: null as string | null }));
vi.mock("@/lib/learning-profile", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/learning-profile")>();
  return {
    ...real,
    setTopicWeakness: (...args: Parameters<typeof real.setTopicWeakness>) =>
      args[2] === failure.topic ? Promise.resolve({ ok: false, error: "unexpected" }) : real.setTopicWeakness(...args),
  };
});
import { db } from "@/lib/db";
import { NEUTRAL_WEAKNESS, setTopicWeakness } from "@/lib/learning-profile";
import { resetRateLimits } from "@/lib/rate-limit";
import { getTopicConfidence, saveTopicConfidence } from "@/lib/topic-confidence";

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const faculty = { id: `it-tc-faculty-${stamp}`, code: `ITF${stamp}`.toUpperCase().slice(0, 20), name: "Confidence Faculty" };
const courses = ["a", "b"].map(name => ({ id: `it-tc-${name}-${stamp}`, code: `ITC${name}${stamp}`.toUpperCase().slice(0, 20), name: `Confidence ${name}`, facultyId: faculty.id }));
const [courseA, courseB] = courses.map(course => course.id);
const students = ["one", "two"].map(name => `it-tc-${name}-${stamp}`);
// Course A's papers are about TCP, Routing, and DNS; course B's about TCP (the same name) and Compilers.
const paperTopics: Array<[string, string]> = [[courseA, "TCP"], [courseA, "Routing"], [courseA, "DNS"], [courseB, "TCP"], [courseB, "Compilers"]];

const rowsOf = (userId: string, courseId: string) =>
  db.learningTopic.findMany({ where: { userId, courseId }, orderBy: { topicKey: "asc" }, select: { topicKey: true, weakness: true, confidence: true } });
const form = (ratings: Record<string, string>): Array<[string, string]> => Object.entries(ratings).map(([key, value]) => [`rating:${key}`, value]);

beforeAll(async () => {
  await db.faculty.create({ data: faculty });
  await db.course.createMany({ data: courses });
  await db.user.createMany({ data: students.map(id => ({ id, email: `${id}@confidence.test`, name: "Confidence Student", passwordHash: "x" })) });
  for (const [index, [courseId, topic]] of paperTopics.entries()) {
    await db.courseFile.create({ data: {
      id: `${courseId}-p${index}`, courseId, title: `Exam ${index}`, year: 2020 + index, topic, examType: "FINAL", category: "EXAM",
      originalFileName: "exam.pdf", storageKey: "exam.pdf", mimeType: "application/pdf",
    } });
  }
});
beforeEach(() => {
  resetRateLimits();
  failure.topic = null;
});
afterAll(async () => {
  try {
    // Deleting the users and the courses deletes their profile rows and papers.
    await db.user.deleteMany({ where: { id: { in: students } } });
    await db.course.deleteMany({ where: { id: { in: courses.map(course => course.id) } } });
    await db.faculty.deleteMany({ where: { id: faculty.id } });
    expect(await db.learningTopic.count({ where: { userId: { in: students } } })).toBe(0);
  } finally {
    await db.$disconnect();
  }
});

describe("topic confidence (US-24)", () => {
  it("saves ratings as weakness with the rating, and leaves another course's profile unchanged", async () => {
    const [student] = students;
    expect(await saveTopicConfidence(student, courseB, form({ tcp: "4", compilers: "2" }))).toMatchObject({ ok: true, rated: 2 });
    const before = await rowsOf(student, courseB);
    expect(before).toEqual([{ topicKey: "compilers", weakness: 0.75, confidence: 2 }, { topicKey: "tcp", weakness: 0.25, confidence: 4 }]);

    expect(await saveTopicConfidence(student, courseA, form({ tcp: "1", routing: "5", dns: "skip" }))).toEqual({ ok: true, rated: 2, skipped: 1, unchanged: 0 });
    expect(await rowsOf(student, courseA)).toEqual([
      { topicKey: "dns", weakness: NEUTRAL_WEAKNESS, confidence: null },
      { topicKey: "routing", weakness: 0, confidence: 5 },
      { topicKey: "tcp", weakness: 1, confidence: 1 },
    ]);
    expect(await rowsOf(student, courseB)).toEqual(before);
    expect(await getTopicConfidence(student, courseA)).toEqual(new Map([["dns", null], ["routing", 5], ["tcp", 1]]));
  });

  it("on Skip, keeps a weakness written by other code, writes the neutral default for a new topic, and clears an earlier rating", async () => {
    const student = students[1];
    // Written the way US-25 will write it: a weakness without a rating.
    expect(await setTopicWeakness(student, courseA, "Routing", 0.8)).toEqual({ ok: true });
    expect(await getTopicConfidence(student, courseA)).toEqual(new Map([["routing", null]]));

    expect(await saveTopicConfidence(student, courseA, form({ routing: "skip", tcp: "skip" }))).toEqual({ ok: true, rated: 0, skipped: 1, unchanged: 1 });
    expect(await rowsOf(student, courseA)).toEqual([
      { topicKey: "routing", weakness: 0.8, confidence: null },
      { topicKey: "tcp", weakness: NEUTRAL_WEAKNESS, confidence: null },
    ]);

    // Rated, then skipped again: the student is clearing their own rating, so it goes back to the neutral default.
    await saveTopicConfidence(student, courseA, form({ routing: "2" }));
    expect((await rowsOf(student, courseA))[0]).toEqual({ topicKey: "routing", weakness: 0.75, confidence: 2 });
    await saveTopicConfidence(student, courseA, form({ routing: "skip" }));
    expect((await rowsOf(student, courseA))[0]).toEqual({ topicKey: "routing", weakness: NEUTRAL_WEAKNESS, confidence: null });
  });

  it("refuses tampered input and saves nothing, including a topic of another course", async () => {
    const [student] = students;
    const before = await rowsOf(student, courseA);
    expect(await saveTopicConfidence(student, courseA, form({ tcp: "3", compilers: "1" }))).toEqual({ ok: false, error: "unknown_topic" });
    expect(await saveTopicConfidence(student, courseA, form({ tcp: "3", dns: "7" }))).toEqual({ ok: false, error: "invalid_rating" });
    expect(await rowsOf(student, courseA)).toEqual(before);
    expect(await db.learningTopic.count({ where: { userId: student, courseId: courseA, topicKey: "compilers" } })).toBe(0);
  });

  it("rolls the whole save back when one write fails", async () => {
    const [student] = students;
    const before = await rowsOf(student, courseA);
    failure.topic = "DNS";
    // TCP and Routing are written first in the same transaction; DNS fails, so neither is kept.
    expect(await saveTopicConfidence(student, courseA, form({ tcp: "3", routing: "3", dns: "3" }))).toEqual({ ok: false, error: "unexpected" });
    expect(await rowsOf(student, courseA)).toEqual(before);
  });
});
