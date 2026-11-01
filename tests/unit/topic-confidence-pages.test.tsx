import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The topic confidence page and its action (US-24), and the "Rate your topics" link on the Upcomer Exam page (US-28).

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), getCurrentUser: vi.fn(), getCourseById: vi.fn(), getCourseTopics: vi.fn(), getTopicConfidence: vi.fn(), saveTopicConfidence: vi.fn(),
  getConsolidatedExam: vi.fn(), getCourseProgress: vi.fn(), getPersonalOrder: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser, getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/topic-confidence", () => ({ getCourseTopics: mocks.getCourseTopics, getTopicConfidence: mocks.getTopicConfidence, saveTopicConfidence: mocks.saveTopicConfidence }));
vi.mock("@/lib/consolidated-exam", () => ({ getConsolidatedExam: mocks.getConsolidatedExam }));
vi.mock("@/lib/question-progress", () => ({ getCourseProgress: mocks.getCourseProgress }));
vi.mock("@/lib/personal-order", () => ({ getPersonalOrder: mocks.getPersonalOrder }));
vi.mock("@/lib/question-progress-actions", () => ({ markQuestionAction: vi.fn() }));
vi.mock("@/lib/question-report-actions", () => ({ reportQuestionAction: vi.fn() }));
import TopicConfidencePage from "@/app/courses/[courseId]/confidence/page";
import ConsolidatedExamPage from "@/app/courses/[courseId]/exam/page";
import { saveTopicConfidenceAction } from "@/lib/topic-confidence-actions";

const course = { id: "course-a", code: "EECE350", name: "Computer Networks", faculty: { name: "Engineering" }, professors: [] };
const student = { id: "student-1", role: "STUDENT" };
const page = (searchParams: Record<string, string> = {}, courseId = course.id) =>
  TopicConfidencePage({ params: Promise.resolve({ courseId }), searchParams: Promise.resolve(searchParams) }).then(renderToStaticMarkup);
// The checked radio of each topic, as "topicKey=value".
const checked = (html: string) => [...html.matchAll(/<input [^>]*type="radio"[^>]*>/g)]
  .filter(([input]) => input.includes('checked=""'))
  .map(([input]) => `${/name="rating:([^"]+)"/.exec(input)![1]}=${/value="([^"]+)"/.exec(input)![1]}`);

beforeEach(() => {
  mocks.requireUser.mockReset().mockResolvedValue(student);
  mocks.getCurrentUser.mockReset().mockResolvedValue(student);
  mocks.getCourseById.mockReset().mockResolvedValue(course);
  mocks.getCourseTopics.mockReset().mockResolvedValue([{ topicKey: "dns", topic: "DNS" }, { topicKey: "routing", topic: "Routing" }, { topicKey: "tcp", topic: "TCP" }]);
  mocks.getTopicConfidence.mockReset().mockResolvedValue(new Map());
  mocks.saveTopicConfidence.mockReset();
  mocks.notFound.mockClear();
  mocks.redirect.mockClear();
});

describe("the topic confidence page (US-24)", () => {
  it("sends a visitor to log in and back to this page", async () => {
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(page()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.requireUser).toHaveBeenCalledWith("/courses/course-a/confidence");
    expect(mocks.getTopicConfidence).not.toHaveBeenCalled();
  });
  it("shows the not-found page for an unknown course", async () => {
    mocks.getCourseById.mockResolvedValue(null);
    await expect(page({}, "no-such-course")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.getCourseTopics).not.toHaveBeenCalled();
  });
  it("lists each topic with the 1-5 scale and Skip, in one form", async () => {
    const html = await page();
    expect(html).toContain("<h1>Rate your topics</h1>");
    expect(html.match(/<form/g)).toHaveLength(1);
    for (const topic of ["DNS", "Routing", "TCP"]) expect(html).toContain(`<legend>${topic}</legend>`);
    expect(html).toContain("1 · Not confident");
    expect(html).toContain("5 · Very confident");
    expect(html.match(/value="skip"/g)).toHaveLength(3);
    expect(html).toContain('name="courseId" value="course-a"');
    expect(html).not.toContain("student-1");
  });
  it("is pre-filled with the student's saved ratings; a skipped or unrated topic shows Skip", async () => {
    mocks.getTopicConfidence.mockResolvedValue(new Map([["tcp", 2], ["routing", null]]));
    expect(checked(await page())).toEqual(["dns=skip", "routing=skip", "tcp=2"]);
    expect(mocks.getTopicConfidence).toHaveBeenCalledWith("student-1", "course-a");
  });
  it("shows a clear message instead of an empty form for a course without topics", async () => {
    mocks.getCourseTopics.mockResolvedValue([]);
    const html = await page();
    expect(html).toContain("This course&#x27;s exam papers have no topics yet, so there is nothing to rate.");
    expect(html).not.toContain("<form");
  });
  it("confirms a save with a link to the personal order, and shows a refusal's fixed message", async () => {
    expect(await page({ saved: "1" })).toContain('Your ratings were saved. <a href="/courses/course-a/exam?order=personal">See your personal order</a>');
    expect(await page({ error: "invalid_rating" })).toContain("Choose a rating from 1 to 5, or Skip, for each topic.");
    expect(await page({ error: "<b>x</b>" })).toContain("Your ratings could not be saved. Please try again.");
  });
});

