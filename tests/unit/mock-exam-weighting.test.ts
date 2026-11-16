import { describe, expect, it } from "vitest";
import type { LearningProfile } from "@/lib/learning-profile";
import { MAX_WEAK_TOPICS_NAMED, selectMockQuestions } from "@/lib/mock-exam-mix";
import { mixMessage, shorterMessage, type GeneratedCandidate, type MockConfig, type PoolQuestion } from "@/lib/mock-exam-rules";

// US-47: a mock exam's topic mix balances the student's weak topics and the course's high-frequency topics, with the
// personal order's formula (checkedPriority) and NEUTRAL_WEAKNESS for unrated topics.

const TOTAL_PAPERS = 6;
let position = 0;
// `count` questions of one topic, spread over the given papers, with growing text so the difficulty can choose.
const topic = (key: string, label: string, count: number, papers: string[]): PoolQuestion[] => Array.from({ length: count }, (_, index) => ({
  id: `${key}-${index + 1}`, position: ++position, text: `${label} question ${"x".repeat(index * 7)}`, paperCount: 1, totalPapers: TOTAL_PAPERS,
  topicKey: key, topic: label, papers: [{ id: papers[index % papers.length], title: `Paper ${papers[index % papers.length]}`, year: 2025 }],
}));
// Routing comes up in five of the six papers, TCP in three, DNS in two; six questions each.
const pool = [
  ...topic("routing", "Routing", 6, ["p1", "p2", "p3", "p4", "p5"]),
  ...topic("tcp", "TCP", 6, ["p1", "p2", "p6"]),
  ...topic("dns", "DNS", 6, ["p3", "p6"]),
];
const profile = (weaknesses: Record<string, number>): LearningProfile =>
  new Map(Object.entries(weaknesses).map(([key, weakness]) => [key, { topicKey: key, topic: key.toUpperCase(), weakness }]));
const config = (over: Partial<MockConfig> = {}): MockConfig => ({ topicKeys: [], length: 10, difficulty: "MIXED", ...over });
const select = (settings: Partial<MockConfig> = {}, options: Parameters<typeof selectMockQuestions>[2] = {}, questions = pool) => {
  const result = selectMockQuestions(questions, config(settings), options);
  if (!result.ok) throw new Error(result.error);
  return result;
};
const topicsIn = (result: ReturnType<typeof select>) => new Set([...result.questions.map(item => item.topicKey), ...result.generated.map(item => item.topicKey)]);

describe("both the weak topics and the high-frequency topics are represented (acceptance test 1)", () => {
  it("includes the student's weakest topic and the most frequent topic, even when the weak one is rare", () => {
    for (const length of [2, 3, 4, 10]) {
      const result = select({ length }, { profile: profile({ dns: 0.9 }) });
      expect(topicsIn(result)).toContain("dns");
      expect(topicsIn(result)).toContain("routing");
      expect(result.weakTopics).toEqual(["DNS"]);
    }
  });

  it("gives the weak topic more questions than exam frequency alone would", () => {
    expect(select().topicCounts).toEqual({ dns: 2, routing: 5, tcp: 3 });
    expect(select({}, { profile: profile({ dns: 1 }) }).topicCounts.dns).toBeGreaterThan(2);
  });

  it("reserves one slot when the weakest topic is also the most frequent", () => {
    const result = select({ length: 2 }, { profile: profile({ routing: 0.9 }) });
    expect(result.topicCounts.routing).toBeGreaterThanOrEqual(1);
    expect(result.weakTopics).toEqual(["Routing"]);
  });

  it("with one question, gives it to the reserved topic with the higher weight", () => {
    // Routing: 5/6 × 2; DNS: 2/6 × 2.8. Routing weighs more.
    expect(select({ length: 1 }, { profile: profile({ dns: 0.9 }) }).topicCounts).toEqual({ routing: 1 });
    // DNS rated fully weak and Routing fully strong: DNS weighs more.
    expect(select({ length: 1 }, { profile: profile({ dns: 1, routing: 0 }) }).topicCounts).toEqual({ dns: 1 });
  });

  it("reserves no weak slot for topics at or below neutral", () => {
    const result = select({ length: 3 }, { profile: profile({ dns: 0.5, tcp: 0.2 }) });
    expect(result.weakTopics).toEqual([]);
    expect(result.hasProfile).toBe(true);
  });

  it("names the weakest topics first, at most three, and only topics in the exam", () => {
    const many = [...pool, ...topic("udp", "UDP", 2, ["p1"]), ...topic("ip", "IP", 2, ["p2"])];
    const result = select({ length: 10 }, { profile: profile({ dns: 0.7, tcp: 0.95, udp: 0.8, ip: 0.6 }) }, many);
    expect(result.weakTopics).toHaveLength(MAX_WEAK_TOPICS_NAMED);
    expect(result.weakTopics).toEqual(["TCP", "UDP", "DNS"]);
    // A weak topic that was not chosen is neither in the exam nor named.
    const chosen = select({ topicKeys: ["routing", "tcp"], length: 4 }, { profile: profile({ dns: 1 }) });
    expect(topicsIn(chosen)).toEqual(new Set(["routing", "tcp"]));
    expect(chosen.weakTopics).toEqual([]);
  });
});

