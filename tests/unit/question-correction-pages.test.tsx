import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { requireAdmin, getCorrectionPage, getQuestionCorrection, notFound } = vi.hoisted(() => ({
  requireAdmin: vi.fn(), getCorrectionPage: vi.fn(), getQuestionCorrection: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));
vi.mock("@/lib/auth", () => ({ requireAdmin }));
vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/lib/question-corrections", () => ({ getCorrectionPage, getQuestionCorrection }));
vi.mock("@/lib/question-correction-actions", () => ({
  editQuestionTextAction: vi.fn(), moveQuestionAction: vi.fn(), splitQuestionAction: vi.fn(), resetQuestionGroupAction: vi.fn(),
}));
import CourseQuestionCorrectionsPage from "@/app/admin/questions/[courseId]/page";
import QuestionCorrectionPage from "@/app/admin/questions/[courseId]/[questionId]/page";

const course = { id: "course-eece350", code: "EECE350", name: "Computer Networks" };
const paper = { id: "file-a", title: "Final 2024", year: 2024 };
const tcp = { id: "q-1", number: 1, text: "1. Explain TCP.", splitOut: false, pinnedToQuestionId: null, textCorrectedAt: null, file: paper };
const moved = { ...tcp, id: "q-2", number: 2, text: "2. Describe TCP.", pinnedToQuestionId: "q-1", textCorrectedAt: new Date("2026-10-20T10:00:00Z") };
const logEntry = {
  id: "log-1", kind: "EDIT_TEXT", paperTitle: "Final 2024", questionNumber: 2, before: "2. Descrbe TCP.", after: "2. Describe TCP.",
  createdAt: new Date("2026-10-20T10:00:00Z"), questionId: "q-2", admin: { name: "Admin One" },
};
const listView = { course, groups: [{ id: "g-1", rank: 1, text: "Explain TCP.", paperCount: 2, questions: [tcp, moved] }], total: 1, page: 1, totalPages: 1, totalPapers: 3, log: [logEntry], query: "" };
const questionView = {
  course, question: { ...moved, group: { id: "g-1", rank: 1, text: "Explain TCP.", paperCount: 2 } },
  groups: [{ id: "g-1", rank: 1, text: "Explain TCP." }, { id: "g-2", rank: 2, text: "Define the OSI model." }], history: [logEntry],
};

const renderList = async (search: Record<string, string> = {}) => renderToStaticMarkup(await CourseQuestionCorrectionsPage({ params: Promise.resolve({ courseId: course.id }), searchParams: Promise.resolve(search) }));
const renderQuestion = async (search: Record<string, string> = {}) => renderToStaticMarkup(await QuestionCorrectionPage({ params: Promise.resolve({ courseId: course.id, questionId: "q-2" }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", role: "ADMIN" });
  getCorrectionPage.mockReset().mockResolvedValue(listView);
  getQuestionCorrection.mockReset().mockResolvedValue(questionView);
});

describe("course corrections page", () => {
  it("checks admin access before reading anything", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(renderList()).rejects.toThrow("NEXT_REDIRECT");
    expect(requireAdmin).toHaveBeenCalledWith("/admin/questions/course-eece350");
    expect(getCorrectionPage).not.toHaveBeenCalled();
  });
  it("lists the groups with their counts, questions, correction tags, and links, and the activity log", async () => {
    const html = await renderList();
    expect(html).toContain("#1 · in 2 of 3 papers");
    expect(html).toContain("Final 2024, question 2");
    expect(html).toContain("Text corrected");
    expect(html).toContain("Moved by an admin");
    expect(html).toContain('href="/admin/questions/course-eece350/q-2"');
    expect(html).toContain('aria-label="Corrections in EECE350"');
    expect(html).toContain("Admin One");
    expect(html).toContain("From “2. Descrbe TCP.” to “2. Describe TCP.”");
  });
  it("passes the page and keyword on and keeps the keyword in the page links", async () => {
    getCorrectionPage.mockResolvedValue({ ...listView, page: 2, totalPages: 3, query: "tcp" });
    const html = await renderList({ page: "2", q: "tcp" });
    expect(getCorrectionPage).toHaveBeenCalledWith(course.id, { page: 2, query: "tcp" });
    expect(html).toContain("Page 2 of 3");
    expect(html).toContain('href="/admin/questions/course-eece350?q=tcp&amp;page=1"');
    expect(html).toContain('href="/admin/questions/course-eece350?q=tcp&amp;page=3"');
  });
  it("shows a not found page for an unknown course and an empty message for a course without questions", async () => {
    getCorrectionPage.mockResolvedValueOnce(null);
    await expect(renderList()).rejects.toThrow("NEXT_NOT_FOUND");
    getCorrectionPage.mockResolvedValue({ ...listView, groups: [], total: 0, log: [] });
    const html = await renderList();
    expect(html).toContain("This course has no extracted questions yet.");
    expect(html).toContain("No corrections yet.");
  });
});

describe("question correction page", () => {
  it("checks admin access with the question's route", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(renderQuestion()).rejects.toThrow("NEXT_REDIRECT");
    expect(requireAdmin).toHaveBeenCalledWith("/admin/questions/course-eece350/q-2");
    expect(getQuestionCorrection).not.toHaveBeenCalled();
  });
  it("shows the edit form with the current text, only other groups to move to, and both group actions for a moved question", async () => {
    const html = await renderQuestion();
    expect(html).toMatch(/<textarea name="text" required="" maxLength="2000" rows="6">2. Describe TCP.<\/textarea>/);
    expect(html).toContain('<input type="hidden" name="previousText" value="2. Describe TCP."/>');
    expect(html).toContain('<option value="g-2">#2 Define the OSI model.</option>');
    expect(html).not.toContain('<option value="g-1">');
    expect(html).toContain("Split into its own group");
    expect(html).toContain("Group by text again");
  });
  it("offers no undo for an uncorrected question and no split for a split one", async () => {
    getQuestionCorrection.mockResolvedValueOnce({ ...questionView, question: { ...questionView.question, pinnedToQuestionId: null } });
    expect(await renderQuestion()).not.toContain("Group by text again");
    getQuestionCorrection.mockResolvedValueOnce({ ...questionView, question: { ...questionView.question, pinnedToQuestionId: null, splitOut: true } });
    const split = await renderQuestion();
    expect(split).not.toContain("Split into its own group");
    expect(split).toContain("Group by text again");
  });
  it("shows the outcome, a failed regroup, and only known messages for errors", async () => {
    expect(await renderQuestion({ saved: "move" })).toContain("Question moved. The counts and ranking are updated.");
    expect(await renderQuestion({ saved: "edit", regroup: "failed" })).toContain("could not be regrouped");
    expect(await renderQuestion({ error: "stale" })).toContain("Someone else changed this question");
    const hostile = await renderQuestion({ error: "<img src=x onerror=alert(1)>", saved: "<b>x</b>" });
    expect(hostile).toContain("Something went wrong. Please try again.");
    expect(hostile).not.toContain("<img");
  });
  it("shows a not found page for a question that is not in the course", async () => {
    getQuestionCorrection.mockResolvedValue(null);
    await expect(renderQuestion()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
