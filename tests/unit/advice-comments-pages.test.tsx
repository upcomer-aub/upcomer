import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicAdvice } from "@/lib/advice";
import type { PublicComment } from "@/lib/advice-comments";

// US-41 on the advice page: each post's discussion (replies in order, who wrote them, Delete only for the reply's author or
// an admin, the reply form or a log-in link), the outcome notices, and the actions (session user only, back to the thread).

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(), requireUser: vi.fn(), getCourseById: vi.fn(), searchAdvice: vi.fn(), getAdviceOptions: vi.fn(),
  getHelpfulCounts: vi.fn(), getAdviceComments: vi.fn(), addAdviceComment: vi.fn(), deleteAdviceComment: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser, requireUser: mocks.requireUser }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/advice", () => ({ searchAdvice: mocks.searchAdvice, getAdviceOptions: mocks.getAdviceOptions, allowAdviceFeedRead: () => true }));
vi.mock("@/lib/advice-votes", () => ({ getHelpfulCounts: mocks.getHelpfulCounts }));
vi.mock("@/lib/advice-vote-actions", () => ({ setAdviceHelpfulAction: vi.fn() }));
vi.mock("@/lib/advice-comments", () => ({
  getAdviceComments: mocks.getAdviceComments, addAdviceComment: mocks.addAdviceComment, deleteAdviceComment: mocks.deleteAdviceComment,
}));
vi.mock("@/components/advice-form", () => ({ AdviceForm: () => null }));
vi.mock("@/lib/advice-reports", () => ({ getOpenReportedAdviceIds: async () => new Set<string>() }));
import AdvicePage from "@/app/courses/[courseId]/advice/page";
import { addAdviceCommentAction, deleteAdviceCommentAction } from "@/lib/advice-comment-actions";

const course = { id: "course-a", code: "EECE350", name: "Computer Networks", faculty: { name: "Engineering" }, professors: [] };
const advice = (id: string, over: Partial<PublicAdvice> = {}): PublicAdvice => ({
  id, courseId: course.id, title: `Title ${id}`, body: "Body", resourceUrl: null, resourceTitle: null,
  scope: { kind: "COURSE", label: "EECE350", fileId: null, termId: null, groupId: null, topic: null },
  authorLabel: "Anonymous student", isAnonymous: true, isMine: false, edited: false, createdAt: new Date("2026-11-02T00:00:00Z"), ...over,
});
const reply = (id: string, over: Partial<PublicComment> = {}): PublicComment => ({
  id, body: `Reply body ${id}`, createdAt: new Date("2026-11-15T10:05:00Z"), authorLabel: `Writer ${id}`, byPostAuthor: false, isMine: false, canDelete: false, ...over,
});
const page = (searchParams: Record<string, string> = {}) =>
  AdvicePage({ params: Promise.resolve({ courseId: course.id }), searchParams: Promise.resolve(searchParams) }).then(renderToStaticMarkup);
const discussion = (html: string, adviceId: string) => {
  const start = html.indexOf(`id="discussion-${adviceId}"`);
  return html.slice(start, html.indexOf("</details>", start));
};
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
  mocks.getCurrentUser.mockReset().mockResolvedValue({ id: "student-1", role: "STUDENT" });
  mocks.requireUser.mockReset().mockResolvedValue({ id: "student-1", role: "STUDENT" });
  mocks.getCourseById.mockReset().mockResolvedValue(course);
  mocks.searchAdvice.mockReset().mockResolvedValue({ items: [advice("a1"), advice("a2", { isMine: true }), advice("a3", { isMine: true, isAnonymous: false })], total: 3, page: 1, totalPages: 1 });
  mocks.getAdviceOptions.mockReset().mockResolvedValue({ exams: [], terms: [], topics: [], questions: [] });
  mocks.getHelpfulCounts.mockReset().mockResolvedValue(new Map());
  mocks.getAdviceComments.mockReset().mockResolvedValue(new Map([
    ["a1", [reply("r1"), reply("r2", { authorLabel: "Anonymous student (author)", byPostAuthor: true }), reply("r3", { authorLabel: "Me", isMine: true, canDelete: true })]],
    ["a2", []], ["a3", []],
  ]));
});

