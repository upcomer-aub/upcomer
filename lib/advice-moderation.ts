import { AdviceReportStatus, AdviceStatus, type AdviceReportReason, type Prisma } from "@prisma/client";
import { invalidateCourseAdvice, toAdviceItem, type AdviceItem } from "@/lib/advice";
import { clampPage } from "@/lib/advice-rules";
import { db } from "@/lib/db";
import { logError } from "@/lib/logger";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";
import { timed } from "@/lib/timing";

// Moderation of reported advice (US-77). Admins see the advice that has open reports (US-43), one item per advice with
// every report's reason and details, and decide: remove the advice (it leaves every student-facing list at once and its
// reports are resolved) or keep it (its reports are dismissed). Admins get only what that decision needs: the advice as
// students see it, so an anonymous author stays anonymous here too, and the reports without who sent them. Nothing here
// checks the caller: the page and the actions call requireAdmin() first. Advice text and notes are never logged.

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

export const ADVICE_QUEUE_PAGE_SIZE = 20;
// DoS protection: decisions per admin per minute. Far above what a person decides, so it only stops a script or a stolen
// admin session.
export const ADVICE_MODERATION_WINDOW_MS = 60_000;
export const adviceModerationLimit = () => limitFromEnv("ADVICE_MODERATION_RATE_LIMIT_PER_MINUTE", 60);

const queueAdviceSelect = {
  id: true, courseId: true, authorId: true, body: true, anonymous: true, scope: true, topic: true, resourceUrl: true, editedAt: true, createdAt: true,
  status: true, removedById: true,
  author: { select: { name: true } },
  file: { select: { id: true, title: true, category: true, status: true } },
  term: { select: { name: true } },
  questionGroup: { select: { id: true, text: true } },
  course: { select: { id: true, code: true, name: true } },
} satisfies Prisma.AdviceSelect;

export type QueuedAdviceReport = { id: string; reason: AdviceReportReason; note: string | null; createdAt: Date };
export type AdviceQueueItem = {
  advice: AdviceItem;
  course: { id: string; code: string; name: string };
  // False once the author deleted the advice (US-36); the admin can then only close its reports.
  shown: boolean;
  firstReportedAt: Date;
  reasons: Array<{ reason: AdviceReportReason; count: number }>;
  // Oldest first.
  reports: QueuedAdviceReport[];
};
export type AdviceQueue = { items: AdviceQueueItem[]; total: number; reportCount: number; page: number; totalPages: number };

