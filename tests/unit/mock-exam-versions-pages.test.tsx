import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// US-46 on the mock exam page: the Versions section (links, this one marked, the button on in-progress and submitted exams),
// the notices with the count of unused questions, and the action (session user only, to the new version's own course).

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), getCourseById: vi.fn(), getMockExam: vi.fn(), getMockExamVersions: vi.fn(), createAlternativeMockExam: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser, getCurrentUser: vi.fn() }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/mock-exams", () => ({ getMockExam: mocks.getMockExam }));
vi.mock("@/lib/mock-exam-versions", () => ({ getMockExamVersions: mocks.getMockExamVersions, createAlternativeMockExam: mocks.createAlternativeMockExam }));
vi.mock("@/app/courses/[courseId]/mock-exams/actions", () => ({ saveMockExamAction: vi.fn() }));
import MockExamPage from "@/app/courses/[courseId]/mock-exams/[mockExamId]/page";
import { createAlternativeMockExamAction } from "@/lib/mock-exam-version-actions";

const course = { id: "course-a", code: "EECE350", name: "Computer Networks", faculty: { name: "Engineering" }, professors: [] };
const exam = (over: Record<string, unknown> = {}) => ({
  id: "mock-2", courseId: course.id, length: 3, difficulty: "HARD", topics: ["TCP"], includeGenerated: false, status: "IN_PROGRESS",
  createdAt: new Date("2026-11-15T10:00:00Z"), submittedAt: null,
  questions: [{ id: "q1", position: 1, topic: "TCP", text: "Explain the handshake.", paperCount: 2, totalPapers: 3, sourcePapers: ["Final (2024)"], answer: null }], ...over,
});
const at = (minute: number) => new Date(Date.UTC(2026, 10, 15, 10, minute));
const family = { current: 2, versions: [
  { id: "mock-1", version: 1, status: "SUBMITTED", createdAt: at(1) }, { id: "mock-2", version: 2, status: "IN_PROGRESS", createdAt: at(2) },
  { id: "mock-3", version: 3, status: "IN_PROGRESS", createdAt: at(3) },
] };
const page = (query: Record<string, string> = {}) =>
  MockExamPage({ params: Promise.resolve({ courseId: course.id, mockExamId: "mock-2" }), searchParams: Promise.resolve(query) }).then(renderToStaticMarkup);
const notices = (html: string) => [...html.matchAll(/<p class="notice[^"]*" role="(status|alert)">(.*?)<\/p>/g)].map(match => [match[1], match[2]]);
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
  mocks.requireUser.mockReset().mockResolvedValue({ id: "student-1", role: "STUDENT" });
  mocks.getCourseById.mockReset().mockResolvedValue(course);
  mocks.getMockExam.mockReset().mockResolvedValue(exam());
  mocks.getMockExamVersions.mockReset().mockResolvedValue(family);
});

