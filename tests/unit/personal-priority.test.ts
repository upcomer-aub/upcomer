import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExamQuestion } from "@/lib/consolidated-exam";
import type { LearningProfile } from "@/lib/learning-profile";

const { courseFile, learningTopic } = vi.hoisted(() => ({ courseFile: { findMany: vi.fn() }, learningTopic: { findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: { courseFile, learningTopic } }));
import { EVENT_LEVELS } from "@/lib/logger";
import { checkedPriority, getPersonalOrder, NEUTRAL_WEAKNESS, personalizeQuestions, personalPriority, PRIORITY_TIE, WEAKNESS_WEIGHT } from "@/lib/personal-order";

// US-27: a question's priority combines its exam importance (share of the course's papers) with the student's weakness
// in its topic. These tests cover each rule Lea Hamdan cross-tests, plus invalid inputs and their single log line.

let errors: ReturnType<typeof vi.spyOn>;
const logged = () => errors.mock.calls.map(call => JSON.parse(String(call[0])));

// A deterministic pseudo-random generator (mulberry32), so the "random" inputs are the same on every run.
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const question = (position: number, paperIds: string[], total = 4, paperCount = paperIds.length): ExamQuestion => ({
  id: `g${position}`, position, rank: position, text: `Question ${position}.`, paperCount, totalPapers: total, tier: "LIKELY",
  papers: paperIds.map(id => ({ id, title: `Paper ${id}`, year: 2024, examType: null, term: null, professor: null })),
});
const profile = (weaknesses: Record<string, number>): LearningProfile =>
  new Map(Object.entries(weaknesses).map(([topicKey, weakness]) => [topicKey, { topicKey, topic: topicKey, weakness }]));
const topics = new Map<string, string | null>([["p1", "TCP"], ["p2", "Routing"], ["p3", "DNS"], ["p4", null]]);
const positions = (questions: ExamQuestion[]) => questions.map(item => item.position);

beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  courseFile.findMany.mockReset().mockResolvedValue([...topics].map(([id, topic]) => ({ id, topic })));
  learningTopic.findMany.mockReset().mockResolvedValue([]);
});

