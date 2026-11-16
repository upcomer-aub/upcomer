import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishAdvice, type PublishInput } from "@/lib/advice";
import { setAdviceHelpful } from "@/lib/advice-votes";
import { getConsolidatedExam } from "@/lib/consolidated-exam";
import { db } from "@/lib/db";
import { setTopicWeakness } from "@/lib/learning-profile";
import { buildPool } from "@/lib/mock-exams";
import { getPersonalOrder } from "@/lib/personal-order";
import { getPracticeSet } from "@/lib/practice-set";
import { getQuestionBank, rebuildQuestionBank } from "@/lib/question-bank";
import { resetRateLimits } from "@/lib/rate-limit";
import { getStudyNext } from "@/lib/study-next";

// US-42, acceptance test 2: advice never appears inside the rankings or counts. Every exam-statistics read (the Upcomer
// Exam, the question bank, the personal order, the study-next pick, the weak-topic practice set, and the mock-exam pool) is
// taken before and after publishing advice in all five scopes (one of them anonymous, one repeating a real question word for
// word), marking it helpful, and regrouping the course. The results must be identical and contain no advice text.

process.env.ADVICE_RATE_LIMIT_PER_HOUR = "1000";
const run = randomUUID().slice(0, 8);
const marker = `ADVICE-ONLY-${run}`;
const ids = { faculty: "", course: "", term: "", author: "", reader: "", papers: [] as string[] };
const questions = [
  "Explain the TCP three-way handshake.", "Describe TCP slow start.", "What is a DNS MX record?", "How does DNS caching work?",
];

beforeAll(async () => {
  resetRateLimits();
  const faculty = await db.faculty.create({ data: { code: `FS${run}`, name: `Faculty ${run}` } });
  const course = await db.course.create({ data: { code: `SEP${run}`, name: "Separation", facultyId: faculty.id } });
  const term = await db.term.create({ data: { name: `Spring ${run}` } });
  const [author, reader] = await Promise.all(["author", "reader"].map(name =>
    db.user.create({ data: { email: `sep-${name}-${run}@example.com`, passwordHash: "x", name: `Sep ${name} ${run}` } })));
  const papers: Array<[string, string, string[]]> = [["p1", "TCP", questions.slice(0, 2)], ["p2", "TCP", questions.slice(0, 2)], ["p3", "DNS", questions.slice(2)]];
  for (const [name, topic, texts] of papers) {
    const file = await db.courseFile.create({ data: {
      courseId: course.id, title: `Paper ${name} ${run}`, category: "EXAM", year: 2024, topic, termId: term.id,
      originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf",
      questions: { create: texts.map((text, index) => ({ number: index + 1, text })) },
    } });
    ids.papers.push(file.id);
  }
  Object.assign(ids, { faculty: faculty.id, course: course.id, term: term.id, author: author.id, reader: reader.id });
  expect(await rebuildQuestionBank(course.id)).toMatchObject({ ok: true, groupCount: 4 });
  expect(await setTopicWeakness(reader.id, course.id, "DNS", 1)).toEqual({ ok: true });
});

afterAll(async () => {
  await db.course.deleteMany({ where: { id: ids.course } });
  await db.user.deleteMany({ where: { id: { in: [ids.author, ids.reader].filter(Boolean) } } });
  if (ids.term) await db.term.deleteMany({ where: { id: ids.term } });
  if (ids.faculty) await db.faculty.deleteMany({ where: { id: ids.faculty } });
  await db.$disconnect();
});

// Every exam-statistics read a student can see, for one course and one student.
async function statistics() {
  const exam = await getConsolidatedExam(ids.course);
  const [bank, personal, next, practice, pool, groups] = await Promise.all([
    getQuestionBank(ids.course), getPersonalOrder(ids.reader, ids.course, exam.questions), getStudyNext(ids.reader, ids.course),
    getPracticeSet(ids.reader, ids.course, 10), buildPool(ids.course),
    db.questionGroup.findMany({ where: { courseId: ids.course }, orderBy: { rank: "asc" }, select: { text: true, rank: true, paperCount: true } }),
  ]);
  return { exam, bank, personal, next, practice, pool, groups };
}

describe("advice and exam statistics stay apart (US-42)", () => {
  it("leaves every ranking and count unchanged, and never shows advice text in them (acceptance test 2)", async () => {
    const before = await statistics();
    expect(before.groups.map(group => group.paperCount)).toEqual([2, 2, 1, 1]);
    const top = await db.questionGroup.findFirstOrThrow({ where: { courseId: ids.course, rank: 1 }, select: { id: true } });
    const scopes: Array<Pick<PublishInput, "scopeKind" | "scopeValue">> = [
      { scopeKind: "COURSE", scopeValue: "" }, { scopeKind: "EXAM", scopeValue: ids.papers[2] }, { scopeKind: "SESSION", scopeValue: ids.term },
      { scopeKind: "TOPIC", scopeValue: "DNS" }, { scopeKind: "QUESTION", scopeValue: top.id },
    ];
    for (const [index, scope] of scopes.entries()) {
      const result = await publishAdvice(ids.author, {
        courseId: ids.course, ...scope, title: `${marker} title ${index}`,
        // One post repeats a past-paper question word for word: it must not count as another appearance.
        body: index === 4 ? questions[2] : `${marker} body ${index}: ${questions[3]}`,
        resourceUrl: "", resourceTitle: "", isAnonymous: index % 2 === 1,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(await setAdviceHelpful(ids.reader, ids.course, result.id, true)).toMatchObject({ ok: true });
    }
    expect(await db.advice.count({ where: { courseId: ids.course } })).toBe(5);
    // A regroup after advice exists must not pick it up either.
    expect(await rebuildQuestionBank(ids.course)).toMatchObject({ ok: true, groupCount: 4 });
    const after = await statistics();
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain(marker);
  });
});
