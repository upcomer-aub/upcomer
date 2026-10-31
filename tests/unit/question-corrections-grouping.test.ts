import { describe, expect, it } from "vitest";
import { groupCorrectedQuestions, groupQuestions, rankGroups, splitGroupKey, type CorrectedQuestion } from "@/lib/question-grouping";

// Question corrections: pinned and split questions on top of the automatic grouping (US-15a, US-16).

const question = (id: string, fileId: string, text: string, extra: Partial<CorrectedQuestion> = {}): CorrectedQuestion =>
  ({ id, fileId, number: Number(id.replace(/\D/g, "")) || 1, text, year: null, ...extra });
const ids = (groups: { questions: { id: string }[] }[]) => groups.map(group => group.questions.map(item => item.id).sort());

describe("groupCorrectedQuestions", () => {
  const tcp = [question("q1", "f1", "1. Explain TCP."), question("q2", "f2", "1. Explain TCP."), question("q3", "f3", "1. Explain TCP.")];
  const udp = [question("q4", "f1", "2. Explain UDP.")];

  it("groups exactly like the automatic grouping when nothing is corrected", () => {
    expect(groupCorrectedQuestions([...tcp, ...udp])).toEqual(groupQuestions([...tcp, ...udp]));
  });

  it("puts a pinned question in its anchor's group whatever its own text says, and the counts follow", () => {
    const moved = { ...udp[0], pinnedToQuestionId: "q1" };
    const ranked = rankGroups(groupCorrectedQuestions([...tcp, moved]));
    expect(ids(ranked)).toEqual([["q1", "q2", "q3", "q4"]]);
    expect(ranked[0].paperCount).toBe(3);
  });

  it("gives a split question a group of its own that its identical copies do not join", () => {
    const groups = rankGroups(groupCorrectedQuestions([tcp[0], tcp[1], { ...tcp[2], splitOut: true }]));
    expect(ids(groups)).toEqual([["q1", "q2"], ["q3"]]);
    expect(groups.map(group => [group.paperCount, group.rank])).toEqual([[2, 1], [1, 2]]);
    expect(groups[1].normalizedText).toBe(splitGroupKey("explain tcp", "q3"));
    expect(groups[1].text).toBe("Explain TCP.");
  });

  it("lets a question be moved into a split question's group", () => {
    const groups = groupCorrectedQuestions([{ ...tcp[0], splitOut: true }, { ...udp[0], pinnedToQuestionId: "q1" }]);
    expect(ids(groups)).toEqual([["q1", "q4"]]);
  });

  it("follows a chain of pins to the question it ends at", () => {
    const groups = groupCorrectedQuestions([...tcp, { ...udp[0], pinnedToQuestionId: "q5" }, question("q5", "f2", "Explain IP.", { pinnedToQuestionId: "q1" })]);
    expect(ids(groups)).toEqual([["q1", "q2", "q3", "q4", "q5"]]);
  });

  it("ignores a pin to a question that is not in the course anymore", () => {
    expect(ids(groupCorrectedQuestions([...tcp, { ...udp[0], pinnedToQuestionId: "gone" }]))).toEqual([["q1", "q2", "q3"], ["q4"]]);
  });

  it("ignores a loop of pins instead of hanging or dropping the questions", () => {
    const loop = [question("q1", "f1", "Explain TCP.", { pinnedToQuestionId: "q2" }), question("q2", "f2", "Explain UDP.", { pinnedToQuestionId: "q1" })];
    const groups = groupCorrectedQuestions(loop);
    expect(groups.flatMap(group => group.questions.map(item => item.id)).sort()).toEqual(["q1", "q2"]);
  });

  it("lets a split win over a pin left on the same question", () => {
    expect(ids(groupCorrectedQuestions([...tcp.slice(0, 2), { ...udp[0], splitOut: true, pinnedToQuestionId: "q1" }]))).toEqual([["q1", "q2"], ["q4"]]);
  });

  it("groups a question pinned to one with no text left by its own text", () => {
    const empty = question("q9", "f1", "3.");
    expect(ids(groupCorrectedQuestions([empty, { ...udp[0], pinnedToQuestionId: "q9" }]))).toEqual([["q4"]]);
  });

  it("gives the same groups for the same corrections in any input order", () => {
    const input = [...tcp, { ...udp[0], pinnedToQuestionId: "q2" }, question("q6", "f4", "Explain TCP.", { splitOut: true })];
    const first = rankGroups(groupCorrectedQuestions(input)).map(group => [group.normalizedText, group.questions.map(item => item.id).sort()]);
    expect(rankGroups(groupCorrectedQuestions([...input].reverse())).map(group => [group.normalizedText, group.questions.map(item => item.id).sort()])).toEqual(first);
  });
});