describe("two students with different profiles get different mixes (acceptance test 2)", () => {
  it("differs when their weak topics differ, for the same course and settings", () => {
    for (const length of [3, 5, 10]) {
      const first = select({ length }, { profile: profile({ dns: 0.9 }) });
      const second = select({ length }, { profile: profile({ tcp: 0.9, dns: 0.1 }) });
      expect(first.topicCounts).not.toEqual(second.topicCounts);
      expect(topicsIn(first)).toContain("dns");
      expect(topicsIn(second)).toContain("tcp");
    }
  });

  it("differs from the no-profile mix when the student is weaker in a topic", () => {
    expect(select({}, { profile: profile({ tcp: 1 }) }).topicCounts).not.toEqual(select().topicCounts);
  });
});

describe("a student with no profile gets the exam-frequency mix (acceptance test 3)", () => {
  it("shares the questions in proportion to how many papers each topic comes up in", () => {
    // 5 : 3 : 2 papers, ten questions.
    expect(select().topicCounts).toEqual({ dns: 2, routing: 5, tcp: 3 });
    expect(select().hasProfile).toBe(false);
    expect(select().weakTopics).toEqual([]);
  });

  it("is the same with an empty profile, a neutral one, or one of topics this course does not have", () => {
    const none = select();
    expect(select({}, { profile: new Map() })).toEqual(none);
    expect(select({}, { profile: profile({ biology: 1 }) })).toEqual(none);
    expect(select({}, { profile: profile({ routing: 0.5, tcp: 0.5, dns: 0.5 }) }).topicCounts).toEqual(none.topicCounts);
  });

  it("still gives the most frequent topic a question in a short exam", () => {
    expect(select({ length: 1 }).topicCounts).toEqual({ routing: 1 });
    expect(select({ length: 2 }).topicCounts).toEqual({ routing: 1, tcp: 1 });
  });
});

