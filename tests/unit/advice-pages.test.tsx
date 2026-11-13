import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FeedItem } from "@/lib/advice";

// The course advice page (US-38) and its card on the course page.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), getCourseById: vi.fn(), getCourseAdvice: vi.fn(), allowAdviceFeedRead: vi.fn(), getOwnAdvice: vi.fn(),
  getOpenReportedAdviceIds: vi.fn(), getReportableAdvice: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/advice", () => ({ getCourseAdvice: mocks.getCourseAdvice, allowAdviceFeedRead: mocks.allowAdviceFeedRead }));
vi.mock("@/lib/my-courses-actions", () => ({ addCourseAction: vi.fn() }));
vi.mock("@/lib/advice-changes", () => ({ getOwnAdvice: mocks.getOwnAdvice }));
vi.mock("@/lib/advice-actions", () => ({ editAdviceAction: vi.fn(), deleteAdviceAction: vi.fn() }));
vi.mock("@/lib/advice-reports", () => ({ getOpenReportedAdviceIds: mocks.getOpenReportedAdviceIds, getReportableAdvice: mocks.getReportableAdvice }));
vi.mock("@/lib/advice-report-actions", () => ({ reportAdviceAction: vi.fn() }));
import EditAdvicePage from "@/app/courses/[courseId]/advice/[adviceId]/edit/page";
import ReportAdvicePage from "@/app/courses/[courseId]/advice/[adviceId]/report/page";
import CourseAdvicePage from "@/app/courses/[courseId]/advice/page";
import CoursePage from "@/app/courses/[courseId]/page";

const course = { id: "course-a", code: "EECE350", name: "Computer Networks", faculty: { name: "Engineering" }, professors: [] };
const createdAt = new Date("2026-11-10T09:00:00Z");
const item = (overrides: Partial<FeedItem> = {}): FeedItem => ({
  id: "advice-1", body: "Do every past final twice.", author: "Lea Tass", anonymous: false,
  about: { scope: "COURSE", targetGone: false }, resourceUrl: null, createdAt, edited: false, mine: false, ...overrides,
});
const feed = (items: FeedItem[], extra: Record<string, number> = {}) => ({ items, total: items.length, page: 1, totalPages: 1, ...extra });
const page = (searchParams: Record<string, string> = {}, courseId = course.id) =>
  CourseAdvicePage({ params: Promise.resolve({ courseId }), searchParams: Promise.resolve(searchParams) }).then(renderToStaticMarkup);

