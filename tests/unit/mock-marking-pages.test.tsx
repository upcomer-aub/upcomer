import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// US-49 pages: the marking under each answer of a marked exam, and the admin's answer-key pages (admins only, counts,
// messages by code).

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(), getCourseById: vi.fn(), listAnswerKeyGroups: vi.fn(), getAnswerKeyGroup: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/mock-marking", () => ({ listAnswerKeyGroups: mocks.listAnswerKeyGroups, getAnswerKeyGroup: mocks.getAnswerKeyGroup }));
vi.mock("@/lib/answer-key-actions", () => ({ saveAnswerKeyAction: vi.fn() }));
vi.mock("@/app/courses/[courseId]/mock-exams/actions", () => ({ saveMockExamAction: vi.fn() }));
import AnswerKeyPage from "@/app/admin/answer-keys/[courseId]/[groupId]/page";
import AnswerKeysPage from "@/app/admin/answer-keys/[courseId]/page";
import { MockExamSitting } from "@/components/mock-exam-sitting";
import type { MockExamView } from "@/lib/mock-exams";

const exam = (questions: Partial<MockExamView["questions"][number]>[], over: Partial<MockExamView> = {}) => ({
  id: "mock-1", courseId: "course-a", length: questions.length, difficulty: "MIXED", topics: [], includeGenerated: false, status: "SUBMITTED",
  createdAt: new Date(0), submittedAt: new Date(0), markedAt: new Date(0),
  questions: questions.map((question, index) => ({
    id: `mq-${index}`, position: index + 1, topic: "TCP", text: `Question ${index}`, paperCount: 1, totalPapers: 2, sourcePapers: [], answer: "x",
    outcome: null, matchedPoints: [], missedPoints: [], feedback: null, ...question,
  })),
  ...over,
}) as MockExamView;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ id: "admin-1" });
  mocks.getCourseById.mockResolvedValue({ id: "course-a", code: "EECE350" });
  mocks.listAnswerKeyGroups.mockResolvedValue({
    groups: [
      { id: "g1", rank: 1, text: "Explain the handshake.", paperCount: 3, answerKey: { keyPoints: ["SYN", "ACK"], updatedAt: new Date(0) } },
      { id: "g2", rank: 2, text: "State the layers.", paperCount: 1, answerKey: null },
    ],
    total: 2, withKey: 1, page: 1, totalPages: 1,
  });
  mocks.getAnswerKeyGroup.mockResolvedValue({ id: "g1", rank: 1, text: "Explain the handshake.", paperCount: 3, answerKey: { keyPoints: ["SYN", "ACK"], explanation: "Why.", updatedAt: new Date(0) } });
});

describe("the marked exam", () => {
  it("shows each answer's outcome, the points covered, and the explanation of the mistakes", () => {
    const html = renderToStaticMarkup(<MockExamSitting exam={exam([
      { outcome: "CORRECT", matchedPoints: ["SYN"] },
      { outcome: "PARTIAL", matchedPoints: ["slow start"], missedPoints: ["congestion avoidance"], feedback: 'Your answer does not cover: "congestion avoidance".' },
      { outcome: "NO_KEY", feedback: "This question has no answer key yet, so your answer was not marked." },
    ])} />);
    expect(html).toContain('data-marking="CORRECT"');
    expect(html).toContain("Partly correct");
    expect(html).toContain("Covered: &quot;slow start&quot;");
    expect(html).toContain("Your answer does not cover: &quot;congestion avoidance&quot;.");
    expect(html).toContain("Not marked: no answer key");
    expect(html).toContain("a question without a key is not marked");
  });

  it("shows no marking before the exam is marked or while it is in progress", () => {
    expect(renderToStaticMarkup(<MockExamSitting exam={exam([{ outcome: null }], { markedAt: null })} />)).not.toContain("data-marking");
    expect(renderToStaticMarkup(<MockExamSitting exam={exam([{ outcome: "CORRECT" }], { status: "IN_PROGRESS" })} />)).not.toContain("data-marking");
  });
});

describe("answer key pages", () => {
  const list = (query: Record<string, string> = {}) =>
    AnswerKeysPage({ params: Promise.resolve({ courseId: "course-a" }), searchParams: Promise.resolve(query) }).then(renderToStaticMarkup);
  const one = (query: Record<string, string> = {}) =>
    AnswerKeyPage({ params: Promise.resolve({ courseId: "course-a", groupId: "g1" }), searchParams: Promise.resolve(query) }).then(renderToStaticMarkup);

  it("lists the course's questions with or without a key, for admins only", async () => {
    const html = await list();
    expect(mocks.requireAdmin).toHaveBeenCalledWith("/admin/answer-keys/course-a");
    expect(html).toContain("1 of 2 questions have an answer key.");
    expect(html).toContain("2 key points");
    expect(html).toContain("No answer key");
    expect(html).toContain('href="/admin/answer-keys/course-a/g2"');
  });

  it("shows the saved notice, and only a message for an error code", async () => {
    expect(await list({ saved: "g1" })).toContain("The answer key was saved.");
    const html = await list({ error: "<b>x</b>" });
    expect(html).toContain("The answer key could not be saved.");
    expect(html).not.toContain("<b>x</b>");
  });

  it("is not found for an unknown course or group", async () => {
    mocks.getCourseById.mockResolvedValueOnce(null);
    await expect(list()).rejects.toThrow("NEXT_NOT_FOUND");
    mocks.getAnswerKeyGroup.mockResolvedValueOnce(null);
    await expect(one()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("fills the form with the key, one point per line, and offers removing it", async () => {
    const html = await one();
    expect(mocks.requireAdmin).toHaveBeenCalledWith("/admin/answer-keys/course-a/g1");
    expect(html).toContain("SYN\nACK");
    expect(html).toContain("Remove the answer key");
    expect(await one({ error: "too_many_points" })).toContain("Keep the answer key to 10 key points or fewer.");
  });
});
