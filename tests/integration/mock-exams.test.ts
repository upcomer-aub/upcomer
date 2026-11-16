import { randomUUID } from "node:crypto";
import { FileCategory } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { recordLearningEvents, recordMockOutcomes } from "@/lib/learning-evidence";
import { complexityOf } from "@/lib/mock-exam-rules";
import { createMockExam, finalizeExpiredMockExams, getMockExam, getMockExamOptions, listMyMockExams, saveMockExam, startMockExam } from "@/lib/mock-exams";
import { generatePracticeQuestions, getGeneratedPracticeQuestions } from "@/lib/practice-generation";
import { rebuildQuestionBank } from "@/lib/question-bank";
import { saveTopicConfidence } from "@/lib/topic-confidence";
import { setTopicCovered } from "@/lib/topic-covered";

// Mock exams (US-45) against a real, migrated database, built on the real question bank: papers with topics and questions
// are created, the bank is rebuilt, and exams are generated, sat, and submitted. Every record is created here with a unique
// suffix and deleted in afterAll. The services take the user ID directly, so no session is needed.

// Generating many exams in one run must not hit the per-hour limit (the default is 20).
process.env.MOCK_EXAM_RATE_LIMIT_PER_HOUR = "1000";

const run = randomUUID().slice(0, 8);
const ids = {} as { faculty: string; course: string; emptyCourse: string; student: string; other: string };

const NETWORKING = [
  `State the OSI model layers`,
  `Explain how the TCP three way handshake establishes a connection`,
  `Describe congestion control in TCP and compare slow start with congestion avoidance`,
  `Design a subnetting plan for a company with four departments.\na) Choose the address ranges.\nb) Justify the mask for each department.\nc) Explain how a router would forward traffic between them.`,
];
const DATABASES = [
  `Define a primary key`,
  `Explain the difference between an inner join and an outer join`,
  `Describe how B-tree indexes speed up range queries and what the cost of maintaining them is`,
  `Normalise a relation to third normal form.\na) List the functional dependencies.\nb) Show each decomposition step.\nc) Prove the result is lossless.`,
];

const generate = async (over: Partial<{ courseId: string; length: string; difficulty: string; topics: string[]; includeGenerated: boolean; timeLimit: string }> = {}) =>
  createMockExam(ids.student, { courseId: ids.course, length: "3", difficulty: "MIXED", topics: [], ...over });
const mustGenerate = async (over: Parameters<typeof generate>[0] = {}) => {
  const result = await generate(over);
  if (!result.ok) throw new Error(`generate failed: ${result.error}`);
  return result.id;
};
const examOf = async (id: string) => (await getMockExam(ids.student, id))!;

beforeAll(async () => {
  const faculty = await db.faculty.create({ data: { code: `MF${run}`, name: `Faculty ${run}` } });
  const [course, emptyCourse, student, other] = await Promise.all([
    db.course.create({ data: { code: `MA${run}`, name: "Mock course", facultyId: faculty.id } }),
    db.course.create({ data: { code: `MB${run}`, name: "Empty course", facultyId: faculty.id } }),
    db.user.create({ data: { email: `student-${run}@example.com`, passwordHash: "x", name: `Student ${run}` } }),
    db.user.create({ data: { email: `other-${run}@example.com`, passwordHash: "x", name: `Other ${run}` } }),
  ]);
  for (const [title, topic, texts] of [[`Networks final`, "Networking Basics", NETWORKING], [`Databases final`, "Databases", DATABASES]] as const) {
    const paper = await db.courseFile.create({
      data: { courseId: course.id, title, originalFileName: `${title}.pdf`, storageKey: `test/${run}/${title}`, category: FileCategory.EXAM, year: 2025, topic },
    });
    await db.question.createMany({ data: texts.map((text, index) => ({ fileId: paper.id, number: index + 1, text })) });
  }
  const rebuilt = await rebuildQuestionBank(course.id);
  if (!rebuilt.ok) throw new Error("question bank rebuild failed");
  Object.assign(ids, { faculty: faculty.id, course: course.id, emptyCourse: emptyCourse.id, student: student.id, other: other.id });
});

afterAll(async () => {
  // Mock exams go with their course and user; papers and questions go with their course.
  await db.course.deleteMany({ where: { id: { in: [ids.course, ids.emptyCourse].filter(Boolean) } } });
  await db.user.deleteMany({ where: { id: { in: [ids.student, ids.other].filter(Boolean) } } });
  if (ids.faculty) await db.faculty.deleteMany({ where: { id: ids.faculty } });
  await db.$disconnect();
});

describe("US-45: options", () => {
  it("lists the course's topics with their question counts", async () => {
    const options = await getMockExamOptions(ids.course);
    expect(options.total).toBe(8);
    expect(options.topics).toEqual([{ key: "databases", label: "Databases", count: 4 }, { key: "networking basics", label: "Networking Basics", count: 4 }]);
  });
});