// The advice with open reports, the one reported longest ago first, 20 a page. An invalid or out-of-range page falls back
// to the first or last page.
export const getAdviceReportQueue = (requestedPage: unknown = 1) => timed("advice_report_queue", {}, async (): Promise<AdviceQueue> => {
  try {
    const rows = await db.adviceReport.findMany({
      where: { status: AdviceReportStatus.OPEN },
      select: { id: true, adviceId: true, reason: true, note: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const grouped = new Map<string, QueuedAdviceReport[]>();
    for (const row of rows) grouped.set(row.adviceId, [...grouped.get(row.adviceId) ?? [], { id: row.id, reason: row.reason, note: row.note, createdAt: row.createdAt }]);
    const order = [...grouped.keys()];
    const { page, totalPages } = clampPage(requestedPage, order.length, ADVICE_QUEUE_PAGE_SIZE);
    const pageIds = order.slice((page - 1) * ADVICE_QUEUE_PAGE_SIZE, page * ADVICE_QUEUE_PAGE_SIZE);
    const advice = new Map((await db.advice.findMany({ where: { id: { in: pageIds } }, select: queueAdviceSelect })).map(row => [row.id, row]));
    const items = pageIds.flatMap(adviceId => {
      const row = advice.get(adviceId);
      if (!row) return [];
      const reports = grouped.get(adviceId)!;
      const reasons: AdviceQueueItem["reasons"] = [];
      for (const report of reports) {
        const counted = reasons.find(entry => entry.reason === report.reason);
        if (counted) counted.count++;
        else reasons.push({ reason: report.reason, count: 1 });
      }
      return [{ advice: toAdviceItem(row), course: row.course, shown: row.status === AdviceStatus.VISIBLE, firstReportedAt: reports[0].createdAt, reasons, reports }];
    });
    return { items, total: order.length, reportCount: rows.length, page, totalPages };
  } catch (error) {
    logError("advice_report_queue_failed", { errorType: errorType(error) });
    throw error;
  }
});

export type ModerationDecision = "remove" | "keep";
export type ModerationRefusal = "invalid_decision" | "not_found" | "rate_limited" | "unexpected";
export type ModerationOutcome = { ok: true; decision: ModerationDecision; closedReports: number } | { ok: false; error: ModerationRefusal };

const isDecision = (value: string): value is ModerationDecision => value === "remove" || value === "keep";

// One admin decision on one reported advice. "remove" removes the advice (if it is still shown) and resolves all its open
// reports; "keep" leaves it and dismisses them. Both happen in one transaction and only touch open reports, so two admins
// deciding at once close each report once; the second gets "not_found". The course's feed cache is invalidated after a
// removal, so the advice leaves the feed at once.
export async function moderateAdvice(adminId: string, input: { adviceId: string; decision: string }): Promise<ModerationOutcome> {
  const adviceId = input.adviceId.trim();
  const refuse = (error: ModerationRefusal): ModerationOutcome => {
    logError("advice_moderation_refused", { adviceId: adviceId || undefined, decision: isDecision(input.decision) ? input.decision : undefined, reason: error, adminId });
    return { ok: false, error };
  };
  const limit = checkRateLimit(`advice-moderation:${adminId}`, adviceModerationLimit(), ADVICE_MODERATION_WINDOW_MS);
  if (!limit.ok) {
    logError("advice_moderation_rate_limited", { adminId, retryAfterSeconds: String(limit.retryAfterSeconds) });
    return { ok: false, error: "rate_limited" };
  }
  if (!isDecision(input.decision)) return refuse("invalid_decision");
  const decision = input.decision;
  if (!adviceId) return refuse("not_found");
  try {
    const outcome = await timed("advice_moderation", { adviceId, adminId }, () => db.$transaction(async tx => {
      // Two admins deciding on the same advice wait for each other.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`advice-moderation:${adviceId}`}))`;
      const advice = await tx.advice.findUnique({ where: { id: adviceId }, select: { courseId: true, status: true } });
      if (!advice) return null;
      const now = new Date();
      const { count } = await tx.adviceReport.updateMany({
        where: { adviceId, status: AdviceReportStatus.OPEN },
        data: { status: decision === "remove" ? AdviceReportStatus.RESOLVED : AdviceReportStatus.DISMISSED, closedAt: now, closedById: adminId },
      });
      // Nothing left to decide: no open report (already decided, or never reported).
      if (count === 0) return null;
      let removed = false;
      if (decision === "remove" && advice.status === AdviceStatus.VISIBLE) {
        await tx.advice.update({ where: { id: adviceId }, data: { status: AdviceStatus.REMOVED, removedAt: now, removedById: adminId } });
        removed = true;
      }
      return { courseId: advice.courseId, closedReports: count, removed };
    }));
    if (!outcome) return refuse("not_found");
    if (outcome.removed) invalidateCourseAdvice(outcome.courseId);
    logError(decision === "remove" ? "advice_removed_by_admin" : "advice_reports_dismissed", {
      adviceId, courseId: outcome.courseId, adminId, closedReports: String(outcome.closedReports), ...(decision === "remove" && { adviceRemoved: String(outcome.removed) }),
    });
    return { ok: true, decision, closedReports: outcome.closedReports };
  } catch (error) {
    logError("advice_moderation_failed", { adviceId, adminId, errorType: errorType(error) });
    return { ok: false, error: "unexpected" };
  }
}
