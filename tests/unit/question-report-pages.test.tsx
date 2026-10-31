import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(), getCurrentUser: vi.fn(), getReportQueue: vi.fn(), getCourseById: vi.fn(), getConsolidatedExam: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.requireAdmin, getCurrentUser: mocks.getCurrentUser, requireUser: vi.fn() }));
vi.mock("@/lib/question-reports", () => ({ getReportQueue: mocks.getReportQueue }));
vi.mock("@/lib/question-report-actions", () => ({ reportQuestionAction: vi.fn() }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/consolidated-exam", () => ({ getConsolidatedExam: mocks.getConsolidatedExam }));
import QuestionReportsPage from "@/app/admin/reports/page";
import ConsolidatedExamPage from "@/app/courses/[courseId]/exam/page";

const course = { id: "course-a", code: "EECE350", name: "Computer Networks" };
const at = (minute: number) => new Date(`2026-10-24T08:${String(minute).padStart(2, "0")}:00Z`);
const item = {
  key: "group-1", groupId: "group-1", course, text: "Explain the TCP three-way handshake.", rank: 2, paperCount: 3, firstReportedAt: at(5),
  reasons: [{ reason: "WRONG_GROUPING", count: 2 }, { reason: "WRONG_TEXT", count: 1 }],
  reports: [
    { id: "r1", reason: "WRONG_GROUPING", note: null, createdAt: at(5) },
    { id: "r2", reason: "WRONG_GROUPING", note: "<b>Two</b> different questions.", createdAt: at(6) },
    { id: "r3", reason: "WRONG_TEXT", note: null, createdAt: at(7) },
  ],
};
const orphan = { ...item, key: "r9", groupId: null, text: "Define a socket.", rank: null, paperCount: null, firstReportedAt: at(9), reasons: [{ reason: "OTHER", count: 1 }],
  reports: [{ id: "r9", reason: "OTHER", note: null, createdAt: at(9) }] };
const adminPage = async (params: Record<string, string> = {}) => renderToStaticMarkup(await QuestionReportsPage({ searchParams: Promise.resolve(params) }));

const exam = {
  totalPapers: 6, lowConfidence: false,
  questions: [{ id: "group-1", position: 1, rank: 1, text: "Explain the TCP three-way handshake.", paperCount: 4, totalPapers: 6, papers: [], tier: "VERY_LIKELY" }],
} as const;
const examPage = async (params: Record<string, string> = {}) => renderToStaticMarkup(await ConsolidatedExamPage({
  params: Promise.resolve({ courseId: course.id }), searchParams: Promise.resolve(params),
}));

beforeEach(() => {
  mocks.requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", role: "ADMIN" });
  mocks.getCurrentUser.mockReset().mockResolvedValue({ id: "student-1", role: "STUDENT" });
  mocks.getReportQueue.mockReset().mockResolvedValue({ items: [item, orphan], total: 2, reportCount: 4, page: 1, totalPages: 1 });
  mocks.getCourseById.mockReset().mockResolvedValue(course);
  mocks.getConsolidatedExam.mockReset().mockResolvedValue({ ...exam, sections: [{ tier: "VERY_LIKELY", questions: exam.questions }] });
});

describe("question reports page (US-23)", () => {
  it("checks admin access before reading the queue", async () => {
    mocks.requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(QuestionReportsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.requireAdmin).toHaveBeenCalledWith("/admin/reports");
    expect(mocks.getReportQueue).not.toHaveBeenCalled();
  });
  it("shows each reported question with its course, rank, reasons, and student details as text", async () => {
    const html = await adminPage();
    expect(html).toContain("2 questions with 4 open reports.");
    expect(html).toContain("EECE350 · Rank 2 · 3 papers");
    expect(html).toContain("Explain the TCP three-way handshake.");
    expect(html).toContain("Reported by 3 students, first on 2026-10-24 08:05 UTC · Wrong grouping ×2 · Wrong text");
    expect(html).toContain("&lt;b&gt;Two&lt;/b&gt; different questions.");
    expect(html).not.toContain("<b>Two</b>");
    expect(html).toContain('href="/courses/course-a/exam"');
    expect(html.indexOf("Explain the TCP")).toBeLessThan(html.indexOf("Define a socket."));
  });
  it("says when a question was regrouped since it was reported", async () => {
    const html = await adminPage();
    expect(html).toContain("This question was regrouped after it was reported");
    expect(html).toContain("Reported by 1 student, first on 2026-10-24 08:09 UTC · Other");
  });
  it("asks for the requested page and links to the others", async () => {
    mocks.getReportQueue.mockResolvedValue({ items: [item], total: 45, reportCount: 50, page: 2, totalPages: 3 });
    const html = await adminPage({ page: "2" });
    expect(mocks.getReportQueue).toHaveBeenCalledWith(2);
    expect(html).toContain("Page 2 of 3");
    expect(html).toContain('href="/admin/reports?page=1"');
    expect(html).toContain('href="/admin/reports?page=3"');
  });
  it("shows an empty queue", async () => {
    mocks.getReportQueue.mockResolvedValue({ items: [], total: 0, reportCount: 0, page: 1, totalPages: 1 });
    const html = await adminPage();
    expect(html).toContain("No questions are reported.");
    expect(html).not.toContain("open report");
  });
});

describe("reporting from the Upcomer Exam (US-23)", () => {
  it("gives a logged-in student a report form under each question", async () => {
    const html = await examPage();
    expect(html).toContain("Report a problem with question 1");
    expect(html).toContain('<input type="hidden" name="groupId" value="group-1"/>');
    expect(html).toContain('<input type="hidden" name="courseId" value="course-a"/>');
    expect(html).toContain('<input type="hidden" name="position" value="1"/>');
    expect(html.match(/<input type="radio" required="" name="reason"/g)).toHaveLength(4);
    expect(html).toMatch(/<textarea name="note" maxLength="500"/);
    expect(html).not.toContain("to report a question");
  });
  it("asks a logged-out visitor to log in instead, coming back to the exam", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const html = await examPage();
    expect(html).not.toContain("Report a problem");
    expect(html).toContain('href="/login?next=%2Fcourses%2Fcourse-a%2Fexam"');
  });
  it("shows the outcome of the report, and only known messages for errors", async () => {
    expect(await examPage({ reported: "1" })).toContain("Thanks, your report was sent.");
    expect(await examPage({ report_error: "duplicate" })).toContain("You already reported this question.");
    const hostile = await examPage({ report_error: "<img src=x onerror=alert(1)>" });
    expect(hostile).toContain("Your report could not be sent. Please try again.");
    expect(hostile).not.toContain("onerror");
  });
});