describe("US-45: the exam follows the chosen constraints", () => {
  it("has exactly the length asked for, for every difficulty", async () => {
    for (const length of ["3", "5", "8"]) for (const difficulty of ["EASY", "MEDIUM", "HARD", "MIXED"]) {
      const exam = await examOf(await mustGenerate({ length, difficulty }));
      expect(exam.questions).toHaveLength(Number(length));
      expect(exam.length).toBe(Number(length));
      expect(exam.questions.map(question => question.position)).toEqual(Array.from({ length: Number(length) }, (_, index) => index + 1));
    }
  });

  it("uses only the chosen topics, and stores the settings", async () => {
    const exam = await examOf(await mustGenerate({ topics: ["Networking Basics"], difficulty: "HARD" }));
    expect(exam).toMatchObject({ courseId: ids.course, difficulty: "HARD", topics: ["Networking Basics"], status: "IN_PROGRESS" });
    expect(exam.questions.every(question => question.topic === "Networking Basics")).toBe(true);
    const both = await examOf(await mustGenerate({ topics: ["databases", "networking basics"], length: "8" }));
    expect(both.questions).toHaveLength(8);
  });

  it("picks easier questions for EASY than for HARD", async () => {
    const easy = await examOf(await mustGenerate({ difficulty: "EASY" }));
    const hard = await examOf(await mustGenerate({ difficulty: "HARD" }));
    expect(Math.max(...easy.questions.map(question => complexityOf(question.text)))).toBeLessThanOrEqual(Math.min(...hard.questions.map(question => complexityOf(question.text))));
  });

  it("gives the same questions for the same settings", async () => {
    const first = await examOf(await mustGenerate({ difficulty: "MEDIUM", topics: ["databases"] }));
    const second = await examOf(await mustGenerate({ difficulty: "MEDIUM", topics: ["databases"] }));
    expect(second.questions.map(question => question.text)).toEqual(first.questions.map(question => question.text));
  });

  it("keeps the evidence of each question: its papers and how often it appeared", async () => {
    const exam = await examOf(await mustGenerate({ topics: ["databases"] }));
    for (const question of exam.questions) {
      expect(question).toMatchObject({ paperCount: 1, totalPapers: 2 });
      expect(question.sourcePapers).toEqual(["Databases final (2025)"]);
    }
  });

  it("builds the largest valid exam when asked for more than the topics have, and keeps both lengths", async () => {
    const result = await generate({ topics: ["databases"], length: "5", difficulty: "HARD" });
    expect(result).toMatchObject({ ok: true, length: 4 });
    const exam = await examOf(result.ok ? result.id : "");
    expect(exam).toMatchObject({ length: 4, requestedLength: 5, difficulty: "HARD", topics: ["Databases"] });
    expect(exam.questions).toHaveLength(4);
    expect(exam.questions.every(question => question.topic === "Databases")).toBe(true);
    expect((await examOf(await mustGenerate({ length: "50" })))).toMatchObject({ length: 8, requestedLength: 50 });
    expect((await examOf(await mustGenerate({ length: "3" })))).toMatchObject({ length: 3, requestedLength: 3 });
  });

  it("refuses what the course cannot give, and saves nothing", async () => {
    const before = await db.mockExam.count({ where: { userId: ids.student } });
    expect(await generate({ topics: ["quantum"] })).toMatchObject({ ok: false, error: "topic_invalid" });
    expect(await generate({ length: "2" })).toMatchObject({ ok: false, error: "length_invalid" });
    expect(await generate({ length: "abc" })).toMatchObject({ ok: false, error: "length_invalid" });
    expect(await generate({ difficulty: "IMPOSSIBLE" })).toMatchObject({ ok: false, error: "difficulty_invalid" });
    expect(await generate({ courseId: ids.emptyCourse })).toMatchObject({ ok: false, error: "no_questions" });
    expect(await generate({ courseId: "no-such-course" })).toMatchObject({ ok: false, error: "course_not_found" });
    expect(await db.mockExam.count({ where: { userId: ids.student } })).toBe(before);
  });
});