beforeEach(() => {
  mocks.requireUser.mockReset().mockResolvedValue({ id: "student-1", role: "STUDENT" });
  mocks.getCourseById.mockReset().mockResolvedValue(course);
  mocks.getCourseAdvice.mockReset().mockResolvedValue(feed([item()]));
  mocks.allowAdviceFeedRead.mockReset().mockReturnValue(true);
  mocks.getOpenReportedAdviceIds.mockReset().mockResolvedValue(new Set());
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
    expect(html).not.toContain("<script>alert(1)");
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
    expect(mocks.getCourseAdvice).toHaveBeenCalledWith("course-a", "2", "student-1");
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

describe("the viewer's own advice in the feed (US-36)", () => {
  it("marks the viewer's own advice and links it to its edit page; other advice has no such link", async () => {
    mocks.getCourseAdvice.mockResolvedValue(feed([item({ id: "mine-1", mine: true }), item({ id: "theirs-1" })]));
    const html = await page();
    expect(html).toContain("Student advice<span");
    expect(html.match(/Your advice/g)).toHaveLength(1);
    expect(html.match(/Edit or delete/g)).toHaveLength(1);
    expect(html).toContain('href="/courses/course-a/advice/mine-1/edit">Edit or delete</a>');
    expect(html).toContain('id="advice-mine-1"');
  });
  it("tells an anonymous author how others see them, and keeps the feed page in the edit link", async () => {
    mocks.getCourseAdvice.mockResolvedValue(feed([item({ id: "mine-1", mine: true, anonymous: true, author: "Anonymous student" })], { total: 45, page: 2, totalPages: 3 }));
    const html = await page({ page: "2" });
    expect(html).toContain("Others see you as Anonymous student.");
    expect(html).toContain('href="/courses/course-a/advice/mine-1/edit?page=2"');
  });
  it("shows the outcome of the author's edit or delete, and a refusal by its message only", async () => {
    expect(await page({ edited: "1" })).toContain("Your advice was updated.");
    expect(await page({ unchanged: "1" })).toContain("Nothing was changed.");
    expect(await page({ deleted: "1" })).toContain("Your advice was deleted. Other students no longer see it.");
    expect(await page({ change_error: "not_found" })).toContain("That advice isn&#x27;t yours to change, or it is no longer shown.");
    const typed = await page({ change_error: "<script>x</script>" });
    expect(typed).toContain("Your change could not be saved. Please try again.");
    expect(typed).not.toContain("<script>x");
  });
});

describe("reporting advice from the feed (US-43)", () => {
  it("links other students' advice only to its report page, keeping the feed page, with no form in the feed", async () => {
    mocks.getCourseAdvice.mockResolvedValue(feed([item({ id: "mine-1", mine: true }), item({ id: "theirs-1" })], { total: 45, page: 2, totalPages: 3 }));
    const html = await page({ page: "2" });
    expect(html.match(/Report this advice/g)).toHaveLength(1);
    expect(html).toContain('href="/courses/course-a/advice/theirs-1/report?page=2">Report this advice</a>');
    expect(html).not.toContain("mine-1/report");
    expect(html).not.toContain("<form");
    // Only the other student's advice is checked for an earlier report.
    expect(mocks.getOpenReportedAdviceIds).toHaveBeenCalledWith("student-1", ["theirs-1"]);
  });
  it("says the viewer already reported an advice instead of offering the form again", async () => {
    mocks.getCourseAdvice.mockResolvedValue(feed([item({ id: "theirs-1" }), item({ id: "theirs-2" })]));
    mocks.getOpenReportedAdviceIds.mockResolvedValue(new Set(["theirs-1"]));
    const html = await page();
    expect(html.match(/You reported this advice. An admin will check it./g)).toHaveLength(1);
    expect(html.match(/Report this advice/g)).toHaveLength(1);
    expect(html).toContain("theirs-2/report");
  });
  it("shows the outcome of a report, and a refusal by its message only", async () => {
    expect(await page({ reported: "1" })).toContain("Thanks, your report was sent. An admin will check the advice.");
    expect(await page({ report_error: "duplicate" })).toContain("You already reported this advice. An admin will check it.");
    expect(await page({ report_error: "own_advice" })).toContain("This is your own advice.");
    const typed = await page({ report_error: "<script>x</script>" });
    expect(typed).toContain("Your report could not be sent. Please try again.");
    expect(typed).not.toContain("<script>x");
  });
});

const reportPage = (searchParams: Record<string, string> = {}, adviceId = "theirs-1") =>
  ReportAdvicePage({ params: Promise.resolve({ courseId: "course-a", adviceId }), searchParams: Promise.resolve(searchParams) }).then(renderToStaticMarkup);
const reportable = (overrides: Record<string, unknown> = {}) => ({ advice: item({ id: "theirs-1", body: "Skip the labs." }), own: false, reported: false, ...overrides });

describe("the report page (US-43)", () => {
  it("sends a visitor to log in and back to the report page", async () => {
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(reportPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.requireUser).toHaveBeenCalledWith("/courses/course-a/advice/theirs-1/report");
  });
  it("shows the not-found page for advice that is not shown in the course", async () => {
    mocks.getReportableAdvice.mockResolvedValue(null);
    await expect(reportPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.getReportableAdvice).toHaveBeenCalledWith("student-1", "course-a", "theirs-1");
  });
  it("shows the advice and the form with every reason, a 500-character note, and the feed page to return to", async () => {
    mocks.getReportableAdvice.mockResolvedValue(reportable());
    const html = await reportPage({ page: "2" });
    expect(html).toContain("<h1>Report this advice</h1>");
    expect(html).toContain("Skip the labs.");
    expect(html).toContain('name="adviceId" value="theirs-1"');
    expect(html).toContain('name="page" value="2"');
    for (const value of ["OFFENSIVE", "SPAM", "PERSONAL_INFO", "ACADEMIC_DISHONESTY", "OTHER"]) expect(html).toContain(`value="${value}"`);
    expect(html).toContain('maxLength="500"');
    expect(html).toContain("Only admins see your report. The author is not told who reported it.");
    expect(html).toContain('href="/courses/course-a/advice?page=2"');
  });
  it("offers no form for one's own advice or advice already reported", async () => {
    mocks.getReportableAdvice.mockResolvedValue(reportable({ own: true }));
    const own = await reportPage();
    expect(own).toContain("This is your own advice.");
    expect(own).not.toContain("Send report");
    mocks.getReportableAdvice.mockResolvedValue(reportable({ reported: true }));
    const again = await reportPage();
    expect(again).toContain("You already reported this advice.");
    expect(again).not.toContain("Send report");
  });
  it("shows a refusal by its message only, and the advice text as text", async () => {
    mocks.getReportableAdvice.mockResolvedValue(reportable({ advice: item({ id: "theirs-1", body: "<script>alert(1)</script>" }) }));
    const html = await reportPage({ error: "<img src=x>" });
    expect(html).toContain("Your report could not be sent. Please try again.");
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("<script>alert(1)");
    expect(await reportPage({ error: "note_too_long" })).toContain("Keep the details to 500 characters or fewer.");
  });
});

const own = {
  ...item({ id: "mine-1", mine: true, body: "Do every past final twice.", resourceUrl: "https://example.com/notes" }), courseId: "course-a",
};
const editPage = (searchParams: Record<string, string> = {}, adviceId = "mine-1") =>
  EditAdvicePage({ params: Promise.resolve({ courseId: "course-a", adviceId }), searchParams: Promise.resolve(searchParams) }).then(renderToStaticMarkup);

describe("the edit page of one's own advice (US-36)", () => {
  beforeEach(() => mocks.getOwnAdvice.mockReset().mockResolvedValue(own));
  it("sends a visitor to log in and back to the edit page", async () => {
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(editPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.requireUser).toHaveBeenCalledWith("/courses/course-a/advice/mine-1/edit");
    expect(mocks.getOwnAdvice).not.toHaveBeenCalled();
  });
  it("asks for the advice by the viewer's ID, and shows not-found for anyone else's", async () => {
    mocks.getOwnAdvice.mockResolvedValue(null);
    await expect(editPage({}, "theirs-1")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.getOwnAdvice).toHaveBeenCalledWith("student-1", "course-a", "theirs-1");
  });
  it("fills the form with the advice, and offers to delete it", async () => {
    const html = await editPage();
    expect(html).toContain("<h1>Edit your advice</h1>");
    expect(html).toContain("About the whole course");
    expect(html).toMatch(/<textarea name="body" required="" maxLength="2000" rows="8">Do every past final twice.<\/textarea>/);
    expect(html).toContain('value="https://example.com/notes"');
    expect(html).toContain('<input type="hidden" name="adviceId" value="mine-1"/>');
    expect(html).toContain(">Save changes</button>");
    expect(html).toContain(">Delete advice</button>");
    expect(html).toContain("This cannot be undone.");
    expect(html).not.toContain("Anonymous student");
  });
  it("reminds an anonymous author that others do not see their name", async () => {
    mocks.getOwnAdvice.mockResolvedValue({ ...own, anonymous: true, author: "Anonymous student" });
    expect(await editPage()).toContain("Other students see this advice as by Anonymous student.");
  });
  it("shows a refusal by its message, keeps the feed page, and never echoes a typed value", async () => {
    const html = await editPage({ error: "too_long", page: "3" });
    expect(html).toContain("Keep your advice to 2000 characters or fewer.");
    expect(html).toContain('href="/courses/course-a/advice?page=3#advice-mine-1"');
    expect(html).toContain('<input type="hidden" name="page" value="3"/>');
    expect(await editPage({ error: "<b>x</b>" })).toContain("Your change could not be saved. Please try again.");
  });
  it("shows the advice text as text, never as HTML", async () => {
    mocks.getOwnAdvice.mockResolvedValue({ ...own, body: "<script>alert(1)</script>" });
    const html = await editPage();
    // React adds a <script> of its own for forms, so the check is for the advice's own.
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("the course page", () => {
  it("links to the course's student advice", async () => {
    const html = renderToStaticMarkup(await CoursePage({ params: Promise.resolve({ courseId: "course-a" }), searchParams: Promise.resolve({}) }));
    expect(html).toContain('<a class="button" href="/courses/course-a/advice">Read Student Advice</a>');
  });
});
