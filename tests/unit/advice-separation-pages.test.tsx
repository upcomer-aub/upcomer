import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicAdvice } from "@/lib/advice";
import type { ConsolidatedExam, ExamQuestion } from "@/lib/consolidated-exam";

// US-42: advice (student opinion) and exam statistics (historical exam data) are labelled and kept apart on the course
// home page, the advice page, and the Upcomer Exam. tests/integration/advice-separation.test.ts shows that advice never
// changes the rankings or counts.

const mocks = vi.hoisted(() => ({
  getCourseById: vi.fn(), getCurrentUser: vi.fn(), searchAdvice: vi.fn(), getAdviceOptions: vi.fn(), getHelpfulCounts: vi.fn(),
  getConsolidatedExam: vi.fn(), getCourseProgress: vi.fn(), getPersonalOrder: vi.fn(),
  getQuestionBank: vi.fn(), getQuestionBankFilterOptions: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));
vi.mock("@/lib/question-bank", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/question-bank")>()),
  getQuestionBank: mocks.getQuestionBank, getQuestionBankFilterOptions: mocks.getQuestionBankFilterOptions,
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser, requireUser: vi.fn() }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/advice", () => ({ searchAdvice: mocks.searchAdvice, getAdviceOptions: mocks.getAdviceOptions, allowAdviceFeedRead: () => true }));
vi.mock("@/lib/advice-votes", () => ({ getHelpfulCounts: mocks.getHelpfulCounts }));
vi.mock("@/lib/advice-comments", () => ({ getAdviceComments: vi.fn(async () => new Map()) }));
vi.mock("@/lib/advice-comment-actions", () => ({ addAdviceCommentAction: vi.fn(), deleteAdviceCommentAction: vi.fn() }));
vi.mock("@/lib/advice-vote-actions", () => ({ setAdviceHelpfulAction: vi.fn() }));
vi.mock("@/components/advice-form", () => ({ AdviceForm: () => null }));
vi.mock("@/lib/consolidated-exam", () => ({ getConsolidatedExam: mocks.getConsolidatedExam }));
vi.mock("@/lib/question-progress", () => ({ getCourseProgress: mocks.getCourseProgress }));
vi.mock("@/lib/personal-order", () => ({ getPersonalOrder: mocks.getPersonalOrder }));
vi.mock("@/lib/question-progress-actions", () => ({ markQuestionAction: vi.fn() }));
vi.mock("@/lib/question-report-actions", () => ({ reportQuestionAction: vi.fn() }));
vi.mock("@/lib/my-courses-actions", () => ({ addCourseAction: vi.fn() }));
import CoursePage from "@/app/courses/[courseId]/page";
vi.mock("@/lib/advice-reports", () => ({ getOpenReportedAdviceIds: async () => new Set<string>() }));
import AdvicePage from "@/app/courses/[courseId]/advice/page";
import ConsolidatedExamPage from "@/app/courses/[courseId]/exam/page";
import QuestionBankPage from "@/app/courses/[courseId]/questions/page";
import { SOURCE_LABELS, SourceLabel } from "@/components/source-label";

const course = { id: "course-a", code: "EECE350", name: "Computer Networks", faculty: { name: "Engineering" }, professors: [] };
const params = Promise.resolve({ courseId: course.id });
const question = (position: number): ExamQuestion => ({
  id: `g${position}`, position, rank: position, text: `Question text ${position}.`, paperCount: 1, totalPapers: 2, tier: "LIKELY",
  papers: [{ id: `p${position}`, title: `Exam ${position}`, year: 2024, examType: "FINAL", term: null, professor: null }],
});
const exam: ConsolidatedExam = { totalPapers: 2, lowConfidence: false, questions: [question(1)], sections: [{ tier: "LIKELY", questions: [question(1)] }] };
const advice = (id: string): PublicAdvice => ({
  id, courseId: course.id, title: `Title ${id}`, body: "Body", resourceUrl: null, resourceTitle: null,
  scope: { kind: "COURSE", label: "EECE350", fileId: null, termId: null, groupId: null, topic: null },
  authorLabel: "Anonymous student", isAnonymous: true, isMine: false, edited: false, createdAt: new Date("2026-11-02T00:00:00Z"),
});
const opinionTag = `data-source="opinion">${SOURCE_LABELS.opinion.tag}</span>`;
const statisticsTag = `data-source="statistics">${SOURCE_LABELS.statistics.tag}</span>`;
const count = (html: string, text: string) => html.split(text).length - 1;

beforeEach(() => {
  mocks.getCourseById.mockReset().mockResolvedValue(course);
  mocks.getCurrentUser.mockReset().mockResolvedValue({ id: "student-1", role: "STUDENT" });
  mocks.searchAdvice.mockReset().mockResolvedValue({ items: [advice("a1"), advice("a2")], total: 2, page: 1, totalPages: 1 });
  mocks.getAdviceOptions.mockReset().mockResolvedValue({ exams: [], terms: [], topics: [], questions: [] });
  mocks.getHelpfulCounts.mockReset().mockResolvedValue(new Map());
  mocks.getConsolidatedExam.mockReset().mockResolvedValue(exam);
  mocks.getCourseProgress.mockReset().mockResolvedValue(new Map());
  mocks.getPersonalOrder.mockReset().mockResolvedValue({ questions: exam.questions, hasProfile: false });
});

describe("SourceLabel (US-42)", () => {
  it("names each source in words, with its explanation, or the tag alone", () => {
    const opinion = renderToStaticMarkup(<SourceLabel kind="opinion" />);
    expect(opinion).toContain(opinionTag);
    expect(opinion).toContain("not exam data; it never changes the question rankings or counts");
    const statistics = renderToStaticMarkup(<SourceLabel kind="statistics" />);
    expect(statistics).toContain(statisticsTag);
    expect(statistics).toContain("student advice never changes these rankings or counts.");
    const tagOnly = renderToStaticMarkup(<SourceLabel kind="opinion" withNote={false} />);
    expect(tagOnly).toContain(opinionTag);
    expect(tagOnly).not.toContain(SOURCE_LABELS.opinion.note);
  });
});

describe("course home page (US-42 acceptance test 1)", () => {
  const sections = async () => {
    const html = renderToStaticMarkup(await CoursePage({ params }));
    const statisticsAt = html.indexOf('id="exam-statistics"');
    const adviceAt = html.indexOf('id="student-advice"');
    expect(statisticsAt).toBeGreaterThan(0);
    expect(adviceAt).toBeGreaterThan(statisticsAt);
    return { resources: html.slice(0, statisticsAt), statistics: html.slice(statisticsAt, adviceAt), advice: html.slice(adviceAt) };
  };

  it("puts exam statistics and advice in separate sections, each with its own label", async () => {
    const { statistics, advice } = await sections();
    expect(statistics).toContain(">Exam statistics</h2>");
    expect(statistics).toContain(statisticsTag);
    expect(statistics).not.toContain(SOURCE_LABELS.opinion.tag);
    expect(advice).toContain(">Advice from previous students</h2>");
    expect(advice).toContain(opinionTag);
    expect(advice).not.toContain(SOURCE_LABELS.statistics.tag);
  });
  it("keeps the question bank and the Upcomer Exam with the statistics, and advice in its own section only", async () => {
    const { resources, statistics, advice } = await sections();
    expect(statistics).toContain('href="/courses/course-a/questions"');
    expect(statistics).toContain('href="/courses/course-a/exam"');
    expect(statistics).not.toContain("/advice");
    expect(advice).toContain('href="/courses/course-a/advice"');
    expect(advice).not.toContain('/questions"');
    expect(advice).not.toContain('/exam"');
    expect(resources).not.toContain("/advice");
  });
});

describe("advice page (US-42)", () => {
  const page = () => AdvicePage({ params, searchParams: Promise.resolve({}) }).then(renderToStaticMarkup);

  it("labels the page as student opinion and points to the exam data elsewhere", async () => {
    const html = await page();
    expect(html).toContain(SOURCE_LABELS.opinion.note);
    expect(html).toContain('What appeared in past exams is in the <a href="/courses/course-a/exam">Upcomer Exam</a> (historical exam data)');
    expect(html).not.toContain(statisticsTag);
  });
  it("tags every post as student opinion", async () => {
    const html = await page();
    expect(count(html, "<article")).toBe(2);
    // One tag in the page label, one per post.
    expect(count(html, opinionTag)).toBe(3);
  });
});

describe("Upcomer Exam header (US-42 acceptance test 2)", () => {
  const page = () => ConsolidatedExamPage({ params, searchParams: Promise.resolve({}) }).then(renderToStaticMarkup);

  it("labels the rankings and counts as historical exam data, for students and visitors, and links to advice apart", async () => {
    for (const user of [{ id: "student-1", role: "STUDENT" }, null]) {
      mocks.getCurrentUser.mockResolvedValue(user);
      const html = await page();
      expect(html).toContain(statisticsTag);
      expect(html).toContain(SOURCE_LABELS.statistics.note);
      expect(html).toContain('Tips are on the <a href="/courses/course-a/advice">Advice</a> page (student opinion)');
      expect(html).not.toContain(opinionTag);
    }
  });
  it("keeps the label when the course has no papers yet", async () => {
    mocks.getConsolidatedExam.mockResolvedValue({ totalPapers: 0, lowConfidence: true, questions: [], sections: [] });
    expect(await page()).toContain(statisticsTag);
  });
  it("never reads advice to build the exam", async () => {
    await page();
    expect(mocks.searchAdvice).not.toHaveBeenCalled();
    expect(mocks.getHelpfulCounts).not.toHaveBeenCalled();
  });
});

describe("Question Bank header (US-42)", () => {
  const page = () => QuestionBankPage({ params, searchParams: Promise.resolve({}) }).then(renderToStaticMarkup);
  beforeEach(() => {
    mocks.getQuestionBankFilterOptions.mockReset().mockResolvedValue({ years: [], examTypes: [], terms: [], professors: [] });
    mocks.getQuestionBank.mockReset().mockResolvedValue({ totalPapers: 2, groups: [] });
  });

  it("labels the frequencies as historical exam data and links to advice apart", async () => {
    const html = await page();
    expect(html).toContain(statisticsTag);
    expect(html).toContain(SOURCE_LABELS.statistics.note);
    expect(html).toContain('Tips are on the <a href="/courses/course-a/advice">Advice</a> page (student opinion)');
    expect(html).not.toContain(opinionTag);
    expect(mocks.searchAdvice).not.toHaveBeenCalled();
  });
  it("keeps the label for a course without questions yet", async () => {
    mocks.getQuestionBank.mockResolvedValue({ totalPapers: 0, groups: [] });
    expect(await page()).toContain(statisticsTag);
  });
});
