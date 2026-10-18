import { describe, expect, it } from "vitest";
import { ExtractionError, extractExamQuestions } from "@/lib/exam-extraction";
import { corruptPdf, imageOnlyPdf, textPdf } from "@/tests/integration/fixtures/pdf";
import { SAMPLE_EXAMS, samplePdf } from "@/tests/integration/fixtures/sample-exams";

describe("automatic exam extraction", () => {
  it("reads every sample paper used by the exam pipeline", async () => {
    for (const exam of SAMPLE_EXAMS) {
      expect(await extractExamQuestions(samplePdf(exam))).toEqual(exam.questions);
    }
  });

  it("accepts a question label on its own line", async () => {
    expect(await extractExamQuestions(textPdf([["Question 1", "Define a socket.", "2.", "Explain TCP."]]))).toEqual([
      "Question 1\nDefine a socket.", "2.\nExplain TCP.",
    ]);
  });

  it("extracts numbered questions from a typed PDF and keeps their sub-parts", async () => {
    const pdf = textPdf([
      ["Final Exam 2025", "Answer all questions.", "1. Define a socket.", "(a) Give an example", "(b) Explain its use", "Q2. Explain TCP."],
      ["Question 3: What is UDP?"],
    ]);
    expect(await extractExamQuestions(pdf)).toEqual([
      "1. Define a socket.\n(a) Give an example\n(b) Explain its use",
      "Q2. Explain TCP.",
      "Question 3: What is UDP?",
    ]);
  });

  it("reports no extractable text for an image-only PDF", async () => {
    await expect(extractExamQuestions(imageOnlyPdf())).rejects.toMatchObject({ reason: "no_text" });
  });

  it("reports an unreadable PDF", async () => {
    await expect(extractExamQuestions(corruptPdf())).rejects.toMatchObject({ reason: "unreadable_pdf" });
  });

  it("reports typed pages with no numbered questions", async () => {
    await expect(extractExamQuestions(textPdf([["Instructions only."]]))).rejects.toEqual(new ExtractionError("no_questions"));
  });
});
