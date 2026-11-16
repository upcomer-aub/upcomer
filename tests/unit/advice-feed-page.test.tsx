import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicAdvice } from "@/lib/advice";

// The advice page (US-38 on top of US-34/US-39): the feed, the read limit, and what a visitor sees.

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(), getCourseById: vi.fn(), searchAdvice: vi.fn(), getAdviceOptions: vi.fn(), allowAdviceFeedRead: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/advice", () => ({ searchAdvice: mocks.searchAdvice, getAdviceOptions: mocks.getAdviceOptions, allowAdviceFeedRead: mocks.allowAdviceFeedRead }));
vi.mock("@/lib/advice-changes", () => ({ adviceChangeMessage: (error: string) => `message for ${error}` }));
vi.mock("@/lib/advice-reports", () => ({ getOpenReportedAdviceIds: async () => new Set<string>() }));
vi.mock("@/components/advice-form", () => ({ AdviceForm: () => <form data-advice-form="true" /> }));
vi.mock("@/lib/advice-votes", () => ({ getHelpfulCounts: async () => new Map() }));
vi.mock("@/lib/advice-comments", () => ({ getAdviceComments: async () => new Map() }));
import AdvicePage from "@/app/courses/[courseId]/advice/page";

const course = { id: "course-a", code: "EECE350", name: "Computer Networks" };
const render = (query: Record<string, string> = {}) =>
  AdvicePage({ params: Promise.resolve({ courseId: course.id }), searchParams: Promise.resolve(query) }).then(renderToStaticMarkup);
const advice = (over: Partial<PublicAdvice> = {}): PublicAdvice => ({
  id: "a1", courseId: course.id, title: "Start the labs early", body: "They take long.", resourceUrl: null, resourceTitle: null,
  scope: { kind: "EXAM", label: "Final 2024", fileId: "f1", termId: null, groupId: null, topic: null },
  authorLabel: "Anonymous student", isAnonymous: true, isMine: false, edited: false, createdAt: new Date("2026-11-01T00:00:00Z"), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCourseById.mockResolvedValue(course);
  mocks.getCurrentUser.mockResolvedValue({ id: "student-1" });
  mocks.allowAdviceFeedRead.mockReturnValue(true);
  mocks.searchAdvice.mockResolvedValue({ items: [advice()], total: 1, page: 1, totalPages: 1 });
  mocks.getAdviceOptions.mockResolvedValue({ exams: [], terms: [], topics: [], questions: [] });
});

describe("advice page", () => {
  it("shows the course's advice with its scope and author label, for the session user", async () => {
    const html = await render();
    expect(html).toContain("Start the labs early");
    expect(html).toContain("An exam paper: Final 2024");
    expect(html).toContain("Anonymous student");
    expect(mocks.searchAdvice).toHaveBeenCalledWith(course.id, "student-1", expect.objectContaining({ page: undefined }));
    expect(mocks.allowAdviceFeedRead).toHaveBeenCalledWith("student-1");
  });

  it("shows the limit message and reads nothing when a student is over the read limit", async () => {
    mocks.allowAdviceFeedRead.mockReturnValue(false);
    const html = await render();
    expect(html).toContain("You are opening advice pages too quickly. Wait a minute and try again.");
    expect(mocks.searchAdvice).not.toHaveBeenCalled();
    expect(mocks.getAdviceOptions).not.toHaveBeenCalled();
  });

  it("lets a visitor read without a limit check and asks them to log in to publish", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const html = await render();
    expect(mocks.allowAdviceFeedRead).not.toHaveBeenCalled();
    expect(mocks.searchAdvice).toHaveBeenCalledWith(course.id, null, expect.anything());
    expect(html).toContain(`/login?next=${encodeURIComponent(`/courses/${course.id}/advice`)}`);
    expect(html).not.toContain("data-advice-form");
  });

  it("is not found for an unknown course", async () => {
    mocks.getCourseById.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("offers Next and Previous only where there are pages", async () => {
    mocks.searchAdvice.mockResolvedValue({ items: [advice()], total: 41, page: 2, totalPages: 3 });
    const html = await render({ page: "2" });
    expect(html).toContain("Page 2 of 3");
    expect(html).toContain("page=1");
    expect(html).toContain("page=3");
  });
});

describe("advice page, reporting (US-43)", () => {
  it("offers a logged-in student a report link on other students' advice, and a visitor none", async () => {
    expect(await render()).toContain('href="/courses/course-a/advice/a1/report"');
    mocks.getCurrentUser.mockResolvedValue(null);
    expect(await render()).not.toContain("Report this advice");
  });

  it("shows the outcome of a report, and only the message for a refusal", async () => {
    expect(await render({ reported: "1" })).toContain("Thanks, your report was sent.");
    const html = await render({ report_error: "<b>x</b>" });
    expect(html).toContain("Your report could not be sent.");
    expect(html).not.toContain("<b>x</b>");
  });
});
