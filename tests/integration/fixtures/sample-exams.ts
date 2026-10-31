import { corruptPdf, imageOnlyPdf, textPdf } from "./pdf";

// Five past exams of one course, as real text PDFs, with the questions an extractor must find in each (US-14's output).
// They repeat questions with the small differences real papers have, chosen against the grouping rules in
// lib/question-grouping.ts: numbering styles, case, punctuation, mark labels, and one typo in a long word must group;
// a different acronym (TCP/UDP vs TCP/IP) or exponent (x^2 vs x^3) must not. A contraction ("What's" for "What is") is a
// rewording, which these rules leave to US-15b, so it is not used here.

export type SampleExam = {
  title: string; year: number; examType: "MIDTERM" | "FINAL"; fileName: string;
  // Lines of the paper that are not questions: the header and instructions.
  header: string[];
  // Each question as printed, sub-parts on their own lines.
  questions: string[];
};

export const SAMPLE_EXAMS: SampleExam[] = [
  {
    title: "Final 2021", year: 2021, examType: "FINAL", fileName: "final-2021.pdf",
    header: ["EECE 350 Computer Networks - Final Exam - Fall 2021", "Duration: 2 hours. Answer all questions."],
    questions: [
      "1. Define TCP and explain the three-way handshake. (10 points)",
      "2. What is the difference between TCP and UDP?",
      "3. Explain the sliding window protocol.",
      "4. Compute x^3 + 1 for x = 3.",
    ],
  },
  {
    title: "Midterm 2022", year: 2022, examType: "MIDTERM", fileName: "midterm-2022.pdf",
    header: ["Midterm Exam - Spring 2022"],
    questions: [
      "Q1. define tcp and explain the three-way handshake",
      "Q2. Explain how ARP resolves an IP address to a MAC address.",
    ],
  },
  {
    title: "Final 2022", year: 2022, examType: "FINAL", fileName: "final-2022.pdf",
    header: ["Final Exam 2022", "Closed book."],
    questions: [
      "Question 1: Define TCP, and explain the three-way handshake!",
      "Question 2: What is the difference between TCP and UDP ?",
      "Question 3: Describe how DNS resolves a domain name.\n(a) using iterative queries\n(b) using recursive queries",
    ],
  },
  {
    title: "Midterm 2023", year: 2023, examType: "MIDTERM", fileName: "midterm-2023.pdf",
    header: ["EECE 350 Midterm 2023"],
    questions: [
      "(1) Define TCP and explain the three-way handshake [5 marks]",
      "(2) Explain how ARP resolves an IP address to a MAC address",
      "(3) What is the difference between TCP and IP?",
    ],
  },
  {
    title: "Final 2024", year: 2024, examType: "FINAL", fileName: "final-2024.pdf",
    header: ["Computer Networks Final 2024", "Write clearly."],
    questions: [
      "1) Define TCP and explain the three-way hanshake.",
      "2) what is the difference between tcp and udp",
      "3) Explain the sliding window protocol (8 pts)",
      "4) Compute x^2 + 1 for x = 3.",
    ],
  },
];

// The text PDF of a sample: the header, then each question line by line.
export const samplePdf = (exam: SampleExam) => textPdf([[...exam.header, ...exam.questions.flatMap(question => question.split("\n"))]]);

// The consolidated ordered exam the five samples must produce (US-18), with the tier of each question (US-19):
// most papers first; ties go to the most recent year (sliding window, last seen 2024, before ARP, last seen 2023).
export const EXPECTED_EXAM = {
  totalPapers: 5,
  lowConfidence: false,
  questions: [
    { text: "Define TCP and explain the three-way handshake.", paperCount: 5, tier: "VERY_LIKELY", years: [2024, 2023, 2022, 2022, 2021] },
    { text: "What is the difference between TCP and UDP?", paperCount: 3, tier: "VERY_LIKELY", years: [2024, 2022, 2021] },
    { text: "Explain the sliding window protocol.", paperCount: 2, tier: "LIKELY", years: [2024, 2021] },
    { text: "Explain how ARP resolves an IP address to a MAC address.", paperCount: 2, tier: "LIKELY", years: [2023, 2022] },
    { text: "Compute x^2 + 1 for x = 3.", paperCount: 1, tier: "RARE", years: [2024] },
    { text: "What is the difference between TCP and IP?", paperCount: 1, tier: "RARE", years: [2023] },
    { text: "Describe how DNS resolves a domain name.\n(a) using iterative queries\n(b) using recursive queries", paperCount: 1, tier: "RARE", years: [2022] },
    { text: "Compute x^3 + 1 for x = 3.", paperCount: 1, tier: "RARE", years: [2021] },
  ],
  sections: [["VERY_LIKELY", 2], ["LIKELY", 2], ["RARE", 4]],
} as const;

// Uploads that must not add anything to the ordered exam. Each ends in a failed processing run.
export const FAILING_SAMPLES = [
  { title: "Scanned Final", fileName: "scanned-final.pdf", bytes: imageOnlyPdf(), reason: "no_text" },
  { title: "Broken Final", fileName: "broken-final.pdf", bytes: corruptPdf(), reason: "unreadable_pdf" },
] as const;
