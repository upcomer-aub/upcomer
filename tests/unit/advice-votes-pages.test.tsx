import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicAdvice } from "@/lib/advice";

// US-40 on the advice page: the sort control, the helpful count and button (student, author, visitor), the outcome notices,
// and the action (session user only, comes back to the same view).

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(), requireUser: vi.fn(), getCourseById: vi.fn(), searchAdvice: vi.fn(), getAdviceOptions: vi.fn(),
  getHelpfulCounts: vi.fn(), setAdviceHelpful: vi.fn(), logError: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser, requireUser: mocks.requireUser }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/advice", () => ({ searchAdvice: mocks.searchAdvice, getAdviceOptions: mocks.getAdviceOptions, allowAdviceFeedRead: () => true }));
vi.mock("@/lib/advice-votes", () => ({ getHelpfulCounts: mocks.getHelpfulCounts, setAdviceHelpful: mocks.setAdviceHelpful }));
vi.mock("@/lib/advice-comments", () => ({ getAdviceComments: vi.fn(async () => new Map()) }));
vi.mock("@/lib/advice-comment-actions", () => ({ addAdviceCommentAction: vi.fn(), deleteAdviceCommentAction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logError: mocks.logError }));
vi.mock("@/components/advice-form", () => ({ AdviceForm: () => null }));
vi.mock("@/lib/advice-reports", () => ({ getOpenReportedAdviceIds: async () => new Set<string>() }));
import AdvicePage from "@/app/courses/[courseId]/advice/page";
import { setAdviceHelpfulAction } from "@/lib/advice-vote-actions";

const course = { id: "course-a", code: "EECE350", name: "Computer Networks", faculty: { name: "Engineering" }, professors: [] };
const advice = (id: string, over: Partial<PublicAdvice> = {}): PublicAdvice => ({
  id, courseId: course.id, title: `Title ${id}`, body: "Body", resourceUrl: null, resourceTitle: null,
  scope: { kind: "COURSE", label: "EECE350", fileId: null, termId: null, groupId: null, topic: null },
  authorLabel: "Anonymous student", isAnonymous: true, isMine: false, edited: false, createdAt: new Date("2026-11-02T00:00:00Z"), ...over,
});
const page = (searchParams: Record<string, string> = {}) =>
  AdvicePage({ params: Promise.resolve({ courseId: course.id }), searchParams: Promise.resolve(searchParams) }).then(renderToStaticMarkup);
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) if ("mockClear" in mock) mock.mockClear();
  mocks.getCurrentUser.mockReset().mockResolvedValue({ id: "student-1", role: "STUDENT" });
  mocks.requireUser.mockReset().mockResolvedValue({ id: "student-1", role: "STUDENT" });
  mocks.getCourseById.mockReset().mockResolvedValue(course);
  mocks.searchAdvice.mockReset().mockResolvedValue({ items: [advice("a1"), advice("a2", { isMine: true }), advice("a3")], total: 3, page: 1, totalPages: 1 });
  mocks.getAdviceOptions.mockReset().mockResolvedValue({ exams: [], terms: [], topics: [], questions: [] });
  mocks.getHelpfulCounts.mockReset().mockResolvedValue(new Map([["a1", { count: 2, mine: true }], ["a2", { count: 1, mine: false }], ["a3", { count: 0, mine: false }]]));
  mocks.setAdviceHelpful.mockReset().mockResolvedValue({ ok: true, helpful: true, changed: true });
});