describe("US-45: the sitting flow", () => {
  it("saves answers, keeps them on reload, and locks them on submit", async () => {
    const id = await mustGenerate({ length: "3" });
    const exam = await examOf(id);
    const [first, second] = exam.questions;
    expect(await saveMockExam(ids.student, id, { [first.id]: "  my first answer ", [second.id]: "second" }, false)).toEqual({ ok: true, submitted: false });
    const reloaded = await examOf(id);
    expect(reloaded.questions.map(question => question.answer)).toEqual(["my first answer", "second", null]);
    expect(reloaded.status).toBe("IN_PROGRESS");

    expect(await saveMockExam(ids.student, id, { [first.id]: "changed", [second.id]: "" }, false)).toEqual({ ok: true, submitted: false });
    expect((await examOf(id)).questions.map(question => question.answer)).toEqual(["changed", null, null]);

    expect(await saveMockExam(ids.student, id, { [first.id]: "final answer" }, true)).toEqual({ ok: true, submitted: true });
    const submitted = await examOf(id);
    expect(submitted.status).toBe("SUBMITTED");
    expect(submitted.submittedAt).not.toBeNull();

    expect(await saveMockExam(ids.student, id, { [first.id]: "too late" }, false)).toEqual({ ok: false, error: "already_submitted" });
    expect(await saveMockExam(ids.student, id, {}, true)).toEqual({ ok: false, error: "already_submitted" });
    expect((await examOf(id)).questions[0].answer).toBe("final answer");
  });

  it("ignores answers for questions of other exams", async () => {
    const mine = await mustGenerate();
    const another = await mustGenerate();
    const foreign = (await examOf(another)).questions[0];
    expect(await saveMockExam(ids.student, mine, { [foreign.id]: "sneaky" }, false)).toEqual({ ok: true, submitted: false });
    expect((await examOf(another)).questions[0].answer).toBeNull();
  });

  it("refuses an answer that is too long", async () => {
    const id = await mustGenerate();
    const [question] = (await examOf(id)).questions;
    expect(await saveMockExam(ids.student, id, { [question.id]: "x".repeat(5001) }, false)).toEqual({ ok: false, error: "answer_too_long" });
  });

  it("counts a line break once, so an answer the browser allowed is saved", async () => {
    const id = await mustGenerate();
    const [question] = (await examOf(id)).questions;
    // 4999 characters as typed; a browser posts each line break as two.
    const posted = Array.from({ length: 2500 }, () => "x").join("\r\n");
    expect(await saveMockExam(ids.student, id, { [question.id]: posted }, false)).toEqual({ ok: true, submitted: false });
    expect((await examOf(id)).questions[0].answer).toHaveLength(4999);
  });

  it("saves every answer of an exam in one go, and leaves unchanged answers alone", async () => {
    const id = await mustGenerate({ length: "8" });
    const exam = await examOf(id);
    const answers = Object.fromEntries(exam.questions.map(question => [question.id, `answer ${question.position}`]));
    expect(await saveMockExam(ids.student, id, answers, false)).toEqual({ ok: true, submitted: false });
    const first = await db.mockExamQuestion.findMany({ where: { mockExamId: id }, orderBy: { position: "asc" }, select: { id: true, answer: true, answeredAt: true } });
    expect(first.map(question => question.answer)).toEqual(exam.questions.map(question => `answer ${question.position}`));
    // Saving again with one answer changed moves only that answer's time.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await saveMockExam(ids.student, id, { ...answers, [first[0].id]: "changed" }, false)).toEqual({ ok: true, submitted: false });
    const second = await db.mockExamQuestion.findMany({ where: { mockExamId: id }, orderBy: { position: "asc" }, select: { answer: true, answeredAt: true } });
    expect(second[0].answer).toBe("changed");
    expect(second[0].answeredAt!.getTime()).toBeGreaterThan(first[0].answeredAt!.getTime());
    expect(second.slice(1)).toEqual(first.slice(1).map(({ answer, answeredAt }) => ({ answer, answeredAt })));
  });

  it("lets only the student see or change their exam", async () => {
    const id = await mustGenerate();
    const [question] = (await examOf(id)).questions;
    expect(await getMockExam(ids.other, id)).toBeNull();
    expect(await saveMockExam(ids.other, id, { [question.id]: "hijack" }, true)).toEqual({ ok: false, error: "not_found" });
    expect((await examOf(id)).status).toBe("IN_PROGRESS");
    expect((await listMyMockExams(ids.other, ids.course))).toEqual([]);
    expect((await listMyMockExams(ids.student, ids.course)).length).toBeGreaterThan(0);
  });

  it("lets only one of two simultaneous submits win", async () => {
    const id = await mustGenerate();
    const results = await Promise.all([saveMockExam(ids.student, id, {}, true), saveMockExam(ids.student, id, {}, true)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, error: "already_submitted" }]);
  });
});

