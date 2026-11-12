import { AdviceStatus } from "@prisma/client";
import { invalidateCourseAdvice, toAdviceItem, visibleCourseAdvice, type AdviceItem } from "@/lib/advice";
import { checkAdviceDraft, type AdviceChangeRefusal } from "@/lib/advice-rules";
import { db } from "@/lib/db";
import { logError } from "@/lib/logger";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";
import { timed } from "@/lib/timing";

// An author edits or deletes their own advice (US-36). Only the author can: every read and write here matches the advice
// by its ID and the caller's user ID together, so another student's advice is "not found", the same as advice that does
// not exist (nobody learns who wrote an anonymous advice by trying). Removed advice (deleted, or removed by an admin,
// US-77) cannot be edited back into the feed. After each change the course's feed cache is invalidated, so the change
// shows at once. Nothing here checks the session: the actions and pages call requireUser() first. Advice text is never
// logged.

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

// DoS protection: edits and deletes per student per minute. Far above what a person does, so it only stops a script or a
// stolen session.
export const ADVICE_CHANGE_WINDOW_MS = 60_000;
export const adviceChangeLimit = () => limitFromEnv("ADVICE_CHANGE_RATE_LIMIT_PER_MINUTE", 20);

export type AdviceChangeOutcome = { ok: true; courseId: string; changed: boolean } | { ok: false; error: AdviceChangeRefusal };

// The author's own advice, in the given course and still shown, for the edit page; null for anyone else's.
export type OwnAdvice = AdviceItem & { courseId: string };

const ownAdviceSelect = {
  id: true, authorId: true, courseId: true, body: true, anonymous: true, scope: true, topic: true, resourceUrl: true, editedAt: true, createdAt: true,
  author: { select: { name: true } },
  file: { select: { id: true, title: true, category: true, status: true } },
  term: { select: { name: true } },
  questionGroup: { select: { id: true, text: true } },
} as const;

export const getOwnAdvice = (userId: string, courseId: string, adviceId: string) => timed("advice_own_read", { adviceId, userId }, async (): Promise<OwnAdvice | null> => {
  if (!adviceId || !courseId) return null;
  const row = await db.advice.findFirst({ where: { ...visibleCourseAdvice(courseId), id: adviceId, authorId: userId }, select: ownAdviceSelect });
  return row ? { ...toAdviceItem(row), courseId: row.courseId } : null;
});

// The same match for every change: this advice, by this author, still shown.
const ownVisible = (userId: string, adviceId: string) => ({ id: adviceId, authorId: userId, status: AdviceStatus.VISIBLE });

function allowChange(userId: string, operation: "edit" | "delete") {
  const limit = checkRateLimit(`advice-change:${userId}`, adviceChangeLimit(), ADVICE_CHANGE_WINDOW_MS);
  if (limit.ok) return true;
  logError("advice_change_rate_limited", { userId, operation, retryAfterSeconds: String(limit.retryAfterSeconds) });
  return false;
}

const refuse = (userId: string, operation: "edit" | "delete", adviceId: string, error: AdviceChangeRefusal): AdviceChangeOutcome => {
  logError("advice_change_refused", { adviceId: adviceId || undefined, operation, reason: error, userId });
  return { ok: false, error };
};

// Saves new text and resource link for the author. Saving the advice unchanged writes nothing and does not mark it edited.
export async function editAdvice(userId: string, input: { adviceId: string; body: string; resourceUrl?: string }): Promise<AdviceChangeOutcome> {
  const adviceId = input.adviceId.trim();
  if (!allowChange(userId, "edit")) return { ok: false, error: "rate_limited" };
  if (!adviceId) return refuse(userId, "edit", adviceId, "not_found");
  const checked = checkAdviceDraft(input);
  if (!checked.ok) return refuse(userId, "edit", adviceId, checked.error);
  const { body, resourceUrl } = checked.draft;
  try {
    const outcome = await timed("advice_edit", { adviceId, userId }, async () => {
      const current = await db.advice.findFirst({ where: ownVisible(userId, adviceId), select: { courseId: true, body: true, resourceUrl: true } });
      if (!current) return null;
      if (current.body === body && current.resourceUrl === resourceUrl) return { courseId: current.courseId, changed: false };
      // Matched again in the write, so an admin removal or a delete in between is never undone.
      const { count } = await db.advice.updateMany({ where: ownVisible(userId, adviceId), data: { body, resourceUrl, editedAt: new Date() } });
      return count ? { courseId: current.courseId, changed: true } : null;
    });
    if (!outcome) return refuse(userId, "edit", adviceId, "not_found");
    if (outcome.changed) {
      invalidateCourseAdvice(outcome.courseId);
      logError("advice_edited", { adviceId, courseId: outcome.courseId, userId });
    }
    return { ok: true, ...outcome };
  } catch (error) {
    logError("advice_change_failed", { adviceId, operation: "edit", userId, errorType: errorType(error) });
    return { ok: false, error: "unexpected" };
  }
}

// Takes the author's advice out of every list. It is kept, marked REMOVED by its author, so a report about it (US-43)
// can still be checked by an admin; no student sees it again.
export async function deleteAdvice(userId: string, adviceIdInput: string): Promise<AdviceChangeOutcome> {
  const adviceId = adviceIdInput.trim();
  if (!allowChange(userId, "delete")) return { ok: false, error: "rate_limited" };
  if (!adviceId) return refuse(userId, "delete", adviceId, "not_found");
  try {
    const courseId = await timed("advice_delete", { adviceId, userId }, async () => {
      const current = await db.advice.findFirst({ where: ownVisible(userId, adviceId), select: { courseId: true } });
      if (!current) return null;
      const { count } = await db.advice.updateMany({
        where: ownVisible(userId, adviceId), data: { status: AdviceStatus.REMOVED, removedAt: new Date(), removedById: userId },
      });
      return count ? current.courseId : null;
    });
    if (!courseId) return refuse(userId, "delete", adviceId, "not_found");
    invalidateCourseAdvice(courseId);
    logError("advice_deleted", { adviceId, courseId, userId });
    return { ok: true, courseId, changed: true };
  } catch (error) {
    logError("advice_change_failed", { adviceId, operation: "delete", userId, errorType: errorType(error) });
    return { ok: false, error: "unexpected" };
  }
}
