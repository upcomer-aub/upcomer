import { describe, expect, it } from "vitest";
import { selectMockQuestions } from "@/lib/mock-exam-mix";
import { complexityOf, mockExamMessage, parseMockExamConfig, type MockConfig, type PoolQuestion } from "@/lib/mock-exam-rules";

const question = (index: number, over: Partial<PoolQuestion> = {}): PoolQuestion => ({
  id: `g${index}`, position: index, text: "x".repeat(index * 10), paperCount: 1, totalPapers: 8,
  topicKey: index <= 4 ? "networking" : "databases", topic: index <= 4 ? "Networking" : "Databases", papers: [{ title: `Paper ${index}`, year: 2025 }], ...over,
});
// Eight questions, from the simplest (g1) to the most complex (g8); g1-g4 are Networking, g5-g8 Databases.
const pool = Array.from({ length: 8 }, (_, index) => question(index + 1));
// The same eight questions in one topic: since US-47 the difficulty chooses inside each topic, so this tests it alone.
const single = pool.map(item => ({ ...item, topicKey: "networking", topic: "Networking" }));
const config = (over: Partial<MockConfig> = {}): MockConfig => ({ topicKeys: [], length: 3, difficulty: "MIXED", ...over });
const ids = (result: ReturnType<typeof selectMockQuestions>) => (result.ok ? result.questions.map(item => item.id) : []);

describe("parseMockExamConfig (US-45)", () => {
  it("accepts valid settings and tidies them", () => {
    expect(parseMockExamConfig({ length: " 10 ", difficulty: "hard", topics: [" TCP  Basics ", "tcp basics", ""] })).toEqual({
      ok: true, config: { topicKeys: ["tcp basics"], length: 10, difficulty: "HARD", includeGenerated: false },
    });
    // Generated practice questions are only asked for with a real `true`.
    expect(parseMockExamConfig({ length: "10", difficulty: "HARD", topics: [], includeGenerated: true })).toMatchObject({ config: { includeGenerated: true } });
  });

  it.each(["", "2", "51", "abc", "1.5", "-5", "1e1", "0010x"])("refuses the length %j", length => {
    expect(parseMockExamConfig({ length, difficulty: "EASY", topics: [] })).toEqual({ ok: false, error: "length_invalid" });
  });

  it("accepts the smallest and largest length", () => {
    expect(parseMockExamConfig({ length: "3", difficulty: "EASY", topics: [] }).ok).toBe(true);
    expect(parseMockExamConfig({ length: "50", difficulty: "EASY", topics: [] }).ok).toBe(true);
  });

  it("refuses an unknown difficulty", () => {
    expect(parseMockExamConfig({ length: "5", difficulty: "IMPOSSIBLE", topics: [] })).toEqual({ ok: false, error: "difficulty_invalid" });
    expect(parseMockExamConfig({ length: "5", difficulty: "", topics: [] })).toEqual({ ok: false, error: "difficulty_invalid" });
  });
});

describe("complexityOf", () => {
  it("grows with length and with the number of parts", () => {
    expect(complexityOf("short")).toBeLessThan(complexityOf("a much longer question than the short one"));
    expect(complexityOf("one line of text")).toBeLessThan(complexityOf("one line of\ntext"));
    expect(complexityOf("")).toBe(0);
  });
});

