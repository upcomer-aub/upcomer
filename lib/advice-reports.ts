import { AdviceReportStatus, AdviceStatus, type AdviceReportReason } from "@prisma/client";
import { toAdviceItem, visibleCourseAdvice, type AdviceItem } from "@/lib/advice";
import { isAdviceReportReason, MAX_ADVICE_REPORT_NOTE_LENGTH, type AdviceReportRefusal } from "@/lib/advice-report-rules";
import { db } from "@/lib/db";
import { logError } from "@/lib/logger";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";
import { hasReadableText } from "@/lib/readable-text";
import { timed } from "@/lib/timing";

// Advice reports (US-43): a student reports a piece of advice from the course feed, with a reason and optional details,
// and it waits for an admin (US-77). The report is linked to the advice itself, so the admin sees the post as it is now.
// A student has at most one open report per advice: a second one is refused as "duplicate", also when two clicks race.
// Students cannot report their own advice (they can edit or delete it, US-36). Nothing here checks the session: the
// actions and pages call requireUser() first. The note and the advice text are never logged.

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

// DoS protection: reports per student per minute. Far above what a person sends, so it only stops a script or a stolen
// session.
export const ADVICE_REPORT_WINDOW_MS = 60_000;
export const adviceReportLimit = () => limitFromEnv("ADVICE_REPORT_RATE_LIMIT_PER_MINUTE", 10);

export type AdviceReportInput = { adviceId: string; reason: string; note?: string };
export type AdviceReportOutcome = { ok: true; reportId: string; courseId: string } | { ok: false; error: AdviceReportRefusal };

// A note made only of spaces or invisible characters counts as no note. Windows line breaks count once, as the browser
// counts them.
function cleanNote(note = "") {
  const trimmed = note.replace(/\r\n/g, "\n").trim();
  return hasReadableText(trimmed) ? trimmed : null;
}

// Files one report for a student. The course is taken from the stored advice, never from the form.
export async function reportAdvice(userId: string, input: AdviceReportInput): Promise<AdviceReportOutcome> {
  const adviceId = input.adviceId.trim();
  const refuse = (error: AdviceReportRefusal): AdviceReportOutcome => {
    logError("advice_report_refused", { adviceId: adviceId || undefined, reason: error, userId });
    return { ok: false, error };
  };
  const limit = checkRateLimit(`advice-report:${userId}`, adviceReportLimit(), ADVICE_REPORT_WINDOW_MS);
  if (!limit.ok) {
    logError("advice_report_rate_limited", { userId, retryAfterSeconds: String(limit.retryAfterSeconds) });
    return { ok: false, error: "rate_limited" };
  }
  if (!isAdviceReportReason(input.reason)) return refuse("invalid_reason");
  const reason: AdviceReportReason = input.reason;
  const note = cleanNote(input.note);
  if (note && note.length > MAX_ADVICE_REPORT_NOTE_LENGTH) return refuse("note_too_long");
  if (!adviceId) return refuse("not_found");
  try {
    const outcome = await timed("advice_report", { adviceId, userId }, () => db.$transaction(async tx => {
      // Two clicks of the same student on the same advice wait for each other, so only one report is opened.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`advice-report:${adviceId}:${userId}`}))`;
      // Only advice students can see can be reported.
      const advice = await tx.advice.findFirst({ where: { id: adviceId, status: AdviceStatus.VISIBLE }, select: { id: true, courseId: true, authorId: true } });
      if (!advice) return "not_found" as const;
      if (advice.authorId === userId) return "own_advice" as const;
      const open = await tx.adviceReport.findFirst({ where: { adviceId, reporterId: userId, status: AdviceReportStatus.OPEN }, select: { id: true } });
      if (open) return "duplicate" as const;
      return tx.adviceReport.create({
        data: { adviceId: advice.id, courseId: advice.courseId, reporterId: userId, reason, note },
        select: { id: true, courseId: true },
      });
    }));
    if (typeof outcome === "string") return refuse(outcome);
    logError("advice_report_submitted", { reportId: outcome.id, courseId: outcome.courseId, adviceId, category: reason, userId });
    return { ok: true, reportId: outcome.id, courseId: outcome.courseId };
  } catch (error) {
    logError("advice_report_failed", { adviceId, userId, errorType: errorType(error) });
    return { ok: false, error: "unexpected" };
  }
}

const reportableSelect = {
  id: true, authorId: true, body: true, anonymous: true, scope: true, topic: true, resourceUrl: true, editedAt: true, createdAt: true,
  author: { select: { name: true } },
  file: { select: { id: true, title: true, category: true, status: true } },
  term: { select: { name: true } },
  questionGroup: { select: { id: true, text: true } },
} as const;

// For the report page: the advice as students see it, if it is shown in this course, with whether it is the student's own
// and whether they already have an open report of it; null otherwise. The author's ID never leaves this function.
export const getReportableAdvice = (userId: string, courseId: string, adviceId: string) => timed("advice_reportable_read", { adviceId, userId },
  async (): Promise<{ advice: AdviceItem; own: boolean; reported: boolean } | null> => {
    if (!adviceId || !courseId) return null;
    const row = await db.advice.findFirst({ where: { ...visibleCourseAdvice(courseId), id: adviceId }, select: reportableSelect });
    if (!row) return null;
    const own = row.authorId === userId;
    const reported = !own && (await db.adviceReport.count({ where: { adviceId, reporterId: userId, status: AdviceReportStatus.OPEN } })) > 0;
    return { advice: toAdviceItem(row), own, reported };
  });

// Which of the given advice the student has an open report of, so the feed says "You reported this" instead of offering
// the form again. One indexed query for a page of at most 20 advice.
export const getOpenReportedAdviceIds = (userId: string, adviceIds: string[]) => timed("advice_reported_read", { userId }, async () => {
  if (!adviceIds.length) return new Set<string>();
  const rows = await db.adviceReport.findMany({
    where: { reporterId: userId, status: AdviceReportStatus.OPEN, adviceId: { in: adviceIds } },
    select: { adviceId: true },
  });
  return new Set(rows.map(row => row.adviceId));
});