describe("saveTopicConfidenceAction (US-24)", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.append(name, value);
    return data;
  };
  it("saves for the session's student only and comes back with the outcome", async () => {
    mocks.saveTopicConfidence.mockResolvedValue({ ok: true, rated: 1, skipped: 0, unchanged: 0 });
    await expect(saveTopicConfidenceAction(form({ courseId: "course-a", userId: "someone-else", "rating:tcp": "2" }))).rejects.toThrow("NEXT_REDIRECT /courses/course-a/confidence?saved=1");
    expect(mocks.saveTopicConfidence).toHaveBeenCalledWith("student-1", "course-a", expect.anything());
    mocks.saveTopicConfidence.mockResolvedValue({ ok: false, error: "unknown_topic" });
    await expect(saveTopicConfidenceAction(form({ courseId: "course-a", "rating:x": "2" }))).rejects.toThrow("NEXT_REDIRECT /courses/course-a/confidence?error=unknown_topic");
  });
  it("checks the session first, and refuses an unknown course before saving anything", async () => {
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    await expect(saveTopicConfidenceAction(form({ courseId: "course-a" }))).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mocks.requireUser).toHaveBeenCalledWith("/courses/course-a/confidence");
    mocks.requireUser.mockResolvedValue(student);
    mocks.getCourseById.mockResolvedValue(null);
    await expect(saveTopicConfidenceAction(form({ courseId: "other", "rating:tcp": "2" }))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.saveTopicConfidence).not.toHaveBeenCalled();
  });
});

describe("the Upcomer Exam links to the topic ratings (US-24)", () => {
  const question = { id: "g1", position: 1, rank: 1, text: "Question 1.", paperCount: 1, totalPapers: 1, tier: "LIKELY", papers: [] };
  const exam = (searchParams: Record<string, string>) =>
    ConsolidatedExamPage({ params: Promise.resolve({ courseId: course.id }), searchParams: Promise.resolve(searchParams) }).then(renderToStaticMarkup);
  const link = '<a href="/courses/course-a/confidence">Rate your topics</a>';
  beforeEach(() => {
    mocks.getConsolidatedExam.mockReset().mockResolvedValue({ totalPapers: 5, lowConfidence: false, questions: [question], sections: [{ tier: "LIKELY", questions: [question] }] });
    mocks.getCourseProgress.mockReset().mockResolvedValue(new Map());
    mocks.getPersonalOrder.mockReset().mockResolvedValue({ questions: [question], hasProfile: true });
  });
  it("from the no-learning-profile note, once", async () => {
    mocks.getPersonalOrder.mockResolvedValue({ questions: [question], hasProfile: false });
    const html = await exam({ order: "personal" });
    expect(html).toContain(`You have no learning profile for this course yet, so this is the frequency order. ${link} to get a personal order.`);
    expect(html.split(link)).toHaveLength(2);
  });
  it("from the order switch area for a logged-in student, in either order", async () => {
    for (const order of [{}, { order: "personal" }] as Array<Record<string, string>>) {
      const html = await exam(order);
      expect(html.split(link)).toHaveLength(2);
    }
  });
  it("not for a visitor", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    expect(await exam({})).not.toContain("Rate your topics");
  });
});
