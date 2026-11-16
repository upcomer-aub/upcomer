import { describe, expect, it } from "vitest";
import { cleanExtractedQuestion, isExamBoilerplate, isUsableQuestion, questionReviewReason } from "@/lib/question-content";
import { textPdf } from "@/tests/integration/fixtures/pdf";
import { extractExamQuestions, questionsFromLines } from "@/lib/exam-extraction";
import { groupCorrectedQuestions, groupQuestions, rankGroups } from "@/lib/question-grouping";

describe("exam instructions are not questions", () => {
  it("refuses a numbered PDF containing only exam rules instead of saving fake questions", async () => {
    await expect(extractExamQuestions(textPdf([["Exam instructions:", "1. This is an open book exam", "2. No calculators."]]))).rejects.toMatchObject({ reason: "no_questions" });
  });

  it.each([
    "1. This is an open book exam", "2)This is a closed-book exam.", "This exam is open book.",
    "No calculators.", "Calculators are not permitted.", "Time allowed: 90 minutes", "Student ID: ______",
    "Final examination 2025", "Answer all questions.", "Good luck!", "End of exam.",
  ])("rejects complete boilerplate: %s", text => {
    expect(isExamBoilerplate(text)).toBe(true);
    expect(isUsableQuestion({ text })).toBe(false);
  });

  it.each([
    "1. Prove that every tree with n vertices has n-1 edges.",
    "2. Calculate the throughput for a 1500-byte packet.",
    "3. A router receives 100 packets per second. Determine the queue length.",
    "4. Explain why an open book exam may still be difficult.",
    "5. Consider an exam scheduling system. Design its database.",
    "6. This is an open book exam. Explain how you would secure its network.",
    "7. Let x = 5. Find x squared.",
  ])("preserves real exercises without requiring a question mark: %s", text => {
    expect(cleanExtractedQuestion(text)).toBe(text);
    expect(isUsableQuestion({ text })).toBe(true);
  });

  it("filters instructions without needing a recognized heading or numbering restart", () => {
    for (const heading of ["Exam instructions:", "Instructions to candidates:", "Important instructions:", ""]) {
      expect(questionsFromLines([heading, "1. This is an open book exam", "2. No calculators.", "3. Explain TCP flow control."])).toEqual(["3. Explain TCP flow control."]);
    }
  });

  it("removes wrapped rules and trailing boilerplate but preserves subparts", () => {
    expect(cleanExtractedQuestion("1. This is an open\nbook exam")).toBe("");
    expect(questionsFromLines(["1. Explain TCP.", "(a) Describe the window.", "This is an open", "book exam", "Time allowed: 90 minutes"])).toEqual(["1. Explain TCP.\n(a) Describe the window."]);
  });

  it("flags ambiguous text for review without excluding it", () => {
    expect(questionReviewReason("1. Some unusual extracted text")).toContain("Check this entry");
    expect(isUsableQuestion({ text: "1. Some unusual extracted text" })).toBe(true);
    expect(questionReviewReason("1. Calculate x + 2.")).toBeNull();
    expect(isUsableQuestion({ text: "1. Explain TCP.", excludedFromBank: true })).toBe(false);
  });

  it("does not let repeated rules dominate ranking, even with legacy pins or splits", () => {
    const questions = [
      { id: "a", fileId: "p1", number: 1, text: "1. This is an open book exam", year: 2025, splitOut: true },
      { id: "b", fileId: "p2", number: 1, text: "1. This is an open book exam", year: 2024 },
      { id: "c", fileId: "p1", number: 2, text: "2. Explain TCP.", year: 2025, pinnedToQuestionId: "a" },
      { id: "d", fileId: "p2", number: 2, text: "2. Describe UDP.", year: 2024, excludedFromBank: true },
    ];
    expect(rankGroups(groupQuestions(questions)).map(group => group.text)).toEqual(["Explain TCP."]);
    expect(rankGroups(groupCorrectedQuestions(questions)).map(group => group.text)).toEqual(["Explain TCP."]);
  });
});
