import { afterAll, beforeAll, describe, expect, it } from "vitest";

// US-31 against a real database: the real regroup, the real Upcomer Exam, and profiles written with setTopicWeakness (the
// call US-24 and US-25 make). A student weak in a less frequent topic gets more of it, a student without a weak topic
// gets the frequency order, no question repeats, another course's profile changes nothing, and reading never writes.

import { db } from "@/lib/db";
import { recordLearningEvents } from "@/lib/learning-evidence";
import { setTopicWeakness } from "@/lib/learning-profile";
import { getPracticeSet } from "@/lib/practice-set";
import { rebuildQuestionBank } from "@/lib/question-bank";

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const faculty = { id: `it-ps-faculty-${stamp}`, code: `IPSF${stamp}`.toUpperCase().slice(0, 20), name: "Practice Faculty" };
const courses = ["main", "other", "empty"].map(name => ({ id: `it-ps-${name}-${stamp}`, code: `IPS${name}${stamp}`.toUpperCase().slice(0, 20), name: `Practice ${name}`, facultyId: faculty.id }));
const [course, other, empty] = courses.map(item => item.id);
const students = ["weak", "none", "strong", "evidence"].map(name => `it-ps-${name}-${stamp}`);
const [weakInDns, noProfile, strongOnly, fromOutcomes] = students;
// Two TCP papers share six questions, so TCP fills the top of the frequency order; one DNS paper has six other questions.
const tcp = [
  "Explain the TCP three-way handshake.", "Describe TCP slow start and congestion avoidance.", "Why does TCP use a sliding window for flow control?",
  "Compare Go-Back-N with Selective Repeat retransmission.", "How does TCP estimate the retransmission timeout?", "What happens during a TCP connection teardown?",
];
const dns = [
  "Explain how DNS resolves a host name iteratively.", "What is the purpose of a DNS MX record?", "Why are DNS responses cached, and for how long?",
  "Describe the role of root and top-level domain servers.", "How does DNS use UDP, and when does it switch to TCP?", "What is a CNAME record used for?",
];
const papers: Array<[string, string, string[]]> = [["p1", "TCP", tcp], ["p2", "TCP", tcp], ["p3", "DNS", dns]];

beforeAll(async () => {
  await db.faculty.create({ data: faculty });
  await db.course.createMany({ data: courses });
  await db.user.createMany({ data: students.map((id, index) => ({ id, email: `${id}@practice.test`, name: `Student ${index}`, passwordHash: "x" })) });
  for (const [name, topic, questions] of papers) {
    await db.courseFile.create({ data: {
      id: `${course}-${name}`, courseId: course, title: `Paper ${name}`, category: "EXAM", year: 2024, topic,
      originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf",
      questions: { create: questions.map((text, index) => ({ number: index + 1, text })) },
    } });
  }
  expect(await rebuildQuestionBank(course)).toMatchObject({ ok: true, groupCount: 12 });
  for (const [topic, weakness] of [["TCP", 0], ["DNS", 1]] as const) expect(await setTopicWeakness(weakInDns, course, topic, weakness)).toEqual({ ok: true });
  for (const topic of ["TCP", "DNS"]) expect(await setTopicWeakness(strongOnly, course, topic, 0)).toEqual({ ok: true });
  // The no-profile student is weak in DNS in another course only.
  expect(await setTopicWeakness(noProfile, other, "DNS", 1)).toEqual({ ok: true });
});
afterAll(async () => {
  try {
    await db.course.deleteMany({ where: { id: { in: courses.map(item => item.id) } } });
    await db.user.deleteMany({ where: { id: { in: students } } });
    await db.faculty.deleteMany({ where: { id: faculty.id } });
    expect(await db.learningTopic.count({ where: { userId: { in: students } } })).toBe(0);
  } finally {
    await db.$disconnect();
  }
});

const topicCounts = (set: Awaited<ReturnType<typeof getPracticeSet>>) =>
  Object.fromEntries(["TCP", "DNS"].map(topic => [topic, set.questions.filter(question => question.topic === topic).length]));

describe("practice set (US-31)", () => {
  it("gives a student weak in the less frequent topic a larger share of it (acceptance test 1)", async () => {
    const set = await getPracticeSet(weakInDns, course, 5);
    expect(set.mode).toBe("weak_topics");
    expect(set.questions).toHaveLength(5);
    const counts = topicCounts(set);
    expect(counts.DNS).toBeGreaterThan(counts.TCP);
    expect(counts.TCP).toBeGreaterThan(0);
    expect(set.questions[0].topic).toBe("DNS");
  });
  it("falls back to the exam frequency with no profile in the course, ignoring another course's (acceptance test 2)", async () => {
    const set = await getPracticeSet(noProfile, course, 5);
    expect(set.mode).toBe("frequency");
    expect(topicCounts(set)).toEqual({ TCP: 5, DNS: 0 });
    expect(set.questions.map(question => question.position)).toEqual([1, 2, 3, 4, 5]);
  });
  it("falls back to the exam frequency for a student strong in every topic", async () => {
    expect((await getPracticeSet(strongOnly, course, 5)).mode).toBe("frequency");
  });
  it("never repeats a question, and gives every question when asked for more than the course has (acceptance test 3)", async () => {
    for (const size of [5, 10, 20]) {
      const ids = (await getPracticeSet(weakInDns, course, size)).questions.map(question => question.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(Math.min(size, 12));
    }
  });
  it("returns an empty set for a course without questions", async () => {
    expect(await getPracticeSet(weakInDns, empty, 10)).toEqual({ mode: "frequency", questions: [], topics: [], available: 0 });
  });
  it("follows weakness from recorded practice outcomes (US-25), not only from ratings", async () => {
    expect((await getPracticeSet(fromOutcomes, course, 5)).mode).toBe("frequency");
    const dnsQuestion = await db.question.findFirstOrThrow({ where: { fileId: `${course}-p3` }, select: { id: true } });
    const events = [1, 2, 3].map(n => ({ source: "QUESTION_BANK" as const, eventId: `it-ps-${stamp}-${n}`, questionId: dnsQuestion.id, correct: false }));
    expect(await recordLearningEvents(fromOutcomes, course, events)).toMatchObject({ ok: true, recorded: 3 });
    const set = await getPracticeSet(fromOutcomes, course, 5);
    expect(set.mode).toBe("weak_topics");
    expect(topicCounts(set).DNS).toBeGreaterThan(topicCounts(set).TCP);
  });
  it("never writes the learning profile", async () => {
    const before = await db.learningTopic.findMany({ where: { userId: { in: students } }, orderBy: [{ userId: "asc" }, { courseId: "asc" }, { topicKey: "asc" }] });
    await getPracticeSet(weakInDns, course, 10);
    await getPracticeSet(noProfile, course, 10);
    const after = await db.learningTopic.findMany({ where: { userId: { in: students } }, orderBy: [{ userId: "asc" }, { courseId: "asc" }, { topicKey: "asc" }] });
    expect(after).toEqual(before);
  });
});
