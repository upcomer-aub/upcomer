import { beforeEach, describe, expect, it, vi } from "vitest";

const { tx, questionReport, transaction, requireUser, redirect } = vi.hoisted(() => {
  const questionReport = { findMany: vi.fn(), updateMany: vi.fn() };
  return {
    questionReport,
    tx: { $executeRaw: vi.fn(), questionGroup: { findFirst: vi.fn() }, questionReport: { findFirst: vi.fn(), create: vi.fn() } },
    transaction: vi.fn(),
    requireUser: vi.fn(),
    redirect: vi.fn((location: string) => { throw new Error(`NEXT_REDIRECT ${location}`); }),
  };
});
vi.mock("@/lib/db", () => ({ db: { $transaction: transaction, questionReport } }));
vi.mock("@/lib/auth", () => ({ requireUser }));
vi.mock("next/navigation", () => ({ redirect }));
import { reportQuestionAction } from "@/lib/question-report-actions";
import { MAX_REPORT_NOTE_LENGTH, reportMessage } from "@/lib/question-report-rules";
import { closeQuestionReports, getReportQueue, REPORT_QUEUE_PAGE_SIZE, reportLimit, reportQuestion } from "@/lib/question-reports";
import { resetRateLimits } from "@/lib/rate-limit";

let errors: ReturnType<typeof vi.spyOn>;
const logged = () => errors.mock.calls.map(call => JSON.parse(String(call[0])));
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const redirectedTo = async (run: Promise<unknown>) => {
  await expect(run).rejects.toThrow("NEXT_REDIRECT");
  return redirect.mock.calls.at(-1)?.[0];
};
const group = { id: "group-1", courseId: "course-a", text: "Explain the TCP three-way handshake." };
const valid = { groupId: "group-1", reason: "WRONG_GROUPING", note: "These are two different questions." };

beforeEach(() => {
  resetRateLimits();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  transaction.mockReset().mockImplementation((work: (client: typeof tx) => unknown) => work(tx));
  tx.$executeRaw.mockReset().mockResolvedValue(1);
  tx.questionGroup.findFirst.mockReset().mockResolvedValue(group);
  tx.questionReport.findFirst.mockReset().mockResolvedValue(null);
  tx.questionReport.create.mockReset().mockImplementation(({ data }) => Promise.resolve({ id: "report-1", courseId: data.courseId }));
  questionReport.findMany.mockReset().mockResolvedValue([]);
  questionReport.updateMany.mockReset().mockResolvedValue({ count: 2 });
  requireUser.mockReset().mockResolvedValue({ id: "student-1", role: "STUDENT" });
  redirect.mockClear();
});

