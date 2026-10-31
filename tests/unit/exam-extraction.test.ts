import { describe, expect, it } from "vitest";
import { ExtractionError, extractExamQuestions, questionsFromLines } from "@/lib/exam-extraction";
import { corruptPdf, imageOnlyPdf, textPdf } from "@/tests/integration/fixtures/pdf";
import { SAMPLE_EXAMS, samplePdf } from "@/tests/integration/fixtures/sample-exams";

describe("automatic exam extraction", () => {
  it("does not split a wrapped question at a variable beginning with Q and a number", async () => {
    expect(await extractExamQuestions(textPdf([["1. Explain the relation.", "Q2value is the measured charge.", "2. Define latency."]]))).toEqual([
      "1. Explain the relation.\nQ2value is the measured charge.", "2. Define latency.",
    ]);
  });
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

  it("extracts compact labels and colon labels without splitting decimals, times, or sub-parts", async () => {
    expect(await extractExamQuestions(textPdf([["1: Define latency.", "2)Explain throughput.", "3.5 Mbps is the link speed.", "1:20 is the start time.", "(a) Give units.", "(3)Describe jitter.", "Q4.Explain ARP."]]))).toEqual([
      "1: Define latency.", "2)Explain throughput.\n3.5 Mbps is the link speed.\n1:20 is the start time.\n(a) Give units.",
      "(3)Describe jitter.", "Q4.Explain ARP.",
    ]);
  });

  it("reports an unreadable PDF", async () => {
    await expect(extractExamQuestions(corruptPdf())).rejects.toMatchObject({ reason: "unreadable_pdf" });
  });

  it("reports typed pages with no numbered questions", async () => {
    await expect(extractExamQuestions(textPdf([["Instructions only."]]))).rejects.toEqual(new ExtractionError("no_questions"));
  });
});

describe("page furniture, section headings, and instructions (M4 cross-test findings)", () => {
  it("keeps page numbers out of question text", () => {
    expect(questionsFromLines(["1. Explain TCP.", "Page 1 of 2", "slow start", "- 2 -", "2. Explain UDP.", "Page 2"])).toEqual([
      "1. Explain TCP.\nslow start", "2. Explain UDP.",
    ]);
  });

  it("keeps a plain number that is part of a question", () => {
    expect(questionsFromLines(["1. How many packets are sent if the window is", "100"])).toEqual(["1. How many packets are sent if the window is\n100"]);
  });

  it("ends a question at a section heading and keeps the heading out", () => {
    expect(questionsFromLines(["Part A", "1. Define latency.", "Part B: Problems", "Answer two of the three.", "1. Compute the throughput.", "Section II (40 points)", "1. Explain ARP."])).toEqual([
      "1. Define latency.", "1. Compute the throughput.", "1. Explain ARP.",
    ]);
  });

  it("does not take a question line that starts with \"Section\" or \"Part\" for a heading", () => {
    expect(questionsFromLines(["1. Read the RFC.", "Section 3 of the RFC defines the header.", "Part of the header is the checksum."])).toEqual([
      "1. Read the RFC.\nSection 3 of the RFC defines the header.\nPart of the header is the checksum.",
    ]);
  });

  it("drops numbered instructions once a heading or numbering that restarts at 1 shows the questions have begun", () => {
    expect(questionsFromLines(["Instructions:", "1. No calculators.", "2. Answer in the booklet.", "Questions", "1. Define TCP.", "2. Define UDP."])).toEqual([
      "1. Define TCP.", "2. Define UDP.",
    ]);
    expect(questionsFromLines(["Instructions", "1. No calculators.", "2. Answer in the booklet.", "1. Define TCP.", "2. Define UDP."])).toEqual([
      "1. Define TCP.", "2. Define UDP.",
    ]);
  });

  it("keeps the questions when an instructions heading is followed straight by the questions", () => {
    expect(questionsFromLines(["Instructions:", "Answer all questions.", "1. Define TCP.", "2. Define UDP."])).toEqual(["1. Define TCP.", "2. Define UDP."]);
  });

  it("ignores a scanner-app watermark, but not a question that mentions one", () => {
    expect(questionsFromLines(["1. Define TCP.", "Scanned with CamScanner"])).toEqual(["1. Define TCP."]);
    expect(questionsFromLines(["2. Why does Adobe Scan save PDFs as images?"])).toEqual(["2. Why does Adobe Scan save PDFs as images?"]);
  });
});
