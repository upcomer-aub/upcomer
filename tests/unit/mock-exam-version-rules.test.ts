import { describe, expect, it } from "vitest";
import { avoidSetOf, excludedIds, numberVersions, versionMessage } from "@/lib/mock-exam-version-rules";
import { type PoolQuestion } from "@/lib/mock-exam-rules";
import { selectMockQuestions } from "@/lib/mock-exam-mix";

// US-46 rules: what an alternative version must avoid, how that plugs into selectMockQuestions (US-45's `exclude`), the
// refusal message with the count, and version numbers.

const question = (n: number, topicKey = "tcp"): PoolQuestion => ({
  id: `g${n}`, position: n, text: `Question number ${n} about ${topicKey}.`, paperCount: 1, totalPapers: 3, topicKey, topic: topicKey.toUpperCase(),
  papers: [{ id: "p1", title: "Final", year: 2024 }],
});
const pool = Array.from({ length: 10 }, (_, index) => question(index + 1));

describe("avoidSetOf and excludedIds (US-46)", () => {
  it("avoids every used group, generated item, and question text", () => {
    const avoid = avoidSetOf([
      { groupId: "g1", generatedQuestionId: null, text: "Question number 1 about tcp." },
      { groupId: null, generatedQuestionId: "gen-1", text: "A generated task." },
    ]);
    expect([...avoid.ids].sort()).toEqual(["g1", "gen-1"]);
    expect(avoid.texts.size).toBe(2);
  });
  it("catches a used question that came back under a new group after a regroup, by its text", () => {
    // The old exam's group ID was nulled by a regroup; the same question is now group g7 with other spacing and case.
    const avoid = avoidSetOf([{ groupId: null, generatedQuestionId: null, text: "  QUESTION   number 7 about tcp. " }]);
    expect(excludedIds(pool, [], avoid)).toEqual(new Set(["g7"]));
  });
  it("excludes generated items by ID and by text", () => {
    const generated = [{ id: "gen-1", text: "Explain it." }, { id: "gen-2", text: "Plan a check." }, { id: "gen-3", text: "Something new." }];
    const avoid = avoidSetOf([{ groupId: null, generatedQuestionId: "gen-1", text: "Explain it." }, { groupId: null, generatedQuestionId: null, text: "plan a check" }]);
    expect(excludedIds([], generated, avoid)).toEqual(new Set(["gen-1", "gen-2"]));
  });
});

describe("an alternative through selectMockQuestions (US-46 acceptance tests)", () => {
  const config = { topicKeys: ["tcp"], length: 3, difficulty: "MIXED" as const };
  const ids = (selection: ReturnType<typeof selectMockQuestions>) => (selection.ok ? selection.questions.map(item => item.id) : []);

  it("keeps the settings and shares no question with the earlier versions", () => {
    const first = selectMockQuestions(pool, config);
    const used1 = pool.filter(item => ids(first).includes(item.id)).map(item => ({ groupId: item.id, generatedQuestionId: null, text: item.text }));
    const second = selectMockQuestions(pool, config, { requireFullLength: true, exclude: excludedIds(pool, [], avoidSetOf(used1)) });
    expect(ids(second)).toHaveLength(3);
    expect(ids(second).filter(id => ids(first).includes(id))).toEqual([]);
    // Version 3 avoids versions 1 and 2.
    const used2 = [...used1, ...pool.filter(item => ids(second).includes(item.id)).map(item => ({ groupId: item.id, generatedQuestionId: null, text: item.text }))];
    const third = selectMockQuestions(pool, config, { requireFullLength: true, exclude: excludedIds(pool, [], avoidSetOf(used2)) });
    expect(ids(third)).toHaveLength(3);
    expect(new Set([...ids(first), ...ids(second), ...ids(third)]).size).toBe(9);
    // Only one unused question is left: a fourth version is refused with that count.
    const used3 = [...used2, ...pool.filter(item => ids(third).includes(item.id)).map(item => ({ groupId: item.id, generatedQuestionId: null, text: item.text }))];
    expect(selectMockQuestions(pool, config, { requireFullLength: true, exclude: excludedIds(pool, [], avoidSetOf(used3)) })).toEqual({ ok: false, error: "not_enough_questions", available: 1 });
  });
});

describe("versionMessage (US-46)", () => {
  it("names the count of unused questions and the length needed", () => {
    expect(versionMessage("not_enough_questions", 1, 3)).toBe(
      "Only 1 unused question matches these settings (not in this exam or any of its versions), and a new version needs 3. Make a new mock exam with other topics or a shorter length instead.");
    expect(versionMessage("not_enough_questions", 4, 10)).toContain("Only 4 unused questions match these settings");
    expect(versionMessage("not_enough_questions", 0, 5)).toBe(
      "Every question matching these settings is already in this exam or one of its versions, and a new version needs 5. Make a new mock exam with other topics or a shorter length instead.");
  });
  it("has a message for each other refusal and a safe default", () => {
    expect(versionMessage("not_found")).toBe("That mock exam doesn't exist.");
    expect(versionMessage("topic_invalid")).toContain("no longer in the course");
    expect(versionMessage("rate_limited")).toContain("Wait a while");
    expect(versionMessage("<script>")).toBe("The alternative version could not be made. Please try again.");
  });
});

describe("numberVersions (US-46)", () => {
  it("numbers the family in the order it was made, the original first", () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 15, 10, minute));
    expect(numberVersions([{ id: "c", createdAt: at(3) }, { id: "a", createdAt: at(1) }, { id: "b", createdAt: at(2) }]).map(item => [item.id, item.version]))
      .toEqual([["a", 1], ["b", 2], ["c", 3]]);
    expect(numberVersions([{ id: "y", createdAt: at(1) }, { id: "x", createdAt: at(1) }]).map(item => item.id)).toEqual(["x", "y"]);
  });
});
