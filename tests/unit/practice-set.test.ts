import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExamQuestion } from "@/lib/consolidated-exam";
import type { LearningProfile } from "@/lib/learning-profile";

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), getConsolidatedExam: vi.fn(), getLearningProfile: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { courseFile: { findMany: mocks.findMany } } }));
vi.mock("@/lib/consolidated-exam", () => ({ getConsolidatedExam: mocks.getConsolidatedExam }));
vi.mock("@/lib/learning-profile", async importOriginal => ({ ...(await importOriginal<object>()), getLearningProfile: mocks.getLearningProfile }));
import { DEFAULT_PRACTICE_SIZE, getPracticeSet, practiceSize, selectPracticeSet } from "@/lib/practice-set";

// A question in one paper, numbered by its place in the frequency order.
const question = (position: number, paperId: string): ExamQuestion => ({
  id: `g${position}`, position, rank: position, text: `Question ${position}.`, paperCount: 1, totalPapers: 4, tier: "LIKELY",
  papers: [{ id: paperId, title: `Paper ${paperId}`, year: 2024, examType: null, term: null, professor: null }],
});
const profile = (weaknesses: Record<string, number>): LearningProfile =>
  new Map(Object.entries(weaknesses).map(([topicKey, weakness]) => [topicKey, { topicKey, topic: topicKey, weakness }]));
// Papers: p-tcp about TCP, p-dns about DNS, p-none without a topic.
const topics = new Map<string, string | null>([["p-tcp", "TCP"], ["p-dns", "DNS"], ["p-none", null]]);
// Ten TCP questions take the top of the frequency order, then ten DNS questions, then two without a topic.
const exam = [
  ...Array.from({ length: 10 }, (_, index) => question(index + 1, "p-tcp")),
  ...Array.from({ length: 10 }, (_, index) => question(index + 11, "p-dns")),
  question(21, "p-none"), question(22, "p-none"),
];
const countOf = (set: ReturnType<typeof selectPracticeSet>, topic: string | null) => set.questions.filter(item => item.topic === topic).length;

describe("practiceSize", () => {
  it("accepts the offered sizes and falls back to the default for anything else", () => {
    expect([5, 10, 20].map(practiceSize)).toEqual([5, 10, 20]);
    expect(["5", "20"].map(practiceSize)).toEqual([5, 20]);
    expect([undefined, "", "abc", "7", "-5", "1000", "10.5", null].map(practiceSize)).toEqual(Array(8).fill(DEFAULT_PRACTICE_SIZE));
  });
});

