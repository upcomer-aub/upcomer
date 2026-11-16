import { describe, expect, it } from "vitest";
import { buildResultsReport, NO_TOPIC, percent, type ResultQuestion } from "@/lib/mock-results-rules";

// US-50: the score and the topic breakdown come only from the stored marking, and unmarked questions never count.

const q = (position: number, topic: string | null, outcome: ResultQuestion["outcome"], matched: string[] = [], missed: string[] = []): ResultQuestion => ({
  id: `mq-${position}`, position, topic, text: `Question ${position}`, outcome, matchedPoints: matched, missedPoints: missed, feedback: missed.length ? "Missed." : null,
});

describe("buildResultsReport", () => {
  const report = buildResultsReport([
    q(3, "TCP", "PARTIAL", ["a"], ["b"]),
    q(1, "TCP", "CORRECT", ["a", "b"]),
    q(2, "DNS", "INCORRECT", [], ["c"]),
    q(4, "DNS", "UNANSWERED", [], ["d", "e"]),
    q(5, "DNS", "NO_KEY"),
    q(6, null, "NO_KEY"),
  ]);

  it("scores only the marked questions, with partial credit for covered key points", () => {
    expect(report).toMatchObject({ questions: 6, marked: 4, counts: { CORRECT: 1, PARTIAL: 1, INCORRECT: 1, UNANSWERED: 1, NO_KEY: 2 } });
    // (1 + 0.5 + 0 + 0) / 4
    expect(report.credit).toBeCloseTo(0.375);
    expect(percent(report.credit)).toBe("38%");
  });

  it("breaks the result down by topic, weakest first, with unmarkable topics last", () => {
    expect(report.topics.map(topic => [topic.topic, topic.questions, topic.marked, topic.credit])).toEqual([
      ["DNS", 3, 2, 0],
      ["TCP", 2, 2, 0.75],
      [NO_TOPIC, 1, 0, null],
    ]);
    expect(report.topics[0].counts).toEqual({ CORRECT: 0, PARTIAL: 0, INCORRECT: 1, UNANSWERED: 1, NO_KEY: 1 });
  });

  it("lists the missed items and the unmarked ones in exam order", () => {
    expect(report.missed.map(item => item.position)).toEqual([2, 3, 4]);
    expect(report.notMarked.map(item => item.position)).toEqual([5, 6]);
  });

  it("has no score when nothing could be marked, and treats a missing outcome as not marked", () => {
    const none = buildResultsReport([q(1, "TCP", "NO_KEY"), q(2, "TCP", null)]);
    expect(none).toMatchObject({ marked: 0, credit: null, missed: [] });
    expect(none.notMarked).toHaveLength(2);
    expect(percent(none.credit)).toBe("–");
  });

  it("sorts topics with the same credit by name", () => {
    const tie = buildResultsReport([q(1, "b", "CORRECT", ["x"]), q(2, "a", "CORRECT", ["x"])]);
    expect(tie.topics.map(topic => topic.topic)).toEqual(["a", "b"]);
  });
});
