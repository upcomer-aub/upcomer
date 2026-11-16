import { AdviceStatus } from "@prisma/client";
import { invalidateCourseAdvice, visibleCourseAdvice } from "@/lib/advice";
import {
  ADVICE_BODY_MAX_LENGTH, ADVICE_LINK_TITLE_MAX_LENGTH, ADVICE_TITLE_MAX_LENGTH, cleanAdviceBody, collapseSpaces, parseResourceLink, SCOPE_LABELS,
} from "@/lib/advice-rules";
import { db } from "@/lib/db";
import { logError } from "@/lib/logger";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";
import { hasReadableText } from "@/lib/readable-text";
import { timed } from "@/lib/timing";

// An author edits or deletes their own advice (US-36). Only the author can: every read and write here matches the advice
// by its ID and the caller's user ID together, so another student's advice is "not found", the same as advice that does
// not exist (nobody learns who wrote an anonymous post by trying). Removed advice (deleted, or removed by an admin, US-77)
// cannot be edited back into the feed. After each change the course's feed cache is invalidated, so the change shows at
// once. Editing changes the title, text and link, never the scope or the anonymity. Nothing here checks the session: the
// actions and pages call requireUser() first. Advice text is never logged.

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

// DoS protection: edits and deletes per student per minute. Far above what a person does, so it only stops a script or a
// stolen session.
export const ADVICE_CHANGE_WINDOW_MS = 60_000;
export const adviceChangeLimit = () => limitFromEnv("ADVICE_CHANGE_RATE_LIMIT_PER_MINUTE", 20);

export type AdviceChangeError =
  | "title_required" | "title_too_long" | "body_required" | "body_too_long" | "link_invalid" | "link_title_too_long"
  | "not_found" | "rate_limited" | "unexpected";

const CHANGE_MESSAGES: Record<AdviceChangeError, string> = {
  title_required: "Enter a title for your advice.",
  title_too_long: `Keep the title to ${ADVICE_TITLE_MAX_LENGTH} characters or fewer.`,
  body_required: "Write your advice before saving.",
  body_too_long: `Keep your advice to ${ADVICE_BODY_MAX_LENGTH} characters or fewer.`,
  link_invalid: "Enter a full link that starts with https://, or leave it empty to remove the link.",
  link_title_too_long: `Keep the link's name to ${ADVICE_LINK_TITLE_MAX_LENGTH} characters or fewer.`,
  not_found: "That advice isn't yours to change, or it is no longer shown.",
  rate_limited: "Too many changes in a minute. Wait a moment and try again.",
  unexpected: "Your change could not be saved. Please try again.",
};

// Any other value (for example one typed into the URL) gets the general message, never the value itself.
export const adviceChangeMessage = (error: string) =>
  Object.hasOwn(CHANGE_MESSAGES, error) ? CHANGE_MESSAGES[error as AdviceChangeError] : CHANGE_MESSAGES.unexpected;

export type AdviceDraft = { title: string; body: string; resourceUrl: string | null; resourceTitle: string | null };
export type AdviceEditInput = { adviceId: string; title: string; body: string; resourceUrl: string; resourceTitle: string };

// The same rules as publishing (publishAdvice in lib/advice.ts): spacing in the title collapsed, line endings in the text
// made "\n", text made only of spaces or invisible characters counts as empty, and only an https link. An empty link
// removes the link and its name.
export function checkAdviceDraft(input: Omit<AdviceEditInput, "adviceId">): { ok: true; draft: AdviceDraft } | { ok: false; error: AdviceChangeError } {
  const title = collapseSpaces(input.title);
  const body = cleanAdviceBody(input.body);
  const resourceTitle = collapseSpaces(input.resourceTitle);
  if (!hasReadableText(title)) return { ok: false, error: "title_required" };
  if (title.length > ADVICE_TITLE_MAX_LENGTH) return { ok: false, error: "title_too_long" };
  if (!hasReadableText(body)) return { ok: false, error: "body_required" };
  if (body.length > ADVICE_BODY_MAX_LENGTH) return { ok: false, error: "body_too_long" };
  if (resourceTitle.length > ADVICE_LINK_TITLE_MAX_LENGTH) return { ok: false, error: "link_title_too_long" };
  const link = parseResourceLink(input.resourceUrl);
  if (!link.ok) return { ok: false, error: "link_invalid" };
  return { ok: true, draft: { title, body, resourceUrl: link.url, resourceTitle: link.url && resourceTitle ? resourceTitle : null } };
}

