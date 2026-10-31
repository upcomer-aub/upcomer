import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConsolidatedExam, ExamQuestion } from "@/lib/consolidated-exam";
import type { LikelihoodTier } from "@/lib/likelihood-tiers";

const mocks = vi.hoisted(() => ({
  getCourseById: vi.fn(), getConsolidatedExam: vi.fn(), getCurrentUser: vi.fn(), notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser, requireUser: vi.fn() }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/consolidated-exam", () => ({ getConsolidatedExam: mocks.getConsolidatedExam }));
import ConsolidatedExamPage from "@/app/courses/[courseId]/exam/page";
import CoursePage from "@/app/courses/[courseId]/page";

const course = { id: "course-a", code: "EECE350", name: "Computer Networks", faculty: { name: "Engineering" }, professors: [] };
const paper = (id: string, year: number | null, term: string | null, examType: "FINAL" | "MIDTERM" | null = "FINAL") =>
  ({ id, title: `Exam ${id}`, year, examType, term: term ? { id: `term-${term}`, name: term } : null, professor: null });
const question = (position: number, text: string, tier: LikelihoodTier, papers: ReturnType<typeof paper>[], totalPapers: number): ExamQuestion =>
  ({ id: `g${position}`, position, rank: position, text, paperCount: papers.length, totalPapers, papers, tier });
const exam = (questions: ExamQuestion[], totalPapers: number, lowConfidence = false): ConsolidatedExam => {
  const sections: ConsolidatedExam["sections"] = [];
  for (const item of questions) {
    if (sections.at(-1)?.tier === item.tier) sections.at(-1)!.questions.push(item);
    else sections.push({ tier: item.tier, questions: [item] });
  }
  return { totalPapers, lowConfidence, questions, sections };
};
const sixPapers = [paper("p6", 2026, "Fall"), paper("p5", 2025, "Spring", "MIDTERM"), paper("p4", 2024, "Fall"), paper("p3", 2023, null), paper("p2", null, "Fall"), paper("p1", 2021, "Fall")];
const full = exam([
  question(1, "Explain the TCP three-way handshake.", "VERY_LIKELY", sixPapers.slice(0, 4), 6),
  question(2, "Consider the network below.\n(a) Find the subnet mask.\n(b) How many hosts fit?", "LIKELY", sixPapers.slice(1, 3), 6),
  question(3, "Define a socket.", "RARE", [sixPapers[4]], 6),
], 6);
const page = async (courseId = course.id) => renderToStaticMarkup(await ConsolidatedExamPage({ params: Promise.resolve({ courseId }), searchParams: Promise.resolve({}) }));

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockClear());
  mocks.getCourseById.mockReset().mockResolvedValue(course);
  mocks.getConsolidatedExam.mockReset().mockResolvedValue(full);
  mocks.getCurrentUser.mockReset().mockResolvedValue(null);
});

