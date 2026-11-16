import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// US-51 (6b) on the mock exam page: once an exam is submitted, each past-paper question links to its step-by-step
// walkthrough. No link while the exam is in progress, on a timed exam's start page, or for a generated practice question.
// The real database is in tests/integration/walkthroughs.test.ts (getMockExam returns questionId).

vi.mock("@/app/courses/[courseId]/mock-exams/actions", () => ({ saveMockExamAction: vi.fn(), startMockExamAction: vi.fn() }));
vi.mock("@/components/mock-exam-timer", () => ({ MockExamTimer: () => null }));
import { MockExamSitting } from "@/components/mock-exam-sitting";
import type { MockExamView } from "@/lib/mock-exams";

const exam = (questions: Partial<MockExamView["questions"][number]>[], over: Partial<MockExamView> = {}) => ({
  id: "mock-1", courseId: "course-a", length: questions.length, difficulty: "MIXED", topics: [], includeGenerated: false, status: "SUBMITTED",
  createdAt: new Date(0), submittedAt: new Date(0), markedAt: null, timeLimitMinutes: null, startedAt: null, deadlineAt: null, timedOut: false,
  locked: false, remainingMs: null,
  questions: questions.map((question, index) => ({
    id: `mq-${index}`, position: index + 1, topic: "TCP", text: `Question ${index}`, paperCount: 1, totalPapers: 2, sourcePapers: [], answer: "x",
    outcome: null, matchedPoints: [], missedPoints: [], feedback: null, questionId: null, ...question,
  })),
  ...over,
}) as MockExamView;
const links = (html: string) => [...html.matchAll(/<a href="([^"]*\/walkthrough)" aria-label="([^"]*)">Step-by-step walkthrough<\/a> \(AI-generated\)/g)].map(match => [match[1], match[2]]);

describe("walkthrough links on a mock exam (US-51, 6b)", () => {
  it("links each past-paper question of a submitted exam to its walkthrough, named by its number", () => {
    const html = renderToStaticMarkup(<MockExamSitting exam={exam([{ questionId: "q-a" }, { questionId: "q-b" }])} />);
    expect(links(html)).toEqual([
      ["/courses/course-a/questions/q-a/walkthrough", "Step-by-step walkthrough of question 1"],
      ["/courses/course-a/questions/q-b/walkthrough", "Step-by-step walkthrough of question 2"],
    ]);
  });

  it("links a marked exam too, below the marking", () => {
    const html = renderToStaticMarkup(<MockExamSitting exam={exam([{ questionId: "q-a", outcome: "CORRECT" }], { markedAt: new Date(0) })} />);
    expect(links(html)).toHaveLength(1);
    expect(html.indexOf('data-marking="CORRECT"')).toBeLessThan(html.indexOf("Step-by-step walkthrough"));
  });

  it("has no link while the exam is in progress", () => {
    expect(renderToStaticMarkup(<MockExamSitting exam={exam([{ questionId: "q-a" }], { status: "IN_PROGRESS" })} />)).not.toContain("walkthrough");
  });

  it("has no link on a timed exam's start page", () => {
    const html = renderToStaticMarkup(<MockExamSitting exam={exam([], { status: "IN_PROGRESS", locked: true, timeLimitMinutes: 30 })} />);
    expect(html).toContain("Start exam");
    expect(html).not.toContain("walkthrough");
  });

  it("has no link for a generated practice question (no past-paper source)", () => {
    const html = renderToStaticMarkup(<MockExamSitting exam={exam([{ questionId: null, paperCount: 0 }, { questionId: "q-b" }])} />);
    expect(links(html)).toEqual([["/courses/course-a/questions/q-b/walkthrough", "Step-by-step walkthrough of question 2"]]);
  });

  it("encodes the IDs in the address", () => {
    const html = renderToStaticMarkup(<MockExamSitting exam={exam([{ questionId: "q/1?x" }], { courseId: "c 1" })} />);
    expect(html).toContain('href="/courses/c%201/questions/q%2F1%3Fx/walkthrough"');
  });
});
