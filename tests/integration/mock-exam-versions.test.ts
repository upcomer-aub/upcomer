import { randomUUID } from "node:crypto";
import { FileCategory } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createAlternativeMockExam, getMockExamVersions } from "@/lib/mock-exam-versions";
import { createMockExam, getMockExam } from "@/lib/mock-exams";
import { generatePracticeQuestions } from "@/lib/practice-generation";
import { rebuildQuestionBank } from "@/lib/question-bank";
import { resetRateLimits } from "@/lib/rate-limit";

// US-46 against a real, migrated database, on the real MockExam tables and US-45's createMockExam: an alternative keeps the
// settings and shares no question with the original; version 3 avoids versions 1 and 2; too few unused questions are refused
// with the count; another student's exam is not found; parallel requests never overlap; generated questions are avoided too;
// a regrouped question is still recognised by its text. Every record is created with a unique suffix and deleted in afterAll.

process.env.MOCK_EXAM_RATE_LIMIT_PER_HOUR = "1000";
process.env.PRACTICE_GENERATION_RATE_LIMIT_PER_MINUTE = "1000";
const run = randomUUID().slice(0, 8);
const ids = { faculty: "", course: "", student: "", other: "", tcpPaper: "" };
// Nine TCP questions and three DNS questions, in distinct wording so each is its own group.
const TCP = [
  "State the purpose of the TCP checksum", "Explain how the TCP three way handshake establishes a connection",
  "Describe congestion control in TCP and compare slow start with congestion avoidance", "Explain why TCP needs sequence numbers",
  "Describe how TCP flow control uses the receive window", "Explain fast retransmit after three duplicate acknowledgements",
  "Compute the throughput of a TCP connection with a given window and round trip time", "Explain the TIME_WAIT state when a TCP connection closes",
  "Compare Go-Back-N with Selective Repeat in terms of retransmissions",
];
const DNS = ["Explain iterative DNS resolution", "State the purpose of an MX record", "Describe how DNS caching reduces lookup time"];

beforeAll(async () => {
  resetRateLimits();
  const faculty = await db.faculty.create({ data: { code: `VF${run}`, name: `Faculty ${run}` } });
  const course = await db.course.create({ data: { code: `VC${run}`, name: "Versions course", facultyId: faculty.id } });
  const [student, other] = await Promise.all(["student", "other"].map(name =>
    db.user.create({ data: { email: `ver-${name}-${run}@example.com`, passwordHash: "x", name: `Version ${name} ${run}` } })));
  let tcpPaper = "";
  for (const [title, topic, texts] of [["TCP final", "TCP", TCP], ["DNS final", "DNS", DNS]] as const) {
    const paper = await db.courseFile.create({
      data: { courseId: course.id, title: `${title} ${run}`, originalFileName: `${title}.pdf`, storageKey: `test/${run}/${title}`, category: FileCategory.EXAM, year: 2025, topic },
    });
    if (topic === "TCP") tcpPaper = paper.id;
    await db.question.createMany({ data: texts.map((text, index) => ({ fileId: paper.id, number: index + 1, text })) });
  }
  expect(await rebuildQuestionBank(course.id)).toMatchObject({ ok: true, groupCount: 12 });
  Object.assign(ids, { faculty: faculty.id, course: course.id, student: student.id, other: other.id, tcpPaper });
});

afterAll(async () => {
  await db.course.deleteMany({ where: { id: ids.course } });
  await db.user.deleteMany({ where: { id: { in: [ids.student, ids.other].filter(Boolean) } } });
  if (ids.faculty) await db.faculty.deleteMany({ where: { id: ids.faculty } });
  await db.$disconnect();
});

const original = async (over: Partial<{ length: string; difficulty: string; topics: string[]; includeGenerated: boolean }> = {}) => {
  const result = await createMockExam(ids.student, { courseId: ids.course, length: "3", difficulty: "MIXED", topics: ["tcp"], ...over });
  if (!result.ok) throw new Error(`create failed: ${result.error}`);
  return result.id;
};
const alternative = async (mockExamId: string) => {
  const result = await createAlternativeMockExam(ids.student, mockExamId);
  if (!result.ok) throw new Error(`alternative failed: ${result.error}`);
  return result;
};
const questionsOf = async (mockExamId: string) =>
  db.mockExamQuestion.findMany({ where: { mockExamId }, orderBy: { position: "asc" }, select: { groupId: true, generatedQuestionId: true, text: true, topicKey: true } });