describe("US-45 with US-44: generated practice questions in a mock exam", () => {
  const rowsOf = (id: string) => db.mockExamQuestion.findMany({ where: { mockExamId: id }, orderBy: { position: "asc" } });

  it("records one published source question of its group for every past-paper question", async () => {
    const first = await rowsOf(await mustGenerate({ length: "4" }));
    for (const row of first) {
      expect(row.generatedQuestionId).toBeNull();
      const source = await db.question.findUniqueOrThrow({ where: { id: row.questionId! }, select: { groupId: true, file: { select: { courseId: true, status: true } } } });
      expect(source).toEqual({ groupId: row.groupId, file: { courseId: ids.course, status: "PUBLISHED" } });
    }
    // The same settings record the same source questions.
    const second = await rowsOf(await mustGenerate({ length: "4" }));
    expect(second.map(row => row.questionId)).toEqual(first.map(row => row.questionId));
  });

  it("is past papers only until the student asks, and the form knows how many generated questions they have", async () => {
    expect((await getMockExamOptions(ids.course, ids.student)).generated).toBe(0);
    expect(await generatePracticeQuestions(ids.student, ids.course, { count: 3, difficulty: "EASY", topicKey: "databases" })).toMatchObject({ ok: true });
    expect(await generatePracticeQuestions(ids.other, ids.course, { count: 2, difficulty: "EASY", topicKey: "databases" })).toMatchObject({ ok: true });
    expect((await getMockExamOptions(ids.course, ids.student)).generated).toBe(3);
    expect((await getMockExamOptions(ids.course)).generated).toBe(0);

    const plain = await rowsOf(await mustGenerate({ topics: ["databases"], length: "4", difficulty: "EASY" }));
    expect(plain.every(row => row.generatedQuestionId === null && row.paperCount === 1)).toBe(true);
  });

  it("mixes in up to half of the exam from the student's own generated questions of the chosen topic and difficulty", async () => {
    const mine = await getGeneratedPracticeQuestions(ids.student, ids.course);
    const id = await mustGenerate({ topics: ["databases"], length: "4", difficulty: "EASY", includeGenerated: true });
    const rows = await rowsOf(id);
    expect(rows).toHaveLength(4);
    expect(rows.map(row => row.position)).toEqual([1, 2, 3, 4]);
    const [past, generated] = [rows.filter(row => row.generatedQuestionId === null), rows.filter(row => row.generatedQuestionId !== null)];
    expect(past).toHaveLength(2);
    expect(past.every(row => row.groupId !== null && row.questionId !== null && row.paperCount === 1)).toBe(true);
    // Generated questions come last, are the student's own, and keep their task and their source paper.
    expect(generated.map(row => row.position)).toEqual([3, 4]);
    for (const row of generated) {
      const item = mine.find(candidate => candidate.id === row.generatedQuestionId)!;
      expect(item).toBeDefined();
      expect(row).toMatchObject({ groupId: null, questionId: null, text: item.prompt, topicKey: "databases", paperCount: 0, totalPapers: 2, sourcePapers: ["Databases final"] });
    }
    expect((await db.mockExam.findUniqueOrThrow({ where: { id } })).includeGenerated).toBe(true);
    expect((await examOf(id)).includeGenerated).toBe(true);

    // No generated question matches Networking or HARD, so those exams are past papers only and still exact.
    const hard = await rowsOf(await mustGenerate({ topics: ["databases"], length: "4", difficulty: "HARD", includeGenerated: true }));
    expect(hard).toHaveLength(4);
    expect(hard.every(row => row.generatedQuestionId === null)).toBe(true);
    const networking = await rowsOf(await mustGenerate({ topics: ["networking basics"], length: "3", difficulty: "EASY", includeGenerated: true }));
    expect(networking.every(row => row.generatedQuestionId === null)).toBe(true);
  });

  it("makes an exam longer than the topic's past-paper questions, and never uses another student's generated questions", async () => {
    // Databases has four past-paper questions; the student has three generated EASY ones.
    expect(await generate({ topics: ["databases"], length: "6", difficulty: "EASY" })).toMatchObject({ ok: true, length: 4 });
    // Half of six is three: all three generated questions, and the three simplest past-paper ones.
    const rows = await rowsOf(await mustGenerate({ topics: ["databases"], length: "6", difficulty: "EASY", includeGenerated: true }));
    expect(rows.filter(row => row.generatedQuestionId === null)).toHaveLength(3);
    const used = rows.flatMap(row => (row.generatedQuestionId ? [row.generatedQuestionId] : []));
    expect(used).toHaveLength(3);
    expect(await db.generatedPracticeQuestion.count({ where: { id: { in: used }, userId: ids.student } })).toBe(3);
    // Seven is the longest: all four past-paper questions and the three generated ones.
    expect(await rowsOf(await mustGenerate({ topics: ["databases"], length: "7", difficulty: "EASY", includeGenerated: true }))).toHaveLength(7);
    const longest = await generate({ topics: ["databases"], length: "8", difficulty: "EASY", includeGenerated: true });
    expect(longest).toMatchObject({ ok: true, length: 7 });
    expect(await db.mockExam.findUniqueOrThrow({ where: { id: longest.ok ? longest.id : "" }, select: { length: true, requestedLength: true } })).toEqual({ length: 7, requestedLength: 8 });
  });

  it("gives US-49 what a MOCK_EXAM learning event needs for both kinds of question", async () => {
    const id = await mustGenerate({ topics: ["databases"], length: "4", difficulty: "EASY", includeGenerated: true });
    const rows = await rowsOf(id);
    const past = rows.find(row => row.questionId !== null)!;
    const generated = rows.find(row => row.generatedQuestionId !== null)!;
    // A past-paper item goes through recordLearningEvents with its source question; a generated item through recordMockOutcomes.
    expect(await recordLearningEvents(ids.student, ids.course, [{ source: "MOCK_EXAM", eventId: `${id}:${past.id}`, questionId: past.questionId!, correct: false }]))
      .toEqual({ ok: true, recorded: 1, duplicates: 0 });
    expect(await recordMockOutcomes(ids.student, ids.course, id, [{ itemId: generated.id, generatedQuestionId: generated.generatedQuestionId!, correct: true }]))
      .toEqual({ ok: true, recorded: 1, duplicates: 0 });
    const events = await db.learningEvent.findMany({ where: { userId: ids.student, source: "MOCK_EXAM" }, select: { topicKey: true, correct: true }, orderBy: { correct: "asc" } });
    expect(events).toEqual([{ topicKey: "databases", correct: false }, { topicKey: "databases", correct: true }]);
    // Another student cannot record against this student's generated item.
    expect(await recordMockOutcomes(ids.other, ids.course, id, [{ itemId: generated.id, generatedQuestionId: generated.generatedQuestionId!, correct: true }]))
      .toMatchObject({ ok: false, error: "not_found" });
  });

  it("keeps a generated question's copy when the generated item is deleted", async () => {
    const id = await mustGenerate({ topics: ["databases"], length: "4", difficulty: "EASY", includeGenerated: true });
    const before = (await rowsOf(id)).filter(row => row.generatedQuestionId !== null);
    await db.generatedPracticeQuestion.deleteMany({ where: { id: { in: before.map(row => row.generatedQuestionId!) } } });
    const after = (await rowsOf(id)).filter(row => row.paperCount === 0);
    expect(after.map(row => row.text)).toEqual(before.map(row => row.text));
    expect(after.every(row => row.generatedQuestionId === null)).toBe(true);
  });
});

