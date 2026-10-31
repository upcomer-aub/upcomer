import { QuestionReportStatus, type QuestionReportReason } from "@prisma/client";
import { db } from "@/lib/db";
import { PUBLISHED_FILES } from "@/lib/file-visibility";
import { logError } from "@/lib/logger";
import { isReportReason, MAX_REPORT_NOTE_LENGTH, type ReportRefusal } from "@/lib/question-report-rules";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";
import { readable } from "@/lib/submission-review";
import { timed } from "@/lib/timing";

// Question reports (US-23): a student reports a wrong question from the Upcomer Exam, and it reaches the admin queue at
// /admin/reports with its question and course. Admin corrections (US-75) close reports with closeQuestionReports.
// Nothing here checks the caller: the actions and pages call requireUser()/requireAdmin() first.

// Reports per student per minute. Far above what a person clicks, so it only stops a script or a stolen session.
export const REPORT_WINDOW_MS = 60_000;
export const reportLimit = () => limitFromEnv("QUESTION_REPORT_RATE_LIMIT_PER_MINUTE", 10);
export const REPORT_QUEUE_PAGE_SIZE = 20;

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

export type ReportInput = { groupId: string; reason: string; note?: string };
export type ReportOutcome = { ok: true; reportId: string; courseId: string } | { ok: false; error: ReportRefusal };

// A note made only of spaces or invisible characters counts as no note.
function cleanNote(note = "") {
  const trimmed = note.trim();
  return readable(trimmed) ? trimmed : null;
}

// Files one report for a student. The question text and course are taken from the stored group, never from the form.
// A student who already has an open report of the question gets "duplicate", and no second report is opened.
export async function reportQuestion(userId: string, input: ReportInput): Promise<ReportOutcome> {
  const groupId = input.groupId.trim();
  const refuse = (error: ReportRefusal): ReportOutcome => {
    logError("question_report_refused", { groupId: groupId || undefined, reason: error, userId });
    return { ok: false, error };
  };
  const limit = checkRateLimit(`question-report:${userId}`, reportLimit(), REPORT_WINDOW_MS);
  if (!limit.ok) {
    logError("question_report_rate_limited", { userId, retryAfterSeconds: String(limit.retryAfterSeconds) });
    return { ok: false, error: "rate_limited" };
  }
  if (!isReportReason(input.reason)) return refuse("invalid_reason");
  const reason: QuestionReportReason = input.reason;
  const note = cleanNote(input.note);
  if (note && note.length > MAX_REPORT_NOTE_LENGTH) return refuse("note_too_long");
  if (!groupId) return refuse("not_found");
  try {
    const outcome = await timed("question_report", { groupId, userId }, () => db.$transaction(async tx => {
      // Two clicks of the same student on the same question wait for each other, so only one report is opened.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`question-report:${groupId}:${userId}`}))`;
      // Only a question students can see can be reported: one with a question from a published paper (US-13).
      const group = await tx.questionGroup.findFirst({
        where: { id: groupId, questions: { some: { file: PUBLISHED_FILES } } },
        select: { id: true, courseId: true, text: true },
      });
      if (!group) return "not_found" as const;
      const open = await tx.questionReport.findFirst({ where: { groupId, reporterId: userId, status: QuestionReportStatus.OPEN }, select: { id: true } });
      if (open) return "duplicate" as const;
      return tx.questionReport.create({
        data: { courseId: group.courseId, groupId: group.id, reporterId: userId, questionText: group.text, reason, note },
        select: { id: true, courseId: true },
      });
    }));
    if (typeof outcome === "string") return refuse(outcome);
    logError("question_report_submitted", { reportId: outcome.id, courseId: outcome.courseId, groupId, category: reason, userId });
    return { ok: true, reportId: outcome.id, courseId: outcome.courseId };
  } catch (error) {
    logError("question_report_failed", { groupId, userId, errorType: errorType(error) });
    return { ok: false, error: "unexpected" };
  }
}

const reportSelect = {
  id: true, groupId: true, questionText: true, reason: true, note: true, createdAt: true,
  course: { select: { id: true, code: true, name: true } },
  group: { select: { id: true, text: true, rank: true, paperCount: true } },
} as const;

export type QueuedReport = { id: string; reason: QuestionReportReason; note: string | null; createdAt: Date };
export type ReportQueueItem = {
  // The group's ID, or the report's own ID once a regroup removed the group.
  key: string;
  groupId: string | null;
  course: { id: string; code: string; name: string };
  // The question as it is now, or as it was reported if its group is gone.
  text: string;
  rank: number | null;
  paperCount: number | null;
  firstReportedAt: Date;
  reasons: Array<{ reason: QuestionReportReason; count: number }>;
  // Oldest first.
  reports: QueuedReport[];
};

// The open reports, one item per question, the question reported longest ago first. An invalid or out-of-range page falls
// back to the first or last page, like the submission queue.
export const getReportQueue = (requestedPage = 1) => timed("question_report_queue", {}, async () => {
  try {
    const rows = await db.questionReport.findMany({ where: { status: QuestionReportStatus.OPEN }, select: reportSelect, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const items = new Map<string, ReportQueueItem>();
    for (const row of rows) {
      const key = row.groupId ?? row.id;
      const item = items.get(key) ?? {
        key, groupId: row.groupId, course: row.course, text: row.group?.text ?? row.questionText,
        rank: row.group?.rank ?? null, paperCount: row.group?.paperCount ?? null, firstReportedAt: row.createdAt, reasons: [], reports: [],
      };
      item.reports.push({ id: row.id, reason: row.reason, note: row.note, createdAt: row.createdAt });
      const counted = item.reasons.find(entry => entry.reason === row.reason);
      if (counted) counted.count++;
      else item.reasons.push({ reason: row.reason, count: 1 });
      items.set(key, item);
    }
    const all = [...items.values()];
    const totalPages = Math.max(1, Math.ceil(all.length / REPORT_QUEUE_PAGE_SIZE));
    const page = Number.isInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, totalPages) : 1;
    return { items: all.slice((page - 1) * REPORT_QUEUE_PAGE_SIZE, page * REPORT_QUEUE_PAGE_SIZE), total: all.length, reportCount: rows.length, page, totalPages };
  } catch (error) {
    logError("question_report_retrieval_failed", { errorType: errorType(error) });
    throw error;
  }
});

// For admin corrections (US-75): closes every open report of a question, or the given reports, for one admin. Returns how
// many were closed. The caller checks the admin and logs the correction itself.
export async function closeQuestionReports(adminId: string, target: { groupId: string } | { reportIds: string[] }, status: "RESOLVED" | "DISMISSED" = "RESOLVED") {
  const where = "groupId" in target ? { groupId: target.groupId } : { id: { in: target.reportIds } };
  const { count } = await db.questionReport.updateMany({
    where: { ...where, status: QuestionReportStatus.OPEN },
    data: { status, closedAt: new Date(), closedById: adminId },
  });
  return count;
}