describe("consolidated exam page (US-18)", () => {
  it("shows every distinct question once, in ranking order, numbered down the page", async () => {
    const html = await page();
    expect(mocks.getConsolidatedExam).toHaveBeenCalledWith(course.id);
    expect(html).toContain("Upcomer Exam");
    expect(html).toContain("3 distinct questions from 6 previous exams, the most likely first.");
    const order = ["Explain the TCP three-way handshake.", "Consider the network below.", "Define a socket."].map(text => html.indexOf(text));
    expect(order.every(index => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.split("Define a socket.").length - 1).toBe(1);
    expect(html.match(/Question \d/g)).toEqual(["Question 1", "Question 2", "Question 3"]);
    // The tier badge is read as a separate word.
    expect(html).toMatch(/Question 1 <span class="[^"]*">Very likely<\/span>/);
    // Each tier's list continues the numbering of the one before it.
    expect(html.match(/<ol [^>]*start="(\d+)"/g)?.map(tag => tag.match(/start="(\d+)"/)![1])).toEqual(["1", "2", "3"]);
  });
  it("shows the full text of a question with sub-parts together, keeping its lines", async () => {
    const html = await page();
    expect(html).toContain("Consider the network below.\n(a) Find the subnet mask.\n(b) How many hosts fit?");
  });
  it("says the course has no processed papers instead of showing an empty list", async () => {
    mocks.getConsolidatedExam.mockResolvedValue(exam([], 0));
    const html = await page();
    expect(html).toContain("No exam papers have been processed for this course yet.");
    expect(html).not.toContain("<ol");
    expect(html).not.toContain("previous exams, the most likely first");
  });
  it("says the questions are still being prepared when papers exist but nothing is grouped yet", async () => {
    mocks.getConsolidatedExam.mockResolvedValue(exam([], 2, true));
    const html = await page();
    expect(html).toContain("still being prepared");
    expect(html).not.toContain("<ol");
    expect(html).not.toContain("Low confidence");
  });
  it("returns not found for an unknown course without loading an exam", async () => {
    mocks.getCourseById.mockResolvedValue(null);
    await expect(page("course-x")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.getConsolidatedExam).not.toHaveBeenCalled();
  });
  it("lets a failure reach the error page", async () => {
    mocks.getConsolidatedExam.mockRejectedValue(new Error("down"));
    await expect(page()).rejects.toThrow("down");
  });
  it("is linked from the course home page", async () => {
    const html = renderToStaticMarkup(await CoursePage({ params: Promise.resolve({ courseId: course.id }) }));
    expect(html).toContain("Upcomer Exam");
    expect(html).toContain('href="/courses/course-a/exam"');
  });
});

describe("repetition evidence (US-17)", () => {
  it("shows \"Appeared in X of Y papers\" with the course's paper count", async () => {
    const html = await page();
    expect(html).toContain("Appeared in 4 of 6 papers");
    expect(html).toContain("Appeared in 2 of 6 papers");
    expect(html).toContain("Appeared in 1 of 6 papers");
  });
  it("uses the singular for a course with one paper", async () => {
    mocks.getConsolidatedExam.mockResolvedValue(exam([question(1, "Define a socket.", "VERY_LIKELY", [sixPapers[0]], 1)], 1, true));
    const html = await page();
    expect(html).toContain("Appeared in 1 of 1 paper<");
    expect(html).toContain("Show the source paper<");
    expect(html).toContain("1 distinct question from 1 previous exam,");
  });
  it("lists the source papers with their year and session behind an expandable summary", async () => {
    const html = await page();
    expect(html.match(/<details/g)).toHaveLength(3);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain("<summary>Show the 4 source papers</summary>");
    expect(html).toContain('<a href="/files/p6" target="_blank" rel="noopener noreferrer">Exam p6</a>');
    expect(html).toContain("2026 · Fall · Final");
    expect(html).toContain("2025 · Spring · Midterm");
    // A missing year or session is shown as unknown rather than left out.
    expect(html).toContain("2023 · Session unknown · Final");
    expect(html).toContain("Year unknown · Fall · Final");
    const first = html.slice(html.indexOf('id="question-1"'), html.indexOf('id="question-2"'));
    expect(first.match(/<li>/g)).toHaveLength(4);
    expect(first.indexOf("Exam p6")).toBeLessThan(first.indexOf("Exam p3"));
  });
});

describe("likelihood tiers (US-19)", () => {
  it("puts each question in exactly one tier under its heading, most likely first", async () => {
    const html = await page();
    const headings = [...html.matchAll(/<h2 id="tier-[A-Z_]+-\d+">([^<]+)</g)].map(match => match[1].trim());
    expect(headings).toEqual(["Very likely", "Likely", "Rare"]);
    expect(html.match(/data-tier="[A-Z_]+"/g)).toEqual(['data-tier="VERY_LIKELY"', 'data-tier="LIKELY"', 'data-tier="RARE"']);
    expect(html.indexOf("Very likely")).toBeLessThan(html.indexOf("Explain the TCP"));
    expect(html.indexOf(">Rare<")).toBeLessThan(html.indexOf("Define a socket."));
  });
  it("skips a tier that has no questions", async () => {
    mocks.getConsolidatedExam.mockResolvedValue(exam([full.questions[0], { ...full.questions[2], position: 2 }], 6));
    const html = await page();
    expect([...html.matchAll(/<h2 id="tier-[A-Z_]+-\d+">([^<]+)</g)].map(match => match[1].trim())).toEqual(["Very likely", "Rare"]);
  });
  it("adds a low-confidence note when the course has fewer papers than the minimum", async () => {
    mocks.getConsolidatedExam.mockResolvedValue(exam(full.questions.map(item => ({ ...item, totalPapers: 3 })), 3, true));
    const html = await page();
    expect(html).toContain('role="note"');
    expect(html).toContain("Low confidence: these tiers are based on only 3 previous exams. They become more reliable from 5 papers.");
  });
  it("has no low-confidence note from the minimum up", async () => {
    expect(await page()).not.toContain("Low confidence");
  });
});