describe("personalPriority: exam importance combined with weakness (US-27)", () => {
  it("ranks the more frequent of two equally weak questions higher, at every weakness", () => {
    for (const weakness of [0, 0.25, 0.5, 0.75, 1]) {
      expect(personalPriority(3, 5, weakness)).toBeGreaterThan(personalPriority(2, 5, weakness));
      expect(personalPriority(5, 5, weakness)).toBeGreaterThan(personalPriority(1, 5, weakness));
    }
  });
  it("ranks the weaker of two equally frequent questions higher, at every share", () => {
    for (const count of [1, 2, 3, 4, 5]) {
      expect(personalPriority(count, 5, 1)).toBeGreaterThan(personalPriority(count, 5, 0.6));
      expect(personalPriority(count, 5, 0.6)).toBeGreaterThan(personalPriority(count, 5, 0));
    }
  });
  it("is the share times a weakness factor from 1 (strongest) to 1 + WEAKNESS_WEIGHT (weakest)", () => {
    expect(WEAKNESS_WEIGHT).toBeGreaterThan(0);
    expect(personalPriority(2, 4, 0)).toBeCloseTo(0.5);
    expect(personalPriority(2, 4, 1)).toBeCloseTo(0.5 * (1 + WEAKNESS_WEIGHT));
    expect(personalPriority(2, 4, 0.5)).toBeCloseTo(0.5 * (1 + WEAKNESS_WEIGHT * 0.5));
    // The strongest topic still counts, and the weakest counts at most (1 + WEAKNESS_WEIGHT) times as much.
    expect(personalPriority(1, 10, 0)).toBeGreaterThan(0);
    expect(personalPriority(3, 7, 1) / personalPriority(3, 7, 0)).toBeCloseTo(1 + WEAKNESS_WEIGHT);
  });
  it("gives no priority to a question without papers", () => {
    expect(personalPriority(0, 0, 1)).toBe(0);
    expect(personalPriority(0, 5, 1)).toBe(0);
  });
  it("gives the same priority for the same inputs, without randomness or dates", () => {
    const random = vi.spyOn(Math, "random");
    const now = vi.spyOn(Date, "now");
    expect(personalPriority(2, 5, 0.3)).toBe(personalPriority(2, 5, 0.3));
    expect(checkedPriority(7, 9, 0.81)).toEqual(checkedPriority(7, 9, 0.81));
    expect(random).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    random.mockRestore();
    now.mockRestore();
  });
  it("ranks many random inputs the same way twice, whatever order they arrive in", () => {
    const next = seeded(27);
    const inputs = Array.from({ length: 1000 }, (_, id) => {
      const totalPapers = 1 + Math.floor(next() * 12);
      return { id, paperCount: Math.floor(next() * (totalPapers + 1)), totalPapers, weakness: Math.round(next() * 100) / 100 };
    });
    // The same comparator as personalizeQuestions: priorities within PRIORITY_TIE are a tie, broken by a fixed key.
    const rank = (items: typeof inputs) =>
      items
        .map(item => ({ id: item.id, priority: personalPriority(item.paperCount, item.totalPapers, item.weakness) }))
        .sort((a, b) => (Math.abs(b.priority - a.priority) > PRIORITY_TIE ? b.priority - a.priority : a.id - b.id))
        .map(item => item.id);
    // A seeded Fisher-Yates shuffle of the same inputs.
    const shuffled = [...inputs];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const first = rank(inputs);
    expect(rank(inputs)).toEqual(first);
    expect(rank(shuffled)).toEqual(first);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("checkedPriority: invalid inputs are clamped, never thrown (US-27)", () => {
  const cases: Array<[string, number, number, number, number, string[]]> = [
    ["NaN paper count", NaN, 4, 0.5, 0, ["invalid_paper_count"]],
    ["infinite paper count", Infinity, 4, 0.5, 0, ["invalid_paper_count"]],
    ["negative paper count", -2, 4, 0.5, 0, ["invalid_paper_count"]],
    ["NaN total", 2, NaN, 0.5, 0, ["invalid_total_papers"]],
    ["infinite total", 2, Infinity, 0.5, 0, ["invalid_total_papers"]],
    ["negative total", 2, -4, 0.5, 0, ["invalid_total_papers"]],
    ["more papers than the course has", 6, 4, 0, 1, ["paper_count_exceeds_total"]],
    ["weakness below 0", 2, 4, -0.5, 0.5, ["invalid_weakness"]],
    ["weakness above 1", 2, 4, 1.5, 0.5 * (1 + WEAKNESS_WEIGHT), ["invalid_weakness"]],
    ["NaN weakness", 2, 4, NaN, 0.5 * (1 + WEAKNESS_WEIGHT * NEUTRAL_WEAKNESS), ["invalid_weakness"]],
    ["infinite weakness", 2, 4, -Infinity, 0.5 * (1 + WEAKNESS_WEIGHT * NEUTRAL_WEAKNESS), ["invalid_weakness"]],
    ["everything invalid", NaN, -1, NaN, 0, ["invalid_total_papers", "invalid_paper_count", "invalid_weakness"]],
  ];
  it.each(cases)("%s: a safe, finite priority and the reason", (_, paperCount, totalPapers, weakness, expected, reasons) => {
    const result = checkedPriority(paperCount, totalPapers, weakness);
    expect(Number.isFinite(result.priority)).toBe(true);
    expect(result.priority).toBeCloseTo(expected);
    expect(result.reasons).toEqual(reasons);
    expect(personalPriority(paperCount, totalPapers, weakness)).toBe(result.priority);
    // The priority itself never logs; the ranking does, once.
    expect(errors).not.toHaveBeenCalled();
  });
  it("reports no reason for valid inputs, including the edges", () => {
    for (const [paperCount, totalPapers, weakness] of [[0, 0, 1], [0, 4, 0], [4, 4, 1], [2, 4, 0], [2, 4, 1]]) {
      expect(checkedPriority(paperCount, totalPapers, weakness).reasons).toEqual([]);
    }
  });
});

describe("personalizeQuestions: one log line per ranking (US-27)", () => {
  const context = { userId: "student-1", courseId: "course-a" };
  it("logs one bad question once, with IDs, the count, and the reason only", () => {
    const exam = [question(1, ["p1", "p2"]), question(2, ["p3"], 4, NaN), question(3, ["p4"])];
    const { questions } = personalizeQuestions(exam, topics, profile({ tcp: 0.2 }), context);
    expect([...positions(questions)].sort()).toEqual([1, 2, 3]);
    expect(logged()).toEqual([
      { event: "priority_calculation_failed", level: "error", timestamp: expect.any(String), userId: "student-1", courseId: "course-a", affectedQuestions: "1", reasons: "invalid_paper_count" },
    ]);
  });
  it("logs several bad questions in one ranking as a single line, with the count and the distinct reasons", () => {
    const exam = [
      question(1, ["p1"], 4, -1),
      question(2, ["p2"], 4, 9),
      question(3, ["p3"], NaN),
      question(4, ["p2"], 4, -3),
      question(5, ["p4"]),
    ];
    const { questions } = personalizeQuestions(exam, topics, profile({ routing: 2, dns: NaN }), context);
    expect([...positions(questions)].sort()).toEqual([1, 2, 3, 4, 5]);
    const lines = logged();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "priority_calculation_failed", userId: "student-1", courseId: "course-a", affectedQuestions: "4" });
    expect(lines[0].reasons).toBe("invalid_paper_count,invalid_total_papers,invalid_weakness,paper_count_exceeds_total");
  });
  it("logs nothing for a valid ranking", () => {
    const exam = [question(1, ["p1", "p2", "p3"]), question(2, ["p2"]), question(3, ["p4"])];
    personalizeQuestions(exam, topics, profile({ tcp: 0, routing: 1, dns: 0.5 }), context);
    expect(errors).not.toHaveBeenCalled();
  });
  it("passes the student and course from getPersonalOrder into the log line", async () => {
    learningTopic.findMany.mockResolvedValue([{ topicKey: "tcp", topic: "TCP", weakness: 1 }]);
    const result = await getPersonalOrder("student-2", "course-b", [question(1, ["p1"], 4, Infinity), question(2, ["p2"])]);
    expect(result.questions).toHaveLength(2);
    expect(logged()).toEqual([expect.objectContaining({ event: "priority_calculation_failed", userId: "student-2", courseId: "course-b", affectedQuestions: "1", reasons: "invalid_paper_count" })]);
  });
  it("logs at error level", () => {
    expect(EVENT_LEVELS.priority_calculation_failed).toBe("error");
  });
});