describe("advice page: discussion (US-41)", () => {
  it("reads the replies of the shown advice for the session user", async () => {
    await page();
    expect(mocks.getAdviceComments).toHaveBeenCalledWith("course-a", ["a1", "a2", "a3"], { id: "student-1", role: "STUDENT" });
  });
  it("lists the replies beneath their post in the order given, with who wrote them", async () => {
    const thread = discussion(await page(), "a1");
    expect(thread).toContain("Discussion (3 replies)");
    expect([...thread.matchAll(/Reply body (r\d)/g)].map(match => match[1])).toEqual(["r1", "r2", "r3"]);
    expect(thread).toContain("<strong>Anonymous student (author)</strong>");
    expect(thread).toContain('<time dateTime="2026-11-15T10:05:00.000Z">2026-11-15 10:05 UTC</time>');
    expect(discussion(await page(), "a2")).toContain("Discussion (0 replies)");
    expect(discussion(await page(), "a2")).toContain("No replies yet.");
  });
  it("offers Delete only on replies the viewer may delete", async () => {
    const thread = discussion(await page(), "a1");
    expect(thread.match(/<button[^>]*type="submit">Delete( my)? reply<\/button>/g)).toEqual([expect.stringContaining("Delete my reply")]);
    expect(thread).toContain('name="commentId" value="r3"');
    expect(thread).not.toContain('name="commentId" value="r1"');
  });
  it("tells the student how their reply will be shown", async () => {
    const html = await page();
    expect(discussion(html, "a1")).toContain("Your reply is shown with your name.");
    expect(discussion(html, "a2")).toContain("Your reply is shown as Anonymous student (author).");
    expect(discussion(html, "a3")).toContain("Your reply is shown with your name, marked (author).");
  });
  it("has a required, length-limited reply box and never a user ID in the forms", async () => {
    const html = await page();
    expect(discussion(html, "a1")).toContain('<textarea name="body" required="" maxLength="1000" rows="3"></textarea>');
    expect(html).not.toContain("student-1");
  });
  it("opens the thread just used, and keeps the others closed", async () => {
    const html = await page({ thread: "a1" });
    expect(html).toContain('<details class="');
    expect(html).toMatch(/<details[^>]*open=""[^>]*id="discussion-a1"/);
    expect(html).not.toMatch(/<details[^>]*open=""[^>]*id="discussion-a2"/);
  });
  it("shows a visitor the replies and a link to log in instead of the form", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const thread = discussion(await page(), "a1");
    expect(mocks.getAdviceComments).toHaveBeenLastCalledWith("course-a", ["a1", "a2", "a3"], null);
    expect(thread).toContain("Reply body r1");
    expect(thread).not.toContain("<textarea");
    expect(thread).toContain(">Log in to reply</a>");
  });
  it("shows the outcome notices, with a fixed message for any error code", async () => {
    expect(await page({ comment: "added" })).toContain("Your reply was posted.");
    expect(await page({ comment: "deleted" })).toContain("The reply was deleted.");
    expect(await page({ comment_error: "body_required" })).toContain("Write a reply before sending it.");
    const html = await page({ comment_error: "<img src=x>" });
    expect(html).toContain("Your reply could not be saved.");
    expect(html).not.toContain("<img src=x>");
  });
});

describe("reply actions (US-41)", () => {
  const act = (action: (data: FormData) => Promise<void>, values: Record<string, string>) => action(form(values)).catch((error: Error) => error.message);

  it("requires a session before posting or deleting", async () => {
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    expect(await act(addAdviceCommentAction, { courseId: "course-a", adviceId: "a1", body: "Hi" })).toBe("NEXT_REDIRECT /login");
    expect(await act(deleteAdviceCommentAction, { courseId: "course-a", commentId: "r1" })).toBe("NEXT_REDIRECT /login");
    expect(mocks.addAdviceComment).not.toHaveBeenCalled();
    expect(mocks.deleteAdviceComment).not.toHaveBeenCalled();
  });
  it("posts as the session student, ignoring IDs in the form, and returns to the open thread", async () => {
    mocks.addAdviceComment.mockResolvedValue({ ok: true, id: "r9" });
    const result = await act(addAdviceCommentAction, { courseId: "course-a", adviceId: "a1", body: "Which week?", userId: "someone", returnTo: "sort=helpful&page=2&comment_error=x" });
    expect(mocks.addAdviceComment).toHaveBeenCalledWith("student-1", "course-a", "a1", "Which week?");
    expect(result).toBe("NEXT_REDIRECT /courses/course-a/advice?sort=helpful&page=2&thread=a1&comment=added");
    expect(result).not.toContain("Which");
  });
  it("reports a refused reply by code only", async () => {
    mocks.addAdviceComment.mockResolvedValue({ ok: false, error: "body_required" });
    expect(await act(addAdviceCommentAction, { courseId: "course-a", adviceId: "a1", body: " " })).toBe("NEXT_REDIRECT /courses/course-a/advice?thread=a1&comment_error=body_required");
  });
  it("deletes with the session user's own role, never a role from the form", async () => {
    mocks.deleteAdviceComment.mockResolvedValue({ ok: true, adviceId: "a1" });
    const result = await act(deleteAdviceCommentAction, { courseId: "course-a", commentId: "r3", role: "ADMIN", returnTo: "page=1" });
    expect(mocks.deleteAdviceComment).toHaveBeenCalledWith({ id: "student-1", role: "STUDENT" }, "course-a", "r3");
    expect(result).toBe("NEXT_REDIRECT /courses/course-a/advice?page=1&thread=a1&comment=deleted");
    mocks.deleteAdviceComment.mockResolvedValue({ ok: false, error: "forbidden" });
    expect(await act(deleteAdviceCommentAction, { courseId: "course-a", commentId: "r1", adviceId: "a1" })).toBe("NEXT_REDIRECT /courses/course-a/advice?thread=a1&comment_error=forbidden");
  });
});