describe("US-45: the exam stays the same when the question bank changes", () => {
  it("keeps the questions after the source questions are removed and the bank is rebuilt", async () => {
    const id = await mustGenerate({ length: "4", topics: ["databases"] });
    const before = (await examOf(id)).questions.map(question => question.text);
    await db.question.deleteMany({ where: { file: { courseId: ids.course } } });
    await rebuildQuestionBank(ids.course);
    const after = (await examOf(id)).questions;
    expect(after.map(question => question.text)).toEqual(before);
    expect(await db.mockExamQuestion.count({ where: { mockExamId: id, groupId: null } })).toBe(4);
  });
});

// US-47 on its own course: Routing comes up in three of five papers, DNS and Databases in one each. Three students: two
// with different weak topics, and one without a profile here (only in another course).
describe("US-47: mock exams balance weakness and exam importance", () => {
  const weighted = {} as { course: string; first: string; second: string; none: string };
  const PAPERS: Array<[string, string, string[]]> = [
    ["Routing final A", "Routing", ["Compare distance vector and link state routing protocols", "Explain how OSPF elects a designated router on a broadcast segment"]],
    ["Routing final B", "Routing", ["Describe route summarisation and when it causes black holes", "Explain how BGP chooses between several paths to one prefix"]],
    ["Routing final C", "Routing", ["Trace a packet through a static routing table with a default route", "Define administrative distance and give the value for RIP"]],
    ["DNS final", "DNS", ["Explain recursive and iterative name resolution", "Describe how DNS caching uses the TTL field", "List four DNS record types and what each maps"]],
    ["Databases midterm", "Databases", ["Define a foreign key constraint", "Explain two phase locking for transactions", "Describe write ahead logging after a crash"]],
  ];
  const create = (userId: string) => createMockExam(userId, { courseId: weighted.course, length: "6", difficulty: "MIXED", topics: [] });
  // The exam's questions per topic key, and what it stored about its mix.
  const mixOf = async (userId: string) => {
    const result = await create(userId);
    if (!result.ok) throw new Error(`generate failed: ${result.error}`);
    const exam = await db.mockExam.findUniqueOrThrow({ where: { id: result.id }, select: { length: true, mixBasis: true, weakTopics: true, questions: { select: { topicKey: true } } } });
    const counts: Record<string, number> = {};
    for (const question of exam.questions) counts[question.topicKey ?? ""] = (counts[question.topicKey ?? ""] ?? 0) + 1;
    return { counts, mixBasis: exam.mixBasis, weakTopics: exam.weakTopics, length: exam.length };
  };

  beforeAll(async () => {
    const course = await db.course.create({ data: { code: `MW${run}`, name: "Weighted mock course", facultyId: ids.faculty } });
    const users = await Promise.all(["first", "second", "none"].map(name =>
      db.user.create({ data: { email: `${name}-${run}@example.com`, passwordHash: "x", name: `Weighted ${name} ${run}` } })));
    for (const [title, topic, texts] of PAPERS) {
      const paper = await db.courseFile.create({
        data: { courseId: course.id, title, originalFileName: `${title}.pdf`, storageKey: `test/${run}/weighted/${title}`, category: FileCategory.EXAM, year: 2025, topic },
      });
      await db.question.createMany({ data: texts.map((text, index) => ({ fileId: paper.id, number: index + 1, text })) });
    }
    const rebuilt = await rebuildQuestionBank(course.id);
    if (!rebuilt.ok) throw new Error("question bank rebuild failed");
    Object.assign(weighted, { course: course.id, first: users[0].id, second: users[1].id, none: users[2].id });
    // The first student is weak in DNS, the second in Databases (a rating of 1 is weakness 1).
    expect(await saveTopicConfidence(weighted.first, weighted.course, [["rating:dns", "1"]])).toMatchObject({ ok: true });
    expect(await saveTopicConfidence(weighted.second, weighted.course, [["rating:databases", "1"]])).toMatchObject({ ok: true });
    // The third student has a profile only in another course, with a topic key this course also has.
    expect(await saveTopicConfidence(weighted.none, ids.course, [["rating:databases", "1"]])).toMatchObject({ ok: true });
  });

  afterAll(async () => {
    await db.course.deleteMany({ where: { id: weighted.course } });
    await db.user.deleteMany({ where: { id: { in: [weighted.first, weighted.second, weighted.none].filter(Boolean) } } });
  });

  it("represents both the student's weak topic and the course's most frequent topic", async () => {
    const first = await mixOf(weighted.first);
    expect(first.counts.dns).toBeGreaterThanOrEqual(1);
    expect(first.counts.routing).toBeGreaterThanOrEqual(1);
    expect(first).toMatchObject({ mixBasis: "PROFILE", weakTopics: ["DNS"], length: 6 });
  });

  it("gives two students with different profiles different topic mixes for the same course and settings", async () => {
    const [first, second] = [await mixOf(weighted.first), await mixOf(weighted.second)];
    expect(first.counts).toEqual({ routing: 3, dns: 2, databases: 1 });
    expect(second.counts).toEqual({ routing: 3, databases: 2, dns: 1 });
    expect(second).toMatchObject({ mixBasis: "PROFILE", weakTopics: ["Databases"] });
  });

  it("follows exam frequency only for a student without a profile in this course; another course's profile is not read", async () => {
    const none = await mixOf(weighted.none);
    expect(none.counts).toEqual({ routing: 4, databases: 1, dns: 1 });
    expect(none).toMatchObject({ mixBasis: "NO_PROFILE", weakTopics: [] });
  });

  it("gives the same mix again, and a topic marked as covered does not change it", async () => {
    const before = await mixOf(weighted.first);
    expect(await mixOf(weighted.first)).toEqual(before);
    expect(await setTopicCovered(weighted.first, weighted.course, [["topicKey", "dns"], ["covered", "1"]])).toMatchObject({ ok: true });
    expect(await mixOf(weighted.first)).toEqual(before);
  });
});

