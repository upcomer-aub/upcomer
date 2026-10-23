import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  compareWithBaseline, evaluateGrouping, kendallTauB, validateDataset, type Baseline, type EvalDataset, type Grouper, type Metrics,
} from "@/lib/grouping-eval";

// US-93: the accuracy metrics, worked out by hand on small sets.

const set = (papers: EvalDataset["papers"], extra: Partial<EvalDataset> = {}): EvalDataset => ({ name: "toy", version: 1, description: "", papers, ...extra });
const paper = (id: string, year: number, questions: Array<[string, string]>, course = "c") => ({ id, course, title: id, year, questions });

// Gold: A is asked in 3 papers, once reworded ("Describe"), which the rules cannot see; B is in 2 papers.
const toy = set([
  paper("p1", 2024, [["A", "1. Explain TCP."], ["B", "2. Define UDP."]]),
  paper("p2", 2023, [["A", "1) explain tcp"], ["B", "2. Define UDP. (5 points)"]]),
  paper("p3", 2022, [["A", "1. Describe TCP."]]),
]);

describe("evaluateGrouping", () => {
  it("scores the rules on a reworded copy: no false merges, half of the same-question pairs found", () => {
    // Predicted {p1#1, p2#1}, {p3#1}, {p1#2, p2#2}. Gold pairs: 3 (A) + 1 (B) = 4; predicted pairs 2, both right.
    const { metrics, questionCount, goldGroups, predictedGroups, comparisons } = evaluateGrouping(toy);
    expect({ questionCount, goldGroups, predictedGroups }).toEqual({ questionCount: 5, goldGroups: 2, predictedGroups: 3 });
    expect(metrics).toEqual({
      pairPrecision: 1, pairRecall: 0.5, pairF1: 0.6667,
      // B is reproduced exactly; A is split in two.
      exactGroups: 0.5,
      // Only B's two questions show the right count (2); A's show 2 and 1 instead of 3.
      countAccuracy: 0.4,
      // Gold says A (3 papers) above B (2); predicted, A's main group ties B at 2: no order information.
      rankCorrelation: 0,
      // The gold top 5 holds both groups, so every predicted group belongs there.
      topPrecision: 1,
    });
    expect(comparisons.find(item => item.gold === "c/A")).toEqual({ gold: "c/A", questions: ["p1#1", "p2#1", "p3#1"], goldPapers: 3, predictedPapers: 2, splitInto: 2, mergedWith: [] });
  });

  it("scores a perfect grouper 1 everywhere", () => {
    const perfect: Grouper = {
      name: "gold", version: "test",
      group: questions => [...new Set(questions.map(question => (question.text.includes("UDP") ? "B" : "A")))]
        .map(key => ({ normalizedText: key, text: key, questions: questions.filter(question => (question.text.includes("UDP") ? "B" : "A") === key) })),
    };
    expect(Object.values(evaluateGrouping(toy, perfect).metrics)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("charges precision for a merge of different questions", () => {
    const everything: Grouper = { name: "one", version: "test", group: questions => [{ normalizedText: "x", text: "x", questions }] };
    const { metrics, comparisons } = evaluateGrouping(toy, everything);
    // 10 predicted pairs, 4 right.
    expect(metrics.pairPrecision).toBe(0.4);
    expect(metrics.pairRecall).toBe(1);
    expect(comparisons.find(item => item.gold === "c/B")?.mergedWith).toEqual(["c/A"]);
  });

  it("keeps the rules' near-misses apart (TCP and UDP, x^2 and x^3)", () => {
    const nearMisses = set([
      paper("p1", 2024, [["tcp", "1. Explain TCP congestion control."], ["sq", "2. Differentiate x^2 + 1."]]),
      paper("p2", 2023, [["udp", "1. Explain UDP congestion control."], ["cube", "2. Differentiate x^3 + 1."]]),
    ]);
    expect(evaluateGrouping(nearMisses).metrics).toMatchObject({ pairPrecision: 1, pairRecall: 1, exactGroups: 1 });
  });

  it("groups each course on its own, as the app does", () => {
    const twoCourses = set([paper("a1", 2024, [["x", "1. Define a set."]], "math"), paper("b1", 2024, [["x", "1. Define a set."]], "cmps")]);
    const result = evaluateGrouping(twoCourses);
    expect(result.goldGroups).toBe(2);
    expect(result.predictedGroups).toBe(2);
    expect(result.metrics.pairPrecision).toBe(1);
  });

  it("counts a question left with no text as a group of its own", () => {
    const result = evaluateGrouping(set([paper("p1", 2024, [["a", "1."], ["b", "2. Define UDP."]])]));
    expect(result.predictedGroups).toBe(2);
    expect(result.metrics.exactGroups).toBe(1);
  });
});

describe("kendallTauB", () => {
  it.each([
    [[3, 2, 1], [30, 20, 10], 1],
    [[3, 2, 1], [10, 20, 30], -1],
    [[2, 2, 2], [2, 2, 2], 1],
    [[3, 2], [2, 2], 0],
  ])("of %j and %j is %d", (a, b, tau) => expect(kendallTauB(a, b)).toBeCloseTo(tau, 10));
  it("handles ties on both sides", () => expect(kendallTauB([3, 2, 2, 1], [3, 2, 1, 1])).toBeCloseTo(0.8, 10));
});

describe("validateDataset", () => {
  it("accepts a well-formed set", () => expect(validateDataset(toy)).toEqual([]));
  it("lists every problem", () => {
    const broken = set([paper("p1", 2024, [["", "1. Text"], ["a", "  "]]), paper("p1", 2024, [])], { version: 0, notes: { ghost: "?" } });
    expect(validateDataset(broken)).toEqual([
      "version must be a whole number from 1",
      "paper p1 question 1 has no gold group",
      "paper p1 question 2 has no text",
      "paper p1 appears twice",
      "paper p1 has no questions",
      "note for unknown group ghost",
    ]);
  });
});

describe("compareWithBaseline", () => {
  const metrics: Metrics = { pairPrecision: 1, pairRecall: 0.8, pairF1: 0.8889, exactGroups: 0.7, countAccuracy: 0.75, rankCorrelation: 0.9, topPrecision: 1 };
  const baseline: Baseline = { dataset: "toy", datasetVersion: 1, grouper: "rules", metrics, recordedAt: "2026-10-23" };

  it("passes the same result and a small drop, and reports each change", () => {
    const result = compareWithBaseline(toy, { ...metrics, pairRecall: 0.785 }, baseline);
    expect(result.passed).toBe(true);
    expect(result.checks.find(check => check.metric === "pairRecall")).toEqual({ metric: "pairRecall", baseline: 0.8, current: 0.785, change: -0.015, passed: true });
  });

  it("fails a drop larger than the threshold", () => {
    const result = compareWithBaseline(toy, { ...metrics, pairRecall: 0.75 }, baseline);
    expect(result.passed).toBe(false);
    expect(result.checks.find(check => !check.passed)).toMatchObject({ metric: "pairRecall", change: -0.05, reason: "dropped by more than 0.02" });
  });

  it("fails a value under its floor even without a drop", () => {
    const low = { ...metrics, pairPrecision: 0.9 };
    expect(compareWithBaseline(toy, low, { ...baseline, metrics: low }).checks.find(check => !check.passed)).toMatchObject({ metric: "pairPrecision", reason: "below the floor of 0.95" });
  });

  it("passes an improvement", () => expect(compareWithBaseline(toy, { ...metrics, pairRecall: 0.95 }, baseline).passed).toBe(true));

  it("fails without a baseline, or with one recorded for another version of the set", () => {
    expect(compareWithBaseline(toy, metrics, null)).toMatchObject({ passed: false, problems: [expect.stringContaining("No baseline")] });
    expect(compareWithBaseline({ ...toy, version: 2 }, metrics, baseline)).toMatchObject({ passed: false, problems: [expect.stringContaining("toy v1, not toy v2")] });
  });
});

describe("the committed evaluation set", () => {
  it("is valid and has a gold group for every question", async () => {
    const dataset: EvalDataset = JSON.parse(await readFile("eval/grouping/synthetic/dataset.json", "utf8"));
    expect(validateDataset(dataset)).toEqual([]);
    expect(dataset.papers.flatMap(item => item.questions)).toHaveLength(evaluateGrouping(dataset).questionCount);
  });
});
