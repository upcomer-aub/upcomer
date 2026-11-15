import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExamQuestion } from "@/lib/consolidated-exam";
import type { PracticeQuestion, PracticeSet } from "@/lib/practice-set";

// The weak-topic practice page (US-31, /courses/:courseId/practice/weak-topics): the set, the size form, the topic breakdown, the frequency fallback, and a course without
// questions.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), getCourseById: vi.fn(), getPracticeSet: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser, getCurrentUser: vi.fn() }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/practice-set", async importOriginal => ({ ...(await importOriginal<object>()), getPracticeSet: mocks.getPracticeSet }));
import PracticeSetPage from "@/app/courses/[courseId]/practice/weak-topics/page";

const course = { id: "course-a", code: "EECE350", name: "Computer Networks", faculty: { name: "Engineering" }, professors: [] };
const question = (position: number, topic: string | null): PracticeQuestion => ({
  id: `g${position}`, position, rank: position, text: `Question text ${position}.`, paperCount: 2, totalPapers: 5, tier: "LIKELY" as ExamQuestion["tier"],
  papers: [{ id: `p${position}`, title: `Exam ${position}`, year: 2024, examType: "FINAL", term: null, professor: null }], topic,
});
const weakSet: PracticeSet = {
  mode: "weak_topics", available: 12,
  questions: [question(4, "DNS"), question(6, "DNS"), question(9, null), question(1, "TCP"), question(2, "TCP")],
  topics: [
    { topicKey: "dns", topic: "DNS", weakness: 1, count: 2 },
    { topicKey: "", topic: null, weakness: 0.5, count: 1 },
    { topicKey: "tcp", topic: "TCP", weakness: 0, count: 2 },
  ],
};
const page = (searchParams: Record<string, string> = {}) =>
  PracticeSetPage({ params: Promise.resolve({ courseId: course.id }), searchParams: Promise.resolve(searchParams) }).then(renderToStaticMarkup);
const shown = (html: string) => [...html.matchAll(/Question text (\d+)\./g)].map(match => Number(match[1]));

beforeEach(() => {
  mocks.requireUser.mockReset().mockResolvedValue({ id: "student-1", role: "STUDENT" });
  mocks.getCourseById.mockReset().mockResolvedValue(course);
  mocks.getPracticeSet.mockReset().mockResolvedValue(weakSet);
  mocks.notFound.mockClear();
});

describe("practice page (US-31)", () => {
  it("requires a session and comes back to the practice page after logging in", async () => {
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT /login?next=/courses/course-a/practice/weak-topics"));
    await expect(page()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.requireUser).toHaveBeenCalledWith("/courses/course-a/practice/weak-topics");
    expect(mocks.getPracticeSet).not.toHaveBeenCalled();
  });
  it("shows the not-found page for an unknown course", async () => {
    mocks.getCourseById.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.getPracticeSet).not.toHaveBeenCalled();
  });
  it("builds the session student's set in this course with the default size of 10", async () => {
    const html = await page();
    expect(mocks.getPracticeSet).toHaveBeenCalledWith("student-1", "course-a", 10);
    expect(html).toContain("<h1>Practice your weak topics</h1>");
    expect(html).toContain('<option value="10" selected="">10 questions</option>');
    expect(html).toContain('action="/courses/course-a/practice/weak-topics" method="get"');
    expect(html).toContain("Questions you marked done are included.");
    // US-42: the questions and their counts are historical exam data; the topic mix is the student's own profile.
    expect(html).toContain('data-source="statistics">Historical exam data</span>');
    expect(html).toContain("The mix of topics follows your own ratings and practice.");
    expect(html).not.toContain('data-source="opinion"');
  });
  it("uses an offered size from the form and ignores any other", async () => {
    await page({ size: "20" });
    expect(mocks.getPracticeSet).toHaveBeenLastCalledWith("student-1", "course-a", 20);
    await page({ size: "500" });
    expect(mocks.getPracticeSet).toHaveBeenLastCalledWith("student-1", "course-a", 10);
  });
  it("lists the set in its order, each question with its exam number, topic, evidence, and a link to it on the exam", async () => {
    const html = await page({ size: "5" });
    expect(shown(html)).toEqual([4, 6, 9, 1, 2]);
    expect(html).toContain("Your practice set <span");
    expect(html).toContain("· 5 questions");
    expect(html).toContain("Question 4 · DNS");
    expect(html).toContain("Appeared in 2 of 5 papers");
    expect(html).toContain('href="/courses/course-a/exam#question-4">Attempt it in the Upcomer Exam</a>');
  });
  it("shows how many questions each topic got and whether it is a weaker or stronger topic", async () => {
    const html = await page({ size: "5" });
    expect(html).toContain('aria-label="Questions per topic"');
    expect(html).toMatch(/<strong>DNS<\/strong> <span class="muted">· weaker topic · 2 questions<\/span>/);
    expect(html).toMatch(/<strong>Questions without a topic<\/strong> <span class="muted">· no topic · 1 question<\/span>/);
    expect(html).toMatch(/<strong>TCP<\/strong> <span class="muted">· stronger topic · 2 questions<\/span>/);
    expect(html).not.toContain("no weak topics");
  });
  it("says so when the set falls back to the exam frequency, with a link to rate topics", async () => {
    mocks.getPracticeSet.mockResolvedValue({ ...weakSet, mode: "frequency", questions: [question(1, "TCP"), question(2, "TCP")] });
    const html = await page();
    expect(html).toContain("You have no weak topics in this course yet, so this set follows the exam frequency");
    expect(html).toContain('href="/courses/course-a/confidence">Rate your topics</a>');
    expect(html).not.toContain("Questions per topic");
  });
  it("says the set has every question when the course has fewer than asked", async () => {
    mocks.getPracticeSet.mockResolvedValue({ ...weakSet, available: 5 });
    expect(await page({ size: "20" })).toContain("This course has only 5 questions, so the set has all of them.");
    expect(await page({ size: "5" })).not.toContain("so the set has all of them");
  });
  it("shows a message and no form for a course without questions", async () => {
    mocks.getPracticeSet.mockResolvedValue({ mode: "frequency", questions: [], topics: [], available: 0 });
    const html = await page();
    expect(html).toContain("This course has no questions to practice yet.");
    expect(html).not.toContain("<form");
  });
  it("shows topics as text, never as markup", async () => {
    mocks.getPracticeSet.mockResolvedValue({ ...weakSet, questions: [question(1, "<b>x</b>")], topics: [{ topicKey: "<b>x</b>", topic: "<b>x</b>", weakness: 1, count: 1 }] });
    const html = await page();
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