// US-48 on its own course and students. Time cannot be waited for here, so an exam's deadline is moved in the database:
// the service only ever compares the stored deadline with the server's clock.
describe("US-48: timed mock exams", () => {
  const timer = {} as { course: string; student: string; other: string };
  const TEXTS = [
    "Define what a deadlock is", "Explain the four conditions that are necessary for a deadlock to happen",
    "Describe the banker's algorithm and say when a state is safe", "Compare paging with segmentation for memory management",
    "Explain how a translation lookaside buffer speeds up address translation",
  ];
  const make = async (timeLimit: string | undefined, userId = timer.student) => {
    const result = await createMockExam(userId, { courseId: timer.course, length: "4", difficulty: "MIXED", topics: [], ...(timeLimit && { timeLimit }) });
    if (!result.ok) throw new Error(`generate failed: ${result.error}`);
    return result.id;
  };
  const started = async () => {
    const id = await make("10");
    expect(await startMockExam(timer.student, id)).toEqual({ ok: true, started: true });
    return id;
  };
  const raw = (id: string) => db.mockExam.findUniqueOrThrow({
    where: { id }, select: { status: true, timedOut: true, submittedAt: true, startedAt: true, deadlineAt: true, timeLimitMinutes: true, questions: { orderBy: { position: "asc" }, select: { id: true, text: true, answer: true } } },
  });
  // The deadline as if it had passed `msAgo` ago (negative: still ahead).
  const moveDeadline = async (id: string, msAgo: number) => {
    const deadlineAt = new Date(Date.now() - msAgo);
    await db.mockExam.update({ where: { id }, data: { deadlineAt } });
    return deadlineAt;
  };

  beforeAll(async () => {
    const course = await db.course.create({ data: { code: `MT${run}`, name: "Timed mock course", facultyId: ids.faculty } });
    const [student, other] = await Promise.all(["timed", "timed-other"].map(name =>
      db.user.create({ data: { email: `${name}-${run}@example.com`, passwordHash: "x", name: `Timer ${name} ${run}` } })));
    const paper = await db.courseFile.create({
      data: { courseId: course.id, title: "Operating systems final", originalFileName: "os.pdf", storageKey: `test/${run}/timer/os`, category: FileCategory.EXAM, year: 2025, topic: "Operating Systems" },
    });
    await db.question.createMany({ data: TEXTS.map((text, index) => ({ fileId: paper.id, number: index + 1, text })) });
    const rebuilt = await rebuildQuestionBank(course.id);
    if (!rebuilt.ok) throw new Error("question bank rebuild failed");
    Object.assign(timer, { course: course.id, student: student.id, other: other.id });
  });

  afterAll(async () => {
    await db.course.deleteMany({ where: { id: timer.course } });
    await db.user.deleteMany({ where: { id: { in: [timer.student, timer.other].filter(Boolean) } } });
  });

  it("makes a timed exam with the questions of an untimed one, and does not start its clock", async () => {
    const [plain, timed] = [await raw(await make(undefined)), await raw(await make("10"))];
    expect(plain).toMatchObject({ timeLimitMinutes: null, startedAt: null, deadlineAt: null, timedOut: false });
    expect(timed).toMatchObject({ timeLimitMinutes: 10, startedAt: null, deadlineAt: null, timedOut: false, status: "IN_PROGRESS" });
    expect(timed.questions.map(question => question.text)).toEqual(plain.questions.map(question => question.text));
    expect(await createMockExam(timer.student, { courseId: timer.course, length: "4", difficulty: "MIXED", topics: [], timeLimit: "7" })).toEqual({ ok: false, error: "time_limit_invalid" });
  });

  it("gives no question and accepts no answer before Start", async () => {
    const id = await make("10");
    const exam = (await getMockExam(timer.student, id))!;
    expect(exam).toMatchObject({ locked: true, questions: [], remainingMs: null, length: 4, timeLimitMinutes: 10 });
    const [question] = (await raw(id)).questions;
    expect(await saveMockExam(timer.student, id, { [question.id]: "too early" }, "save")).toEqual({ ok: false, error: "not_started" });
    expect(await saveMockExam(timer.student, id, {}, "submit")).toEqual({ ok: false, error: "not_started" });
    expect((await raw(id)).questions[0].answer).toBeNull();
  });

  it("starts once, from the server's clock: the deadline is the start plus the limit and never moves", async () => {
    const id = await make("10");
    const before = Date.now();
    expect(await startMockExam(timer.other, id)).toEqual({ ok: false, error: "not_found" });
    expect(await startMockExam(timer.student, id)).toEqual({ ok: true, started: true });
    const first = await raw(id);
    expect(first.startedAt!.getTime()).toBeGreaterThanOrEqual(before - 2_000);
    expect(first.startedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 2_000);
    expect(first.deadlineAt!.getTime() - first.startedAt!.getTime()).toBe(10 * 60_000);
    expect(await startMockExam(timer.student, id)).toEqual({ ok: true, started: false });
    expect(await raw(id)).toMatchObject({ startedAt: first.startedAt, deadlineAt: first.deadlineAt });
    // Starting an untimed exam changes nothing.
    const plain = await make(undefined);
    expect(await startMockExam(timer.student, plain)).toEqual({ ok: true, started: false });
    expect(await raw(plain)).toMatchObject({ startedAt: null, deadlineAt: null });
  });

  it("shows the questions and the time left once started, and the time keeps running between reads", async () => {
    const id = await started();
    const first = (await getMockExam(timer.student, id))!;
    expect(first).toMatchObject({ locked: false, status: "IN_PROGRESS" });
    expect(first.questions).toHaveLength(4);
    expect(first.remainingMs!).toBeGreaterThan(9 * 60_000);
    expect(first.remainingMs!).toBeLessThanOrEqual(10 * 60_000);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    // Leaving and coming back: less time left, never more.
    expect((await getMockExam(timer.student, id))!.remainingMs!).toBeLessThanOrEqual(first.remainingMs! - 1_000);
  });

  it("saves while the time runs, and keeps the answers on reload", async () => {
    const id = await started();
    const [first, second] = (await raw(id)).questions;
    const saved = await saveMockExam(timer.student, id, { [first.id]: "saved in time", [second.id]: "also" }, "save");
    expect(saved).toMatchObject({ ok: true, submitted: false });
    expect(saved.ok && saved.remainingMs).toBeGreaterThan(9 * 60_000);
    expect((await getMockExam(timer.student, id))!.questions.map(question => question.answer)).toEqual(["saved in time", "also", null, null]);
  });

  it("refuses a save after the deadline, keeps nothing of it, and finalizes the exam with the answers saved before", async () => {
    const id = await started();
    const [first, second] = (await raw(id)).questions;
    expect(await saveMockExam(timer.student, id, { [first.id]: "saved in time" }, "save")).toMatchObject({ ok: true });
    const deadline = await moveDeadline(id, 60_000);
    expect(await saveMockExam(timer.student, id, { [first.id]: "changed too late", [second.id]: "too late" }, "save")).toEqual({ ok: false, error: "time_up" });
    const after = await raw(id);
    expect(after).toMatchObject({ status: "SUBMITTED", timedOut: true });
    expect(after.submittedAt!.getTime()).toBe(deadline.getTime());
    expect(after.questions.map(question => question.answer)).toEqual(["saved in time", null, null, null]);
    // Still refused, whatever is sent; and the exam reads as timed out with its answers.
    expect(await saveMockExam(timer.student, id, { [second.id]: "again" }, "submit")).toEqual({ ok: false, error: "time_up" });
    expect(await saveMockExam(timer.student, id, { [second.id]: "again" }, "finish")).toEqual({ ok: false, error: "time_up" });
    const view = (await getMockExam(timer.student, id))!;
    expect(view).toMatchObject({ status: "SUBMITTED", timedOut: true, remainingMs: null, locked: false });
    expect(view.questions.map(question => question.answer)).toEqual(["saved in time", null, null, null]);
  });

  it("finalizes an exam whose student never came back, the next time it is read", async () => {
    const id = await started();
    const [first] = (await raw(id)).questions;
    await saveMockExam(timer.student, id, { [first.id]: "typed before leaving" }, "save");
    const deadline = await moveDeadline(id, 3_600_000);
    expect((await raw(id)).status).toBe("IN_PROGRESS");
    // Another student's read does not see it, and does not finalize it.
    expect(await getMockExam(timer.other, id)).toBeNull();
    expect((await raw(id)).status).toBe("IN_PROGRESS");
    const view = (await getMockExam(timer.student, id))!;
    expect(view).toMatchObject({ status: "SUBMITTED", timedOut: true });
    expect(view.submittedAt!.getTime()).toBe(deadline.getTime());
    expect(view.questions[0].answer).toBe("typed before leaving");
  });

  it("finalizes through the list, and for a whole course (what US-49 calls before marking)", async () => {
    const [viaList, viaCourse] = [await started(), await started()];
    await moveDeadline(viaList, 60_000);
    const listed = await listMyMockExams(timer.student, timer.course);
    expect(listed.find(exam => exam.id === viaList)).toMatchObject({ status: "SUBMITTED", timedOut: true, timeLimitMinutes: 10 });
    expect(listed.find(exam => exam.id === viaCourse)).toMatchObject({ status: "IN_PROGRESS", timedOut: false });
    await moveDeadline(viaCourse, 60_000);
    expect(await finalizeExpiredMockExams({ courseId: timer.course })).toEqual([viaCourse]);
    expect(await finalizeExpiredMockExams({ courseId: timer.course })).toEqual([]);
    expect(await raw(viaCourse)).toMatchObject({ status: "SUBMITTED", timedOut: true });
  });

  it("does not finalize inside the grace, and keeps a final save that arrives in it", async () => {
    const id = await started();
    const [first] = (await raw(id)).questions;
    const deadline = await moveDeadline(id, 1_000);
    // One second late is inside the five seconds of grace: reading it changes nothing.
    expect((await getMockExam(timer.student, id))!).toMatchObject({ status: "IN_PROGRESS", remainingMs: 0 });
    expect(await saveMockExam(timer.student, id, { [first.id]: "typed at the last second" }, "finish")).toEqual({ ok: true, submitted: true, timedOut: true, remainingMs: 0 });
    const after = await raw(id);
    expect(after).toMatchObject({ status: "SUBMITTED", timedOut: true });
    expect(after.submittedAt!.getTime()).toBe(deadline.getTime());
    expect(after.questions[0].answer).toBe("typed at the last second");
  });

  it("treats a final save sent early as a save, so a wrong browser clock cannot end the exam", async () => {
    const id = await started();
    const [first] = (await raw(id)).questions;
    expect(await saveMockExam(timer.student, id, { [first.id]: "not yet" }, "finish")).toMatchObject({ ok: true, submitted: false });
    expect(await raw(id)).toMatchObject({ status: "IN_PROGRESS", timedOut: false });
    // The student can still submit: a normal submit, not a timed-out one.
    expect(await saveMockExam(timer.student, id, {}, "submit")).toMatchObject({ ok: true, submitted: true });
    expect(await raw(id)).toMatchObject({ status: "SUBMITTED", timedOut: false });
  });

  it("finalizes an exam exactly once when several requests arrive together", async () => {
    const id = await started();
    const [first] = (await raw(id)).questions;
    await moveDeadline(id, 60_000);
    const results = await Promise.all([
      finalizeExpiredMockExams({ mockExamId: id }), finalizeExpiredMockExams({ userId: timer.student, mockExamId: id }),
      saveMockExam(timer.student, id, { [first.id]: "late" }, "save"), getMockExam(timer.student, id),
    ]);
    expect([...results[0], ...results[1]].length).toBeLessThanOrEqual(1);
    expect(results[2]).toEqual({ ok: false, error: "time_up" });
    expect(await raw(id)).toMatchObject({ status: "SUBMITTED", timedOut: true, questions: expect.arrayContaining([expect.objectContaining({ answer: null })]) });
    expect((await raw(id)).questions.every(question => question.answer === null)).toBe(true);
  });

  it("leaves untimed exams exactly as they were", async () => {
    const id = await make(undefined);
    const [first] = (await raw(id)).questions;
    expect(await saveMockExam(timer.student, id, { [first.id]: "no clock" }, "finish")).toEqual({ ok: true, submitted: false });
    expect(await finalizeExpiredMockExams({ userId: timer.student })).toEqual([]);
    expect((await getMockExam(timer.student, id))!).toMatchObject({ status: "IN_PROGRESS", locked: false, remainingMs: null, timedOut: false });
    expect(await saveMockExam(timer.student, id, {}, true)).toEqual({ ok: true, submitted: true });
  });
});