describe("alternative versions (US-46)", () => {
  it("keeps the topics, length and difficulty, and changes every question (acceptance tests 1 and 2)", async () => {
    const first = await original({ difficulty: "HARD" });
    const second = await alternative(first);
    expect(second.version).toBe(2);
    const [a, b] = await Promise.all([getMockExam(ids.student, first), getMockExam(ids.student, second.id)]);
    expect(b).toMatchObject({ courseId: a!.courseId, length: 3, difficulty: "HARD", topics: ["TCP"], includeGenerated: false });
    const [qa, qb] = await Promise.all([questionsOf(first), questionsOf(second.id)]);
    expect(qb).toHaveLength(3);
    expect(qb.every(item => item.topicKey === "tcp")).toBe(true);
    expect(qb.filter(item => qa.some(other => other.groupId === item.groupId || other.text === item.text))).toEqual([]);
    expect(await db.mockExam.findUnique({ where: { id: second.id }, select: { originalId: true } })).toEqual({ originalId: first });
  });

  it("makes version 3 avoid versions 1 and 2, links every version to the original, and refuses a 4th with the count", async () => {
    const first = await original();
    const second = await alternative(first);
    // Asked from version 2, version 3 still belongs to the original's family.
    const third = await alternative(second.id);
    expect(third.version).toBe(3);
    const texts = (await Promise.all([first, second.id, third.id].map(questionsOf))).flat().map(item => item.text);
    expect(new Set(texts).size).toBe(9);
    expect(await db.mockExam.findMany({ where: { id: { in: [second.id, third.id] } }, select: { originalId: true } })).toEqual([{ originalId: first }, { originalId: first }]);
    // All nine TCP questions are used: no unused question is left for a 3-question version.
    expect(await createAlternativeMockExam(ids.student, third.id)).toEqual({ ok: false, error: "not_enough_questions", available: 0, length: 3 });
    expect(await db.mockExam.count({ where: { OR: [{ id: first }, { originalId: first }] } })).toBe(3);
    const versions = await getMockExamVersions(ids.student, third.id);
    expect(await getMockExamVersions(ids.other, third.id)).toEqual({ current: 0, versions: [] });
    expect(versions.current).toBe(3);
    expect(versions.versions.map(item => item.id)).toEqual([first, second.id, third.id]);
  });

  it("refuses with the count of unused questions when some, but too few, are left", async () => {
    const first = await original({ length: "5" });
    expect(await createAlternativeMockExam(ids.student, first)).toEqual({ ok: false, error: "not_enough_questions", available: 4, length: 5 });
  });

  it("treats another student's exam, or an unknown one, as not found and makes nothing", async () => {
    const first = await original();
    const before = await db.mockExam.count({ where: { userId: ids.other } });
    expect(await createAlternativeMockExam(ids.other, first)).toEqual({ ok: false, error: "not_found", available: undefined, length: undefined });
    expect(await createAlternativeMockExam(ids.student, "no-such-exam")).toMatchObject({ ok: false, error: "not_found" });
    expect(await db.mockExam.count({ where: { userId: ids.other } })).toBe(before);
  });

  it("never lets two parallel requests make versions that share a question", async () => {
    const first = await original({ topics: [] });
    const results = await Promise.all([1, 2, 3].map(() => createAlternativeMockExam(ids.student, first)));
    expect(results.every(result => result.ok)).toBe(true);
    const all = (await Promise.all([first, ...results.map(result => (result.ok ? result.id : ""))].map(questionsOf))).flat();
    expect(new Set(all.map(item => item.text)).size).toBe(all.length);
    expect(results.map(result => (result.ok ? result.version : 0)).sort()).toEqual([2, 3, 4]);
  });

  it("recognises a used question by its text after a regroup nulled its stored group", async () => {
    const first = await original({ topics: ["dns"] });
    // Simulate a regroup that replaced the groups: the copies keep their text but lose their group IDs.
    await db.mockExamQuestion.updateMany({ where: { mockExamId: first }, data: { groupId: null } });
    expect(await createAlternativeMockExam(ids.student, first)).toEqual({ ok: false, error: "not_enough_questions", available: 0, length: 3 });
  });

  it("also avoids the student's generated practice questions used by earlier versions", async () => {
    const generated = await generatePracticeQuestions(ids.student, ids.course, { count: 3, difficulty: "EASY", topicKey: "tcp" });
    expect(generated.ok).toBe(true);
    const first = await original({ length: "4", difficulty: "EASY", includeGenerated: true });
    const used = (await questionsOf(first)).filter(item => item.generatedQuestionId);
    expect(used).toHaveLength(2);
    const second = await alternative(first);
    const next = await questionsOf(second.id);
    expect(next).toHaveLength(4);
    expect(next.filter(item => used.some(old => old.generatedQuestionId === item.generatedQuestionId || old.text === item.text))).toEqual([]);
  });
});