describe("reportQuestion (US-23)", () => {
  it("opens a report with the stored question and course, under a per-student, per-question lock", async () => {
    expect(await reportQuestion("student-1", valid)).toEqual({ ok: true, reportId: "report-1", courseId: "course-a" });
    expect(tx.$executeRaw.mock.calls[0].slice(1)).toEqual(["question-report:group-1:student-1"]);
    expect(tx.questionGroup.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "group-1", questions: { some: { file: { status: "PUBLISHED" } } } } }));
    expect(tx.questionReport.create).toHaveBeenCalledWith(expect.objectContaining({ data: {
      courseId: "course-a", groupId: "group-1", reporterId: "student-1", questionText: group.text, reason: "WRONG_GROUPING", note: "These are two different questions.",
    } }));
  });
  it("logs the report with IDs and the reason only, never the note or the question", async () => {
    await reportQuestion("student-1", valid);
    expect(logged()).toEqual([expect.objectContaining({
      event: "question_report_submitted", level: "info", reportId: "report-1", courseId: "course-a", groupId: "group-1", category: "WRONG_GROUPING", userId: "student-1",
    })]);
    expect(JSON.stringify(logged())).not.toMatch(/different questions|handshake/);
  });
  it("does not open a second report while the student's first one is open", async () => {
    tx.questionReport.findFirst.mockResolvedValue({ id: "report-0" });
    expect(await reportQuestion("student-1", valid)).toEqual({ ok: false, error: "duplicate" });
    expect(tx.questionReport.findFirst).toHaveBeenCalledWith({ where: { groupId: "group-1", reporterId: "student-1", status: "OPEN" }, select: { id: true } });
    expect(tx.questionReport.create).not.toHaveBeenCalled();
    expect(logged()).toEqual([expect.objectContaining({ event: "question_report_refused", level: "warn", reason: "duplicate", groupId: "group-1" })]);
  });
  it("refuses a question students cannot see, or no question at all", async () => {
    tx.questionGroup.findFirst.mockResolvedValue(null);
    expect(await reportQuestion("student-1", valid)).toEqual({ ok: false, error: "not_found" });
    expect(await reportQuestion("student-1", { ...valid, groupId: "  " })).toEqual({ ok: false, error: "not_found" });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.questionReport.create).not.toHaveBeenCalled();
  });
  it.each(["", "wrong_grouping", "DELETE", "toString", "__proto__"])("refuses the reason %j before touching the database", async reason => {
    expect(await reportQuestion("student-1", { ...valid, reason })).toEqual({ ok: false, error: "invalid_reason" });
    expect(transaction).not.toHaveBeenCalled();
  });
  it("accepts a note up to the limit, refuses a longer one, and stores a blank or invisible note as none", async () => {
    expect(await reportQuestion("student-1", { ...valid, note: "x".repeat(MAX_REPORT_NOTE_LENGTH) })).toMatchObject({ ok: true });
    expect(await reportQuestion("student-2", { ...valid, note: "x".repeat(MAX_REPORT_NOTE_LENGTH + 1) })).toEqual({ ok: false, error: "note_too_long" });
    await reportQuestion("student-3", { ...valid, note: " ​ ﻿ " });
    await reportQuestion("student-4", { groupId: "group-1", reason: "OTHER" });
    expect(tx.questionReport.create.mock.calls.slice(1).map(([call]) => call.data.note)).toEqual([null, null]);
  });
  it("limits each student's reports per minute and logs it", async () => {
    for (let index = 0; index < reportLimit(); index++) expect(await reportQuestion("student-1", valid)).toMatchObject({ ok: true });
    expect(await reportQuestion("student-1", valid)).toEqual({ ok: false, error: "rate_limited" });
    expect(await reportQuestion("student-2", valid)).toMatchObject({ ok: true });
    expect(logged()).toContainEqual(expect.objectContaining({ event: "question_report_rate_limited", level: "warn", userId: "student-1" }));
  });
  it("logs a database failure with the error type only", async () => {
    transaction.mockRejectedValue(Object.assign(new Error("connection refused"), { name: "PrismaClientInitializationError" }));
    expect(await reportQuestion("student-1", valid)).toEqual({ ok: false, error: "unexpected" });
    expect(logged()).toEqual([expect.objectContaining({ event: "question_report_failed", level: "error", groupId: "group-1", errorType: "PrismaClientInitializationError" })]);
    expect(JSON.stringify(logged())).not.toContain("connection refused");
  });
});

