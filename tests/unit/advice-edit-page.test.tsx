import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// US-36 pages: the edit page (only the author's advice, both forms, the refusal message) and, on the advice page, the
// edit link on the viewer's own posts and the notices after a change.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), getCurrentUser: vi.fn(), getOwnAdvice: vi.fn(), getCourseById: vi.fn(), searchAdvice: vi.fn(), getAdviceOptions: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser, getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/advice", () => ({ searchAdvice: mocks.searchAdvice, getAdviceOptions: mocks.getAdviceOptions, allowAdviceFeedRead: () => true }));
vi.mock("@/lib/advice-changes", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/advice-changes")>(), getOwnAdvice: mocks.getOwnAdvice }));
vi.mock("@/lib/advice-change-actions", () => ({ editAdviceAction: vi.fn(), deleteAdviceAction: vi.fn() }));
vi.mock("@/lib/advice-reports", () => ({ getOpenReportedAdviceIds: async () => new Set<string>() }));
vi.mock("@/components/advice-form", () => ({ AdviceForm: () => null }));
import EditAdvicePage from "@/app/courses/[courseId]/advice/[adviceId]/edit/page";
vi.mock("@/lib/advice-votes", () => ({ getHelpfulCounts: async () => new Map() }));
vi.mock("@/lib/advice-comments", () => ({ getAdviceComments: async () => new Map() }));
import AdvicePage from "@/app/courses/[courseId]/advice/page";

const own = { id: "advice-1", courseId: "course-a", title: "Start early", body: "Labs take long.", resourceUrl: "https://example.com/x", resourceTitle: "X", isAnonymous: true, about: "The whole course" };
const edit = (query: Record<string, string> = {}) =>
  EditAdvicePage({ params: Promise.resolve({ courseId: "course-a", adviceId: "advice-1" }), searchParams: Promise.resolve(query) }).then(renderToStaticMarkup);
const feed = (query: Record<string, string> = {}) =>
  AdvicePage({ params: Promise.resolve({ courseId: "course-a" }), searchParams: Promise.resolve(query) }).then(renderToStaticMarkup);
const item = (isMine: boolean, edited = false) => ({
  id: isMine ? "mine" : "theirs", courseId: "course-a", title: `T ${isMine}`, body: "B", resourceUrl: null, resourceTitle: null,
  scope: { kind: "COURSE", label: "X", fileId: null, termId: null, groupId: null, topic: null }, authorLabel: "Someone", isAnonymous: false, isMine, edited, createdAt: new Date(0),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "student-1" });
  mocks.getCurrentUser.mockResolvedValue({ id: "student-1" });
  mocks.getOwnAdvice.mockResolvedValue(own);
  mocks.getCourseById.mockResolvedValue({ id: "course-a", code: "EECE350" });
  mocks.getAdviceOptions.mockResolvedValue({ exams: [], terms: [], topics: [], questions: [] });
  mocks.searchAdvice.mockResolvedValue({ items: [item(true, true), item(false)], total: 2, page: 2, totalPages: 2 });
});

describe("edit page", () => {
  it("shows the author's title, text, link, and both forms, and says the advice stays anonymous", async () => {
    const html = await edit();
    expect(mocks.requireUser).toHaveBeenCalledWith("/courses/course-a/advice/advice-1/edit");
    expect(mocks.getOwnAdvice).toHaveBeenCalledWith("student-1", "course-a", "advice-1");
    for (const text of ['value="Start early"', "Labs take long.", 'value="https://example.com/x"', "Save changes", "Delete advice", "Anonymous student"]) expect(html).toContain(text);
  });
  it("is not found for anyone else's advice", async () => {
    mocks.getOwnAdvice.mockResolvedValue(null);
    await expect(edit()).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("shows the refusal's message, never the raw value", async () => {
    expect(await edit({ error: "link_invalid" })).toContain("Enter a full link that starts with https://");
    const html = await edit({ error: "<script>x</script>" });
    expect(html).toContain("Your change could not be saved.");
    expect(html).not.toContain("<script>x");
  });
  it("keeps the feed page to go back to", async () => {
    const html = await edit({ page: "3" });
    expect(html).toContain('name="page" value="3"');
    expect(html).toContain('href="/courses/course-a/advice?page=3"');
  });
});

describe("advice page, for authors", () => {
  it("offers the edit link only on the viewer's own advice, back to the page they are on, and marks edited advice", async () => {
    const html = await feed({ page: "2" });
    expect(html.match(/Edit or delete your advice/g)).toHaveLength(1);
    expect(html).toContain('href="/courses/course-a/advice/mine/edit?page=2"');
    expect(html).toContain(" · edited");
  });
  it("shows the outcome of a change", async () => {
    expect(await feed({ edited: "1" })).toContain("Your advice was updated.");
    expect(await feed({ unchanged: "1" })).toContain("Nothing changed");
    expect(await feed({ deleted: "1" })).toContain("Your advice was deleted.");
    expect(await feed({ change_error: "not_found" })).toContain("isn&#x27;t yours to change");
  });
});