describe("selectPracticeSet (US-31)", () => {
  it("takes a larger share from the student's weaker topic, though the stronger one is more frequent (acceptance test 1)", () => {
    const set = selectPracticeSet(exam, topics, profile({ tcp: 0, dns: 1 }), 10);
    expect(set.mode).toBe("weak_topics");
    expect(set.questions).toHaveLength(10);
    // Weights: DNS 3, TCP 1, untagged 2 (neutral).
    expect(countOf(set, "DNS")).toBeGreaterThan(countOf(set, "TCP"));
    expect(countOf(set, "DNS")).toBeGreaterThan(countOf(set, null));
    expect(countOf(set, "TCP")).toBeGreaterThan(0);
    expect(set.topics.map(topic => [topic.topic, topic.count])).toEqual([["DNS", 6], [null, 2], ["TCP", 2]]);
  });
  it("still keeps every topic in the set and lists the weakest topics first, the most frequent questions first within one", () => {
    const set = selectPracticeSet(exam, topics, profile({ tcp: 0, dns: 1 }), 10);
    expect(set.questions.map(item => item.position)).toEqual([11, 12, 13, 14, 15, 16, 21, 22, 1, 2]);
  });
  it("follows the profile: the same course gives a student weak in TCP more TCP questions", () => {
    const set = selectPracticeSet(exam, topics, profile({ tcp: 1, dns: 0 }), 10);
    expect(countOf(set, "TCP")).toBeGreaterThan(countOf(set, "DNS"));
  });
  it("falls back to the exam frequency for a student without a learning profile (acceptance test 2)", () => {
    const set = selectPracticeSet(exam, topics, new Map(), 5);
    expect(set.mode).toBe("frequency");
    expect(set.questions.map(item => item.position)).toEqual([1, 2, 3, 4, 5]);
  });
  it("falls back to the exam frequency when no topic is weaker than neutral", () => {
    for (const weaknesses of [{ tcp: 0.5, dns: 0.5 }, { tcp: 0, dns: 0 }, { tcp: 0, dns: 0.5 }]) {
      const set = selectPracticeSet(exam, topics, profile(weaknesses), 5);
      expect(set.mode).toBe("frequency");
      expect(set.questions.map(item => item.position)).toEqual([1, 2, 3, 4, 5]);
    }
  });
  it("never puts a question in the set twice, for any size (acceptance test 3)", () => {
    for (const size of [1, 5, 10, 20, 22, 50]) {
      for (const weak of [profile({ tcp: 0, dns: 1 }), profile({ tcp: 1, dns: 0.75 }), new Map()]) {
        const ids = selectPracticeSet(exam, topics, weak, size).questions.map(item => item.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toHaveLength(Math.min(size, exam.length));
      }
    }
  });
  it("passes the places of a topic that runs out on to the other topics", () => {
    // Only two DNS questions: the weak topic gets both, and the rest of the ten places go to the others.
    const few = [...exam.slice(0, 10), question(11, "p-dns"), question(12, "p-dns")];
    const set = selectPracticeSet(few, topics, profile({ tcp: 0, dns: 1 }), 10);
    expect(set.questions).toHaveLength(10);
    expect(countOf(set, "DNS")).toBe(2);
    expect(countOf(set, "TCP")).toBe(8);
  });
  it("returns every question when the course has fewer than asked, and says how many there were", () => {
    const set = selectPracticeSet(exam.slice(0, 3), topics, profile({ tcp: 1 }), 10);
    expect(set.questions).toHaveLength(3);
    expect(set.available).toBe(3);
  });
  it("returns an empty set for a course without questions (no eligible questions)", () => {
    expect(selectPracticeSet([], topics, profile({ tcp: 1 }), 10)).toEqual({ mode: "frequency", questions: [], topics: [], available: 0 });
  });
  it("treats a broken stored weakness as neutral", () => {
    const set = selectPracticeSet(exam, topics, profile({ tcp: Number.NaN, dns: 7 }), 5);
    expect(set.mode).toBe("frequency");
  });
  it("gives the same set for the same inputs, and does not change the questions", () => {
    const copy = structuredClone(exam);
    const first = selectPracticeSet(exam, topics, profile({ tcp: 0.25, dns: 0.75 }), 10);
    expect(selectPracticeSet(exam, topics, profile({ tcp: 0.25, dns: 0.75 }), 10)).toEqual(first);
    expect(exam).toEqual(copy);
  });
  it("matches topics regardless of case and spacing, like the personal order", () => {
    const spaced = new Map<string, string | null>([["p-tcp", "  tcp "], ["p-dns", "Dns"], ["p-none", null]]);
    const set = selectPracticeSet(exam, spaced, profile({ tcp: 0, dns: 1 }), 10);
    expect(set.mode).toBe("weak_topics");
    expect(countOf(set, "Dns")).toBe(6);
  });
});

describe("getPracticeSet (US-31)", () => {
  let errors: ReturnType<typeof vi.spyOn>;
  const logged = () => errors.mock.calls.map(call => JSON.parse(String(call[0])));
  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getConsolidatedExam.mockReset().mockResolvedValue({ totalPapers: 3, lowConfidence: false, questions: exam, sections: [] });
    mocks.getLearningProfile.mockReset().mockResolvedValue(profile({ tcp: 0, dns: 1 }));
    mocks.findMany.mockReset().mockResolvedValue([...topics].map(([id, topic]) => ({ id, topic })));
  });

  it("reads the student's profile in this course only and the topics of the course's published papers", async () => {
    const set = await getPracticeSet("student-1", "course-a", 10);
    expect(mocks.getConsolidatedExam).toHaveBeenCalledWith("course-a");
    expect(mocks.getLearningProfile).toHaveBeenCalledWith("student-1", "course-a");
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ courseId: "course-a", status: "PUBLISHED" });
    expect(new Set(where.id.in)).toEqual(new Set(["p-tcp", "p-dns", "p-none"]));
    expect(set.mode).toBe("weak_topics");
    expect(set.questions).toHaveLength(10);
  });
  it("skips the paper lookup for a course without questions", async () => {
    mocks.getConsolidatedExam.mockResolvedValue({ totalPapers: 0, lowConfidence: true, questions: [], sections: [] });
    expect(await getPracticeSet("student-1", "course-a", 10)).toEqual({ mode: "frequency", questions: [], topics: [], available: 0 });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
  it("logs a failure once with IDs and the error type only, and rethrows it", async () => {
    mocks.getLearningProfile.mockRejectedValue(new TypeError("connection to 10.0.0.1 lost"));
    await expect(getPracticeSet("student-1", "course-a", 5)).rejects.toThrow(TypeError);
    expect(logged()).toEqual([expect.objectContaining({ event: "practice_set_failed", level: "error", userId: "student-1", courseId: "course-a", size: "5", errorType: "TypeError" })]);
    expect(JSON.stringify(logged())).not.toContain("10.0.0.1");
  });
});