describe("reportQuestionAction", () => {
  it("requires a session for the exam page, then returns to the reported question", async () => {
    const location = await redirectedTo(reportQuestionAction(form({ courseId: "course-a", position: "3", ...valid })));
    expect(requireUser).toHaveBeenCalledWith("/courses/course-a/exam");
    expect(location).toBe("/courses/course-a/exam?reported=1#question-3");
  });
  it("returns the refusal without the note, and ignores a position that is not a number", async () => {
    tx.questionReport.findFirst.mockResolvedValue({ id: "report-0" });
    const location = await redirectedTo(reportQuestionAction(form({ courseId: "course-a", position: "x\"><script>", ...valid })));
    expect(location).toBe("/courses/course-a/exam?report_error=duplicate");
  });
  it("keeps a hostile course ID inside its path segment", async () => {
    const location = await redirectedTo(reportQuestionAction(form({ courseId: "../../admin?x=1", ...valid })));
    expect(location).toMatch(/^\/courses\/\.\.%2F\.\.%2Fadmin%3Fx%3D1\/exam\?/);
  });
  it("sends a logged-out student to log in before anything is stored", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    await expect(reportQuestionAction(form({ courseId: "course-a", ...valid }))).rejects.toThrow("NEXT_REDIRECT /login");
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("reportMessage", () => {
  it("has a message for every refusal and the general one for anything else", () => {
    expect(reportMessage("duplicate")).toBe("You already reported this question. An admin will check it.");
    expect(reportMessage("<b>x</b>")).toBe("Your report could not be sent. Please try again.");
    expect(reportMessage("constructor")).toBe("Your report could not be sent. Please try again.");
  });
});

describe("getReportQueue", () => {
  const course = { id: "course-a", code: "EECE350", name: "Computer Networks" };
  const row = (id: string, groupId: string | null, minute: number, reason = "WRONG_GROUPING", note: string | null = null) => ({
    id, groupId, questionText: `Snapshot ${id}`, reason, note, createdAt: new Date(`2026-10-24T08:${String(minute).padStart(2, "0")}:00Z`), course,
    group: groupId ? { id: groupId, text: `Current ${groupId}`, rank: 2, paperCount: 3 } : null,
  });

  it("shows the open reports of one question as one item, oldest first, with reason counts", async () => {
    questionReport.findMany.mockResolvedValue([
      row("r1", "group-1", 0), row("r2", "group-2", 1, "WRONG_TEXT", "Cut off."), row("r3", "group-1", 2, "WRONG_GROUPING", "Two questions."), row("r4", "group-1", 3, "OTHER"),
    ]);
    const queue = await getReportQueue();
    expect(questionReport.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "OPEN" } }));
    expect(queue).toMatchObject({ total: 2, reportCount: 4, page: 1, totalPages: 1 });
    expect(queue.items.map(item => [item.key, item.text, item.reports.map(report => report.id)])).toEqual([
      ["group-1", "Current group-1", ["r1", "r3", "r4"]], ["group-2", "Current group-2", ["r2"]],
    ]);
    expect(queue.items[0].reasons).toEqual([{ reason: "WRONG_GROUPING", count: 2 }, { reason: "OTHER", count: 1 }]);
    expect(queue.items[0]).toMatchObject({ rank: 2, paperCount: 3, firstReportedAt: new Date("2026-10-24T08:00:00Z"), course });
  });
  it("keeps reports whose question was regrouped away as separate items with the text the student saw", async () => {
    questionReport.findMany.mockResolvedValue([row("r1", null, 0), row("r2", null, 1)]);
    const queue = await getReportQueue();
    expect(queue.items.map(item => [item.key, item.groupId, item.text, item.rank])).toEqual([["r1", null, "Snapshot r1", null], ["r2", null, "Snapshot r2", null]]);
  });
  it("pages the questions and falls back to a valid page", async () => {
    questionReport.findMany.mockResolvedValue(Array.from({ length: REPORT_QUEUE_PAGE_SIZE + 3 }, (_, index) => row(`r${index}`, `group-${index}`, index % 60)));
    expect(await getReportQueue(2)).toMatchObject({ page: 2, totalPages: 2, items: { length: 3 } });
    expect((await getReportQueue(99)).page).toBe(2);
    expect((await getReportQueue(Number("abc"))).page).toBe(1);
    expect((await getReportQueue(-1)).items).toHaveLength(REPORT_QUEUE_PAGE_SIZE);
  });
  it("logs a failure to read the queue and lets it reach the error page", async () => {
    questionReport.findMany.mockRejectedValue(Object.assign(new Error("down"), { name: "PrismaClientKnownRequestError" }));
    await expect(getReportQueue()).rejects.toThrow("down");
    expect(logged()).toContainEqual(expect.objectContaining({ event: "question_report_retrieval_failed", level: "error", errorType: "PrismaClientKnownRequestError" }));
  });
});

describe("closeQuestionReports (for US-75)", () => {
  it("closes the open reports of a question, or the given reports, for one admin", async () => {
    expect(await closeQuestionReports("admin-1", { groupId: "group-1" })).toBe(2);
    expect(questionReport.updateMany).toHaveBeenCalledWith({
      where: { groupId: "group-1", status: "OPEN" }, data: { status: "RESOLVED", closedAt: expect.any(Date), closedById: "admin-1" },
    });
    await closeQuestionReports("admin-1", { reportIds: ["r1"] }, "DISMISSED");
    expect(questionReport.updateMany).toHaveBeenLastCalledWith({
      where: { id: { in: ["r1"] }, status: "OPEN" }, data: { status: "DISMISSED", closedAt: expect.any(Date), closedById: "admin-1" },
    });
  });
});