describe("mock exam page: versions (US-46)", () => {
  it("reads the session student's versions of this exam", async () => {
    await page();
    expect(mocks.getMockExamVersions).toHaveBeenCalledWith("student-1", "mock-2");
  });
  it("lists every version in order, marks this one, and links the others", async () => {
    const html = await page();
    expect(html).toContain('<h2 id="versions-heading">Versions</h2>');
    expect(html).toContain('<a href="/courses/course-a/mock-exams/mock-1">Version 1</a>');
    expect(html).toContain('<strong aria-current="page">Version 2 (this one)</strong>');
    expect(html).toContain('<a href="/courses/course-a/mock-exams/mock-3">Version 3</a>');
    expect(html.indexOf("Version 1")).toBeLessThan(html.indexOf("Version 2 (this one)"));
    expect(html).toContain("Version 1</a><span class=\"muted\"> · submitted</span>");
  });
  it("offers the alternative on an in-progress and a submitted exam, as a POST form without a user ID", async () => {
    for (const status of ["IN_PROGRESS", "SUBMITTED"]) {
      mocks.getMockExam.mockResolvedValue(exam({ status, submittedAt: status === "SUBMITTED" ? new Date() : null }));
      const html = await page();
      expect(html).toContain(">Make an alternative version</button>");
      expect(html).toContain('name="mockExamId" value="mock-2"');
      expect(html).not.toContain("student-1");
    }
  });
  it("shows no list for an original without versions, but still the button", async () => {
    mocks.getMockExamVersions.mockResolvedValue({ current: 1, versions: [{ id: "mock-2", version: 1, status: "IN_PROGRESS", createdAt: at(1) }] });
    const html = await page();
    expect(html).not.toContain("(this one)");
    expect(html).toContain(">Make an alternative version</button>");
  });
  it("announces a new version with its number", async () => {
    expect(notices(await page({ version: "new" }))).toEqual([["status", "This is version 2 of this mock exam: the same topics, length and difficulty, with questions not used in its earlier versions."]]);
  });
  it("explains a refusal with the count of unused questions and the length needed", async () => {
    expect(notices(await page({ version_error: "not_enough_questions", available: "2", length: "3" }))).toEqual([["alert",
      "Only 2 unused questions match these settings (not in this exam or any of its versions), and a new version needs 3. Make a new mock exam with other topics or a shorter length instead."]]);
  });
  it("never shows a tampered count or error code", async () => {
    const html = await page({ version_error: "not_enough_questions", available: "<b>9</b>", length: "99999" });
    expect(html).toContain("There are not enough unused questions left for another version with these settings.");
    expect(html).not.toContain("<b>9</b>");
    expect(notices(await page({ version_error: "<script>" }))).toEqual([["alert", "The alternative version could not be made. Please try again."]]);
  });
  it("is not found for another student's exam, without reading anything else", async () => {
    mocks.getMockExam.mockResolvedValue(null);
    mocks.getMockExamVersions.mockResolvedValue({ current: 0, versions: [] });
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("createAlternativeMockExamAction (US-46)", () => {
  const act = (values: Record<string, string>) => createAlternativeMockExamAction(form(values)).catch((error: Error) => error.message);

  it("requires a session first", async () => {
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    expect(await act({ courseId: "course-a", mockExamId: "mock-2" })).toBe("NEXT_REDIRECT /login");
    expect(mocks.requireUser).toHaveBeenCalledWith("/courses/course-a/mock-exams/mock-2");
    expect(mocks.createAlternativeMockExam).not.toHaveBeenCalled();
  });
  it("makes the version as the session student and opens it in its own course", async () => {
    mocks.createAlternativeMockExam.mockResolvedValue({ ok: true, id: "mock-4", courseId: "course-a", difficultyApplied: true, version: 4 });
    expect(await act({ courseId: "tampered-course", mockExamId: "mock-2", userId: "someone-else" })).toBe("NEXT_REDIRECT /courses/course-a/mock-exams/mock-4?version=new");
    expect(mocks.createAlternativeMockExam).toHaveBeenCalledWith("student-1", "mock-2");
    mocks.createAlternativeMockExam.mockResolvedValue({ ok: true, id: "mock-5", courseId: "course-a", difficultyApplied: false, version: 5 });
    expect(await act({ courseId: "course-a", mockExamId: "mock-2" })).toBe("NEXT_REDIRECT /courses/course-a/mock-exams/mock-5?version=new&same=1");
  });
  it("stays on the exam with the reason and the counts when refused", async () => {
    mocks.createAlternativeMockExam.mockResolvedValue({ ok: false, error: "not_enough_questions", available: 2, length: 3 });
    expect(await act({ courseId: "course-a", mockExamId: "mock-2" })).toBe("NEXT_REDIRECT /courses/course-a/mock-exams/mock-2?version_error=not_enough_questions&available=2&length=3");
    mocks.createAlternativeMockExam.mockResolvedValue({ ok: false, error: "not_found" });
    expect(await act({ courseId: "course-a", mockExamId: "nope" })).toBe("NEXT_REDIRECT /courses/course-a/mock-exams/nope?version_error=not_found");
  });
});
