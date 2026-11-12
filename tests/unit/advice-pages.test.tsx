import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdviceItem } from "@/lib/advice";

// The course advice page (US-38) and its card on the course page.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), getCourseById: vi.fn(), getCourseAdvice: vi.fn(), allowAdviceFeedRead: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/advice", () => ({ getCourseAdvice: mocks.getCourseAdvice, allowAdviceFeedRead: mocks.allowAdviceFeedRead }));
vi.mock("@/lib/my-courses-actions", () => ({ addCourseAction: vi.fn() }));
import CourseAdvicePage from "@/app/courses/[courseId]/advice/page";
import CoursePage from "@/app/courses/[courseId]/page";

const course = { id: "course-a", code: "EECE350", name: "Computer Networks", faculty: { name: "Engineering" }, professors: [] };
const createdAt = new Date("2026-11-10T09:00:00Z");
const item = (overrides: Partial<AdviceItem> = {}): AdviceItem => ({
  id: "advice-1", body: "Do every past final twice.", author: "Lea Tass", anonymous: false,
  about: { scope: "COURSE", targetGone: false }, resourceUrl: null, createdAt, edited: false, ...overrides,
});
const feed = (items: AdviceItem[], extra: Record<string, number> = {}) => ({ items, total: items.length, page: 1, totalPages: 1, ...extra });
const page = (searchParams: Record<string, string> = {}, courseId = course.id) =>
  CourseAdvicePage({ params: Promise.resolve({ courseId }), searchParams: Promise.resolve(searchParams) }).then(renderToStaticMarkup);

beforeEach(() => {
  mocks.requireUser.mockReset().mockResolvedValue({ id: "student-1", role: "STUDENT" });
  mocks.getCourseById.mockReset().mockResolvedValue(course);
  mocks.getCourseAdvice.mockReset().mockResolvedValue(feed([item()]));
  mocks.allowAdviceFeedRead.mockReset().mockReturnValue(true);
});

describe("the course advice page (US-38)", () => {
  it("sends a visitor to log in and back to this page", async () => {
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(page()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.requireUser).toHaveBeenCalledWith("/courses/course-a/advice");
    expect(mocks.getCourseAdvice).not.toHaveBeenCalled();
  });
  it("shows the not-found page for an unknown course", async () => {
    mocks.getCourseById.mockResolvedValue(null);
    await expect(page({}, "no-such-course")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.getCourseAdvice).not.toHaveBeenCalled();
  });
  it("shows each advice labelled as student advice, with its scope, author, and date", async () => {
    const html = await page();
    expect(html).toContain("<h1>Advice from previous students</h1>");
    expect(html).toContain("This is their opinion, not statistics from previous exams.");
    expect(html).toContain("Student advice");
    expect(html).toContain("About the whole course");
    expect(html).toContain("Do every past final twice.");
    expect(html).toContain("By Lea Tass · ");
    expect(html).toContain('<time dateTime="2026-11-10T09:00:00.000Z">10 Nov 2026</time>');
    expect(html).not.toContain("edited");
    expect(html).toContain("1 piece of advice.");
  });
  it("names each scope's target, and links an exam paper and a question", async () => {
    mocks.getCourseAdvice.mockResolvedValue(feed([
      item({ id: "a1", about: { scope: "EXAM", label: "Final 2024", fileId: "file-1" } }),
      item({ id: "a2", about: { scope: "SESSION", label: "Fall 2024" } }),
      item({ id: "a3", about: { scope: "TOPIC", label: "Routing" } }),
      item({ id: "a4", about: { scope: "QUESTION", label: "Explain the TCP handshake.", groupId: "g-1" } }),
      item({ id: "a5", about: { scope: "COURSE", targetGone: true } }),
    ]));
    const html = await page();
    expect(html).toContain('About the exam: <a href="/files/file-1">Final 2024</a>');
    expect(html).toContain("About the term: Fall 2024");
    expect(html).toContain("About the topic: Routing");
    expect(html).toContain('About the question: <a href="/courses/course-a/exam">Explain the TCP handshake.</a>');
    expect(html).toContain("(what it was about is no longer available)");
    expect(html).toContain("5 pieces of advice.");
  });
  it("shows an anonymous author as anonymous, an edit, and a resource that opens safely in a new tab", async () => {
    mocks.getCourseAdvice.mockResolvedValue(feed([item({ author: "Anonymous student", anonymous: true, edited: true, resourceUrl: "https://example.com/notes" })]));
    const html = await page();
    expect(html).toContain("By Anonymous student");
    expect(html).not.toContain("Lea Tass");
    expect(html).toContain(" · edited");
    expect(html).toContain('<a href="https://example.com/notes" target="_blank" rel="noopener noreferrer nofollow">https://example.com/notes</a>');
  });
  it("shows advice text as text, never as HTML", async () => {
    mocks.getCourseAdvice.mockResolvedValue(feed([item({ body: "<script>alert(1)</script> Study <b>hard</b>" })]));
    const html = await page();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; Study &lt;b&gt;hard&lt;/b&gt;");
  });
  it("says so when the course has no advice", async () => {
    mocks.getCourseAdvice.mockResolvedValue(feed([]));
    const html = await page();
    expect(html).toContain("No advice has been shared for EECE350 yet.");
    expect(html).not.toContain("<ol");
    expect(html).not.toContain('role="status"');
  });
  it("passes the requested page on and links to the pages around it", async () => {
    mocks.getCourseAdvice.mockResolvedValue(feed([item()], { total: 45, page: 2, totalPages: 3 }));
    const html = await page({ page: "2" });
    expect(mocks.getCourseAdvice).toHaveBeenCalledWith("course-a", "2");
    expect(html).toContain("45 pieces of advice, page 2 of 3.");
    expect(html).toContain('href="/courses/course-a/advice?page=1"');
    expect(html).toContain('href="/courses/course-a/advice?page=3"');
  });
  it("checks the student's read limit, and when it is reached shows a message without reading the advice", async () => {
    await page();
    expect(mocks.allowAdviceFeedRead).toHaveBeenCalledWith("student-1");
    mocks.getCourseAdvice.mockClear();
    mocks.allowAdviceFeedRead.mockReturnValue(false);
    const html = await page();
    expect(html).toContain("Too many pages opened in a minute. Wait a moment, then reload the page.");
    expect(html).toContain('role="alert"');
    expect(mocks.getCourseAdvice).not.toHaveBeenCalled();
  });
  it("shows no page links for one page", async () => {
    expect(await page()).not.toContain("Advice pages");
  });
});

describe("the course page", () => {
  it("links to the course's student advice", async () => {
    const html = renderToStaticMarkup(await CoursePage({ params: Promise.resolve({ courseId: "course-a" }), searchParams: Promise.resolve({}) }));
    expect(html).toContain('<a class="button" href="/courses/course-a/advice">Read Student Advice</a>');
  });
});
