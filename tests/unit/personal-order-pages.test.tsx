import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConsolidatedExam, ExamQuestion } from "@/lib/consolidated-exam";

// The personal order on the Upcomer Exam page (US-28): the switch, the reordered list, the way back to the frequency
// order, and the note for a student without a learning profile. Ali's report form (US-23) stays under every question.

const mocks = vi.hoisted(() => ({
  getCourseById: vi.fn(), getConsolidatedExam: vi.fn(), getCurrentUser: vi.fn(), getCourseProgress: vi.fn(), getPersonalOrder: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser, requireUser: vi.fn() }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/consolidated-exam", () => ({ getConsolidatedExam: mocks.getConsolidatedExam }));
vi.mock("@/lib/question-progress", () => ({ getCourseProgress: mocks.getCourseProgress }));
vi.mock("@/lib/personal-order", () => ({ getPersonalOrder: mocks.getPersonalOrder }));
vi.mock("@/lib/question-progress-actions", () => ({ markQuestionAction: vi.fn() }));
vi.mock("@/lib/question-report-actions", () => ({ reportQuestionAction: vi.fn() }));
import ConsolidatedExamPage from "@/app/courses/[courseId]/exam/page";

const course = { id: "course-a", code: "EECE350", name: "Computer Networks", faculty: { name: "Engineering" }, professors: [] };
const question = (position: number, tier: ExamQuestion["tier"]): ExamQuestion => ({
  id: `g${position}`, position, rank: position, text: `Question text ${position}.`, paperCount: 1, totalPapers: 2, tier,
  papers: [{ id: `p${position}`, title: `Exam ${position}`, year: 2024, examType: "FINAL", term: null, professor: null }],
});
const questions = [question(1, "VERY_LIKELY"), question(2, "LIKELY"), question(3, "RARE")];
const exam: ConsolidatedExam = {
  totalPapers: 8, lowConfidence: false, questions,
  sections: questions.map(item => ({ tier: item.tier, questions: [item] })),
};
const reordered = [questions[2], questions[0], questions[1]];
const page = (searchParams: Record<string, string> = {}) =>
  ConsolidatedExamPage({ params: Promise.resolve({ courseId: course.id }), searchParams: Promise.resolve(searchParams) }).then(renderToStaticMarkup);
const shownOrder = (html: string) => [...html.matchAll(/Question text (\d)\./g)].map(match => Number(match[1]));

beforeEach(() => {
  mocks.getCourseById.mockReset().mockResolvedValue(course);
  mocks.getConsolidatedExam.mockReset().mockResolvedValue(exam);
  mocks.getCurrentUser.mockReset().mockResolvedValue({ id: "student-1", role: "STUDENT" });
  mocks.getCourseProgress.mockReset().mockResolvedValue(new Map());
  mocks.getPersonalOrder.mockReset().mockResolvedValue({ questions: reordered, hasProfile: true });
});

describe("personal order on the Upcomer Exam (US-28)", () => {
  it("shows the frequency order by default, with a switch to the personal order, and never computes it", async () => {
    const html = await page();
    expect(shownOrder(html)).toEqual([1, 2, 3]);
    expect(html).toContain('<a aria-current="page" href="/courses/course-a/exam">Frequency order</a>');
    expect(html).toContain('href="/courses/course-a/exam?order=personal">Personal order</a>');
    expect(html).toContain("the most likely first.");
    expect(mocks.getPersonalOrder).not.toHaveBeenCalled();
  });
  it("in personal mode, reorders the questions by the session student's priorities in this course, in one list", async () => {
    const html = await page({ order: "personal" });
    expect(mocks.getPersonalOrder).toHaveBeenCalledWith("student-1", "course-a", questions);
    expect(shownOrder(html)).toEqual([3, 1, 2]);
    expect(html).toContain("Your order");
    expect(html).toContain("in your personal order.");
    expect(html).toContain('<a aria-current="page" href="/courses/course-a/exam?order=personal">Personal order</a>');
    // One list instead of the tier sections; each question keeps its number, tier badge, and report form.
    expect(html).not.toMatch(/<h2 id="tier-/);
    expect(html.match(/Question 3 <span/)).toHaveLength(1);
    expect(html).toContain(">Rare</span>");
    expect(html.match(/Report a problem with question \d/g)).toEqual(["Report a problem with question 3", "Report a problem with question 1", "Report a problem with question 2"]);
  });
  it("comes back to the personal order after marking a question there", async () => {
    const html = await page({ order: "personal" });
    expect(html.match(/name="order" value="personal"/g)).toHaveLength(3);
    expect(await page()).not.toContain('name="order"');
  });
  it("continues at the first question not done in the order shown", async () => {
    mocks.getCourseProgress.mockResolvedValue(new Map([["g3", { doneAt: new Date() }]]));
    expect(await page({ order: "personal" })).toContain("Continue at question 1");
    mocks.getCourseProgress.mockResolvedValue(new Map([["g1", { doneAt: new Date() }]]));
    expect(await page()).toContain("Continue at question 2");
  });
  it("tells a student without a learning profile that this is the frequency order", async () => {
    mocks.getPersonalOrder.mockResolvedValue({ questions, hasProfile: false });
    const html = await page({ order: "personal" });
    expect(html).toContain("You have no learning profile for this course yet, so this is the frequency order.");
    expect(shownOrder(html)).toEqual([1, 2, 3]);
    expect(html).toMatch(/<h2 id="tier-/);
  });
  it("gives a visitor the frequency order, with no switch", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const html = await page({ order: "personal" });
    expect(mocks.getPersonalOrder).not.toHaveBeenCalled();
    expect(shownOrder(html)).toEqual([1, 2, 3]);
    expect(html).not.toContain("Personal order</a>");
  });
  it("ignores any other order value", async () => {
    expect(shownOrder(await page({ order: "<script>" }))).toEqual([1, 2, 3]);
    expect(mocks.getPersonalOrder).not.toHaveBeenCalled();
  });
});

describe("weak-topic practice link on the Upcomer Exam (US-31)", () => {
  const link = '<a href="/courses/course-a/practice/weak-topics">Practice your weak topics</a>';
  it("links a logged-in student to their practice set, in either order", async () => {
    expect(await page()).toContain(link);
    expect(await page({ order: "personal" })).toContain(link);
  });
  it("shows no practice link to a visitor", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    expect(await page()).not.toContain("Practice your weak topics");
  });
});