export type AdviceChangeOutcome = { ok: true; courseId: string; changed: boolean } | { ok: false; error: AdviceChangeError };

// The author's own advice, in the given course and still shown, for the edit page; null for anyone else's.
export type OwnAdvice = AdviceDraft & { id: string; courseId: string; about: string; isAnonymous: boolean };

export const getOwnAdvice = (userId: string, courseId: string, adviceId: string) => timed("advice_own_read", { adviceId, userId }, async (): Promise<OwnAdvice | null> => {
  if (!adviceId || !courseId) return null;
  const row = await db.advice.findFirst({
    where: { ...visibleCourseAdvice(courseId), id: adviceId, authorId: userId },
    select: { id: true, courseId: true, title: true, body: true, resourceUrl: true, resourceTitle: true, isAnonymous: true, scopeKind: true, scopeLabel: true },
  });
  if (!row) return null;
  const about = row.scopeKind === "COURSE" ? SCOPE_LABELS.COURSE : `${SCOPE_LABELS[row.scopeKind]}: ${row.scopeLabel}`;
  return { id: row.id, courseId: row.courseId, title: row.title, body: row.body, resourceUrl: row.resourceUrl, resourceTitle: row.resourceTitle, isAnonymous: row.isAnonymous, about };
});

// The same match for every change: this advice, by this author, still shown.
const ownVisible = (userId: string, adviceId: string) => ({ id: adviceId, authorId: userId, status: AdviceStatus.VISIBLE });

function allowChange(userId: string, operation: "edit" | "delete") {
  const limit = checkRateLimit(`advice-change:${userId}`, adviceChangeLimit(), ADVICE_CHANGE_WINDOW_MS);
  if (limit.ok) return true;
  logError("advice_change_rate_limited", { userId, operation, retryAfterSeconds: String(limit.retryAfterSeconds) });
  return false;
}

const refuse = (userId: string, operation: "edit" | "delete", adviceId: string, error: AdviceChangeError): AdviceChangeOutcome => {
  logError("advice_change_refused", { adviceId: adviceId.slice(0, 100) || undefined, operation, reason: error, userId });
  return { ok: false, error };
};

// Saves a new title, text and link for the author. Saving the advice unchanged writes nothing and does not mark it edited.
export async function editAdvice(userId: string, input: AdviceEditInput): Promise<AdviceChangeOutcome> {
  const adviceId = input.adviceId.trim();
  if (!allowChange(userId, "edit")) return { ok: false, error: "rate_limited" };
  if (!adviceId) return refuse(userId, "edit", adviceId, "not_found");
  const checked = checkAdviceDraft(input);
  if (!checked.ok) return refuse(userId, "edit", adviceId, checked.error);
  const draft = checked.draft;
  try {
    const outcome = await timed("advice_edit", { adviceId, userId }, async () => {
      const current = await db.advice.findFirst({
        where: ownVisible(userId, adviceId), select: { courseId: true, title: true, body: true, resourceUrl: true, resourceTitle: true },
      });
      if (!current) return null;
      const same = current.title === draft.title && current.body === draft.body && current.resourceUrl === draft.resourceUrl && current.resourceTitle === draft.resourceTitle;
      if (same) return { courseId: current.courseId, changed: false };
      // Matched again in the write, so an admin removal or a delete in between is never undone.
      const { count } = await db.advice.updateMany({ where: ownVisible(userId, adviceId), data: { ...draft, editedAt: new Date() } });
      return count ? { courseId: current.courseId, changed: true } : null;
    });
    if (!outcome) return refuse(userId, "edit", adviceId, "not_found");
    if (outcome.changed) {
      invalidateCourseAdvice(outcome.courseId);
      logError("advice_edited", { adviceId, courseId: outcome.courseId, userId, hasLink: String(Boolean(draft.resourceUrl)) });
    }
    return { ok: true, ...outcome };
  } catch (error) {
    logError("advice_change_failed", { adviceId, operation: "edit", userId, errorType: errorType(error) });
    return { ok: false, error: "unexpected" };
  }
}

// Takes the author's advice out of every list and search. It is kept, marked REMOVED by its author, so a report about it
// (US-43) can still be checked by an admin; no student sees it again.
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