describe("advice page: helpful marks and sort (US-40)", () => {
  it("sorts newest first by default and most helpful first when asked, ignoring other values", async () => {
    const html = await page();
    expect(mocks.searchAdvice).toHaveBeenLastCalledWith("course-a", "student-1", expect.objectContaining({ sort: "newest" }));
    expect(html).toContain('<select name="sort" aria-label="Sort advice">');
    expect(html).toContain('<option value="newest" selected="">Newest first</option>');
    expect(await page({ sort: "helpful" })).toContain('<option value="helpful" selected="">Most helpful first</option>');
    expect(mocks.searchAdvice).toHaveBeenLastCalledWith("course-a", "student-1", expect.objectContaining({ sort: "helpful" }));
    await page({ sort: "votes desc; drop" });
    expect(mocks.searchAdvice).toHaveBeenLastCalledWith("course-a", "student-1", expect.objectContaining({ sort: "newest" }));
  });
  it("reads the counts of the shown advice for the session student", async () => {
    await page();
    expect(mocks.getHelpfulCounts).toHaveBeenCalledWith(["a1", "a2", "a3"], "student-1");
  });
  it("shows each count, an undo for advice the student marked, a mark button otherwise, and no button on their own advice", async () => {
    const html = await page();
    expect(html).toContain("2 students found this helpful");
    expect(html).toContain('aria-pressed="true">Undo helpful</button>');
    expect(html).toContain("0 students found this helpful");
    expect(html).toContain('aria-pressed="false">Mark as helpful</button>');
    expect(html).toMatch(/1 student found this helpful<\/span> · <span class="muted">Your advice<\/span>/);
    expect(html.match(/<button[^>]*>(Undo helpful|Mark as helpful)<\/button>/g)).toHaveLength(2);
    expect(html).toContain('name="helpful" value="0"');
    expect(html).toContain('name="helpful" value="1"');
  });
  it("never puts a user ID in the form", async () => {
    expect(await page()).not.toContain("student-1");
  });
  it("shows a visitor the counts and a link to log in that comes back to the same view", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const html = await page({ sort: "helpful", q: "labs" });
    expect(mocks.getHelpfulCounts).toHaveBeenCalledWith(["a1", "a2", "a3"], null);
    expect(html).toContain("2 students found this helpful");
    expect(html).not.toContain("Mark as helpful</button>");
    expect(html).toContain(`href="/login?next=${encodeURIComponent("/courses/course-a/advice?q=labs&sort=helpful&page=1")}"`);
  });
  it("keeps the search, filters, sort, and page in the form and the page links", async () => {
    mocks.searchAdvice.mockResolvedValue({ items: [advice("a1")], total: 41, page: 2, totalPages: 3 });
    const html = await page({ q: "labs", topic: "TCP", sort: "helpful", page: "2" });
    expect(html).toContain('name="returnTo" value="q=labs&amp;topic=TCP&amp;sort=helpful&amp;page=2"');
    expect(html).toContain('href="/courses/course-a/advice?q=labs&amp;topic=TCP&amp;sort=helpful&amp;page=3"');
  });
  it("shows the outcome notices, with a fixed message for any error code", async () => {
    expect(await page({ helpful: "marked" })).toContain("Marked as helpful.");
    expect(await page({ helpful: "unmarked" })).toContain("Your helpful mark was removed.");
    expect(await page({ helpful_error: "own_advice" })).toContain("You cannot mark your own advice as helpful.");
    const html = await page({ helpful_error: "<script>alert(1)</script>" });
    expect(html).toContain("Your helpful mark could not be saved.");
    expect(html).not.toContain("<script>alert");
  });
});

describe("setAdviceHelpfulAction (US-40)", () => {
  const act = (values: Record<string, string>) => setAdviceHelpfulAction(form(values)).catch((error: Error) => error.message);

  it("requires a session first and saves nothing for a visitor", async () => {
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    expect(await act({ courseId: "course-a", adviceId: "a1", helpful: "1" })).toBe("NEXT_REDIRECT /login");
    expect(mocks.requireUser).toHaveBeenCalledWith("/courses/course-a/advice");
    expect(mocks.setAdviceHelpful).not.toHaveBeenCalled();
  });
  it("marks as the session student, ignoring a user ID in the form, and comes back to the same view", async () => {
    const result = await act({ courseId: "course-a", adviceId: "a1", helpful: "1", userId: "someone-else", returnTo: "q=labs&sort=helpful&page=2&helpful_error=x" });
    expect(mocks.setAdviceHelpful).toHaveBeenCalledWith("student-1", "course-a", "a1", true);
    expect(result).toBe("NEXT_REDIRECT /courses/course-a/advice?q=labs&sort=helpful&page=2&helpful=marked");
  });
  it("undoes with 0 and reports refusals by code", async () => {
    mocks.setAdviceHelpful.mockResolvedValueOnce({ ok: true, helpful: false, changed: true });
    expect(await act({ courseId: "course-a", adviceId: "a1", helpful: "0" })).toBe("NEXT_REDIRECT /courses/course-a/advice?helpful=unmarked");
    expect(mocks.setAdviceHelpful).toHaveBeenLastCalledWith("student-1", "course-a", "a1", false);
    mocks.setAdviceHelpful.mockResolvedValueOnce({ ok: false, error: "own_advice" });
    expect(await act({ courseId: "course-a", adviceId: "a2", helpful: "1" })).toBe("NEXT_REDIRECT /courses/course-a/advice?helpful_error=own_advice");
  });
  it("refuses a value that is not 1 or 0 without saving", async () => {
    expect(await act({ courseId: "course-a", adviceId: "a1", helpful: "toggle" })).toBe("NEXT_REDIRECT /courses/course-a/advice?helpful_error=invalid_value");
    expect(mocks.setAdviceHelpful).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith("advice_vote_refused", expect.objectContaining({ userId: "student-1", reason: "invalid_value" }));
  });
});