describe("ties and determinism", () => {
  it("breaks equal weights by papers, then by topic key", () => {
    const twins = [...topic("beta", "Beta", 3, ["p1", "p2"]), ...topic("alpha", "Alpha", 3, ["p3", "p4"])];
    expect(select({ length: 1 }, {}, twins).topicCounts).toEqual({ alpha: 1 });
    expect(select({ length: 3 }, {}, twins).topicCounts).toEqual({ alpha: 2, beta: 1 });
    // Equal weights from different inputs: more papers first.
    const balanced = [...topic("rare", "Rare", 3, ["p1"]), ...topic("common", "Common", 3, ["p2", "p3"])];
    // rare: 1/6 × (1 + 2 × 1) = 0.5; common: 2/6 × (1 + 2 × 0.25) = 0.5.
    expect(select({ length: 3 }, { profile: profile({ rare: 1, common: 0.25 }) }, balanced).topicCounts).toEqual({ common: 2, rare: 1 });
  });

  it("gives the same exam whatever order the pool, the profile and the generated questions come in", () => {
    const weaknesses = { dns: 0.9, tcp: 0.7, routing: 0.2 };
    const reversedProfile = profile(Object.fromEntries(Object.entries(weaknesses).reverse()));
    for (const difficulty of ["EASY", "MEDIUM", "HARD", "MIXED"] as const) for (const length of [3, 7, 12]) {
      const one = select({ length, difficulty }, { profile: profile(weaknesses) });
      expect(select({ length, difficulty }, { profile: reversedProfile }, [...pool].reverse())).toEqual(one);
      expect(select({ length, difficulty }, { profile: profile(weaknesses) })).toEqual(one);
    }
  });

  it("shows the exam in the Upcomer Exam's order", () => {
    const positions = select({}, { profile: profile({ dns: 0.9 }) }).questions.map(item => item.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("the other rules still hold with weighting", () => {
  it("fills the exact length and never repeats a question", () => {
    for (const length of [3, 10, 18]) {
      const result = select({ length }, { profile: profile({ dns: 0.9 }) });
      expect(result.questions).toHaveLength(length);
      expect(new Set(result.questions.map(item => item.id)).size).toBe(length);
    }
  });

  it("moves slots to other topics when a weighted topic runs out", () => {
    const small = [...pool.filter(item => item.topicKey !== "dns"), ...topic("dns", "DNS", 1, ["p3", "p6"])];
    const result = select({ length: 12 }, { profile: profile({ dns: 1 }) }, small);
    expect(result.topicCounts.dns).toBe(1);
    expect(result.questions).toHaveLength(12);
  });

  it("builds the largest valid exam when asked for more than the topics have", () => {
    const result = select({ topicKeys: ["dns"], length: 20 }, { profile: profile({ dns: 0.9 }) });
    expect(result).toMatchObject({ requested: 20, length: 6, topicCounts: { dns: 6 } });
    expect(shorterMessage(result.requested, result.length, false)).toBe("You asked for 20 questions, but your topics have only 6 that fit, so this exam has 6.");
    expect(shorterMessage(6, 6, false)).toBeNull();
    expect(shorterMessage(5, 1, false)).toBe("You asked for 5 questions, but your topics have only 1 that fits, so this exam has 1.");
  });

  it("keeps US-46's exclude: excluded questions never return, and the length is kept when the pool allows", () => {
    const first = select({ length: 6 }, { profile: profile({ dns: 0.9 }) });
    const second = select({ length: 6 }, { profile: profile({ dns: 0.9 }), exclude: new Set(first.questions.map(item => item.id)) });
    expect(second.questions.filter(item => first.questions.some(other => other.id === item.id))).toEqual([]);
    expect(second.questions).toHaveLength(6);
    expect(topicsIn(second)).toContain("dns");
  });

  it("applies the difficulty inside each topic", () => {
    const easy = select({ length: 6, difficulty: "EASY" });
    const hard = select({ length: 6, difficulty: "HARD" });
    expect(easy.topicCounts).toEqual(hard.topicCounts);
    // Each topic's simplest questions for EASY, its most complex for HARD.
    expect(easy.questions.filter(item => item.topicKey === "routing").map(item => item.id)).toEqual(["routing-1", "routing-2", "routing-3"]);
    expect(hard.questions.filter(item => item.topicKey === "routing").map(item => item.id)).toEqual(["routing-4", "routing-5", "routing-6"]);
  });

  it("counts an invalid stored weakness as clamped, and reports it instead of throwing", () => {
    const result = select({ length: 4 }, { profile: profile({ dns: 7, tcp: Number.NaN }) });
    expect(result.invalidTopics).toBe(2);
    expect(result.reasons).toEqual(["invalid_weakness"]);
    // 7 is clamped to 1 (weak); not-a-number counts as neutral.
    expect(result.weakTopics).toEqual(["DNS"]);
    expect(select({ length: 4 }, { profile: profile({ dns: 0.9 }) }).invalidTopics).toBe(0);
  });
});

describe("generated practice questions (paperCount 0) in a weighted exam", () => {
  const candidate = (id: string, topicKey: string, sourcePaperCount?: number): GeneratedCandidate =>
    ({ id, topicKey, topic: topicKey.toUpperCase(), difficulty: "MEDIUM", text: `Task ${id}`, sourcePaper: "Paper", sourcePaperCount });
  // Newest first.
  const generated = [candidate("dns-new", "dns", 1), candidate("dns-old", "dns", 3), candidate("dns-unknown", "dns"), candidate("tcp-1", "tcp", 2)];

  it("adds nothing to a topic's weight: the mix is the same with or without them", () => {
    const without = select({ length: 10, includeGenerated: true });
    const withThem = select({ length: 10, includeGenerated: true }, { generated });
    expect(withThem.topicCounts).toEqual(without.topicCounts);
  });

  it("orders them inside a topic by their source question's group, then newest first; an unknown source counts as one paper", () => {
    const result = select({ topicKeys: ["dns"], length: 6, includeGenerated: true }, { generated });
    // Three generated slots for DNS: the source in 3 papers first, then the newest of the two at one paper.
    expect(result.generated.map(item => item.id).sort()).toEqual(["dns-new", "dns-old", "dns-unknown"]);
    expect(select({ topicKeys: ["dns"], length: 2, includeGenerated: true }, { generated }).generated.map(item => item.id)).toEqual(["dns-old"]);
    expect(select({ topicKeys: ["dns"], length: 4, includeGenerated: true }, { generated }).generated.map(item => item.id)).toEqual(["dns-new", "dns-old"]);
  });

  it("gives each topic at most half of its own questions as generated ones", () => {
    const result = select({ length: 10, includeGenerated: true }, { generated, profile: profile({ dns: 1 }) });
    const fromTopic = (key: string) => result.generated.filter(item => item.topicKey === key).length;
    for (const key of Object.keys(result.topicCounts)) expect(fromTopic(key)).toBeLessThanOrEqual(Math.floor(result.topicCounts[key] / 2));
    expect(result.questions.length + result.generated.length).toBe(10);
  });
});

describe("the line that says why the exam has its mix", () => {
  it("names the weaker topics, or says the mix follows exam frequency, and never claims mastery", () => {
    const lines = [
      mixMessage("PROFILE", ["Routing", "DNS"]), mixMessage("PROFILE", []), mixMessage("NO_PROFILE", []), mixMessage("PROFILE_UNAVAILABLE", []),
    ];
    expect(lines[0]).toBe("Weighted toward your weaker topics: Routing, DNS, and toward the topics that come up most in past papers.");
    expect(lines.slice(2).every(line => line?.includes("follows how often each topic comes up in past papers"))).toBe(true);
    for (const line of lines) expect(line).not.toMatch(/master|know|strong|good at|ready/i);
    expect(mixMessage(null, [])).toBeNull();
    expect(mixMessage("SOMETHING", [])).toBeNull();
  });
});
