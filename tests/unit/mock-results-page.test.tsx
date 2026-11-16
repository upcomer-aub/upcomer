import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildResultsReport } from "@/lib/mock-results-rules";

// US-50: the results page shows the report, refuses others, and stops a flood.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), getCourseById: vi.fn(), getMockResults: vi.fn(), allowResultsRead: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/mock-results", () => ({ getMockResults: mocks.getMockResults, allowResultsRead: mocks.allowResultsRead }));
import MockResultsPage from "@/app/courses/[courseId]/mock-exams/[mockExamId]/results/page";

// React separates text pieces with empty comments; they are dropped so the text reads as on screen.
const render = () => MockResultsPage({ params: Promise.resolve({ courseId: "course-a", mockExamId: "mock-1" }) }).then(renderToStaticMarkup).then(html => html.replace(/<!-- -->/g, ""));
const report = buildResultsReport([
  { id: "1", position: 1, topic: "TCP", text: "Q1", outcome: "CORRECT", matchedPoints: ["a"], missedPoints: [], feedback: null },
  { id: "2", position: 2, topic: "TCP", text: "Q2", outcome: "PARTIAL", matchedPoints: ["a"], missedPoints: ["b"], feedback: "Explained." },
  { id: "3", position: 3, topic: "DNS", text: "Q3", outcome: "NO_KEY", matchedPoints: [], missedPoints: [], feedback: null },
]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "student-1" });
  mocks.getCourseById.mockResolvedValue({ id: "course-a", code: "EECE350" });
  mocks.allowResultsRead.mockReturnValue(true);
  mocks.getMockResults.mockResolvedValue({ ok: true, exam: { id: "mock-1", courseId: "course-a", markedAt: new Date() }, report });
});

describe("results page", () => {
  it("shows the score over marked questions, the topics, the missed items, and the unmarked ones", async () => {
    const html = await render();
    expect(mocks.getMockResults).toHaveBeenCalledWith("student-1", "mock-1");
    expect(html).toContain("<strong>1 of 2</strong> marked questions fully correct · 75% of the key points covered");
    expect(html).toContain("1 of 3 questions was not marked, because it has no answer key.");
    expect(html).toContain('data-topic="TCP"');
    expect(html).toContain("Missed: &quot;b&quot;");
    expect(html).toContain('data-unmarked="3"');
  });

  it("is not found for another student's exam or another course's", async () => {
    mocks.getMockResults.mockResolvedValueOnce({ ok: false, error: "not_found" });
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    mocks.getMockResults.mockResolvedValueOnce({ ok: true, exam: { id: "mock-1", courseId: "course-b", markedAt: new Date() }, report });
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("asks to submit an exam in progress", async () => {
    mocks.getMockResults.mockResolvedValue({ ok: false, error: "not_submitted" });
    expect(await render()).toContain("Submit the exam to see your results.");
  });

  it("reads nothing for a student over the limit", async () => {
    mocks.allowResultsRead.mockReturnValue(false);
    expect(await render()).toContain("You are opening results too quickly.");
    expect(mocks.getMockResults).not.toHaveBeenCalled();
  });
});