describe("selectMockQuestions (US-45)", () => {
  it("returns exactly the length asked for", () => {
    for (const length of [3, 5, 8]) for (const difficulty of ["EASY", "MEDIUM", "HARD", "MIXED"] as const) {
      const result = selectMockQuestions(pool, config({ length, difficulty }));
      expect(result.ok && result.questions.length).toBe(length);
      expect(new Set(ids(result)).size).toBe(length);
    }
  });

  it("uses only the chosen topics", () => {
    const result = selectMockQuestions(pool, config({ topicKeys: ["databases"], length: 3 }));
    expect(result.ok && result.questions.every(item => item.topicKey === "databases")).toBe(true);
    const both = selectMockQuestions(pool, config({ topicKeys: ["databases", "networking"], length: 8 }));
    expect(ids(both)).toHaveLength(8);
  });

  it("leaves out questions without a topic when topics are chosen, and keeps them when none is", () => {
    const withUntopiced = [...pool, question(9, { topicKey: null, topic: null })];
    expect(ids(selectMockQuestions(withUntopiced, config({ topicKeys: ["networking"], length: 4, difficulty: "HARD" })))).not.toContain("g9");
    expect(ids(selectMockQuestions(withUntopiced, config({ length: 9 })))).toContain("g9");
  });

  it("refuses a topic the course does not have", () => {
    expect(selectMockQuestions(pool, config({ topicKeys: ["quantum"] }))).toMatchObject({ ok: false, error: "topic_invalid" });
    expect(selectMockQuestions(pool, config({ topicKeys: ["databases", "quantum"] }))).toMatchObject({ ok: false, error: "topic_invalid" });
  });

  it("builds the largest valid exam when the topics cannot fill the request, keeping the topics and the difficulty", () => {
    for (const difficulty of ["EASY", "MEDIUM", "HARD", "MIXED"] as const) {
      const result = selectMockQuestions(pool, config({ topicKeys: ["databases"], length: 5, difficulty }));
      expect(result).toMatchObject({ ok: true, requested: 5, length: 4, narrowed: false });
      expect(ids(result)).toEqual(["g5", "g6", "g7", "g8"]);
    }
    expect(selectMockQuestions(pool, config({ length: 50 }))).toMatchObject({ ok: true, requested: 50, length: 8 });
    expect(selectMockQuestions(pool, config({ length: 8 }))).toMatchObject({ ok: true, requested: 8, length: 8 });
  });

  it("refuses only when nothing at all matches", () => {
    expect(selectMockQuestions([], config())).toEqual({ ok: false, error: "not_enough_questions", available: 0 });
    const all = new Set(pool.map(item => item.id));
    expect(selectMockQuestions(pool, config({ topicKeys: ["databases"] }), { exclude: all })).toEqual({ ok: false, error: "not_enough_questions", available: 0 });
    // One question left is still an exam.
    expect(selectMockQuestions(pool, config({ length: 5 }), { exclude: new Set([...all].filter(id => id !== "g3")) })).toMatchObject({ ok: true, length: 1 });
  });

  it("picks easier questions for EASY than for HARD, with MEDIUM in between", () => {
    const score = (difficulty: "EASY" | "MEDIUM" | "HARD") => {
      const result = selectMockQuestions(single, config({ difficulty }));
      return result.ok ? result.questions.map(item => complexityOf(item.text)) : [];
    };
    expect(Math.max(...score("EASY"))).toBeLessThanOrEqual(Math.min(...score("HARD")));
    expect(ids(selectMockQuestions(single, config({ difficulty: "EASY" })))).toEqual(["g1", "g2", "g3"]);
    expect(ids(selectMockQuestions(single, config({ difficulty: "HARD" })))).toEqual(["g6", "g7", "g8"]);
    expect(ids(selectMockQuestions(single, config({ difficulty: "MEDIUM" })))).toEqual(["g3", "g4", "g5"]);
  });

  it("applies the difficulty inside each topic", () => {
    // Two topics of equal weight share three slots 2 and 1; each takes its simplest (EASY) or most complex (HARD).
    expect(ids(selectMockQuestions(pool, config({ difficulty: "EASY" })))).toEqual(["g1", "g5", "g6"]);
    expect(ids(selectMockQuestions(pool, config({ difficulty: "HARD" })))).toEqual(["g4", "g7", "g8"]);
  });

  it("spreads MIXED over the whole range, from the simplest to the most complex", () => {
    expect(ids(selectMockQuestions(single, config({ difficulty: "MIXED", length: 3 })))).toEqual(["g1", "g5", "g8"]);
    expect(ids(selectMockQuestions(single, config({ difficulty: "MIXED", length: 1 }))).length).toBe(1);
    expect(ids(selectMockQuestions(single, config({ difficulty: "MIXED", length: 8 })))).toHaveLength(8);
  });

  it("gives the same exam whatever order the pool comes in", () => {
    const reversed = [...pool].reverse();
    for (const difficulty of ["EASY", "MEDIUM", "HARD", "MIXED"] as const) {
      expect(ids(selectMockQuestions(reversed, config({ difficulty })))).toEqual(ids(selectMockQuestions(pool, config({ difficulty }))));
    }
  });

  it("breaks ties deterministically: more frequent first, then the Upcomer Exam's order", () => {
    const equal = [1, 2, 3, 4].map(index => question(index, { text: "same length", paperCount: index === 3 ? 2 : 1 }));
    expect(ids(selectMockQuestions(equal, config({ difficulty: "EASY", length: 3, topicKeys: [] })))).toEqual(["g1", "g2", "g3"]);
    expect(ids(selectMockQuestions([...equal].reverse(), config({ difficulty: "EASY", length: 3 })))).toEqual(["g1", "g2", "g3"]);
  });

  it("returns the questions in the Upcomer Exam's order", () => {
    const result = selectMockQuestions(pool, config({ difficulty: "MIXED", length: 5 }));
    const positions = result.ok ? result.questions.map(item => item.position) : [];
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("mockExamMessage", () => {
  it("says how many questions are available", () => {
    expect(mockExamMessage("not_enough_questions", 4)).toContain("Only 4 questions");
    expect(mockExamMessage("not_enough_questions", 1)).toContain("Choose more topics");
    expect(mockExamMessage("not_enough_questions", 0)).toBe("No question matches your topics, so a mock exam can't be made. Choose more topics.");
  });

  it("never echoes an unknown value", () => {
    expect(mockExamMessage("<script>")).toBe(mockExamMessage("unexpected"));
  });
});
