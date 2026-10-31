import { logError } from "@/lib/logger";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";
import { countPendingSubmissions, listPendingSubmissions, publishSubmission, rejectSubmission } from "@/lib/submissions";
import type { ReviewRefusal } from "@/lib/submission-review-rules";
import { timed } from "@/lib/timing";

// The admin review page (US-74), on top of the review functions in lib/submissions.ts (US-13).
// This layer adds what the page needs around them: pages of the queue, a per-admin rate limit, response times in the log,
// and a record of which admin reviewed what. Nothing here checks the caller: the page and actions call requireAdmin() first.

// Shown one page at a time: rendering every pending submission with its forms made the page slow under load.
export const REVIEW_PAGE_SIZE = 20;
// Reviews per admin per minute. Far above what a person clicks, so it only stops a script or a stolen session (DoS protection).
export const REVIEW_WINDOW_MS = 60_000;
export const reviewLimit = () => limitFromEnv("REVIEW_RATE_LIMIT_PER_MINUTE", 60);

// Oldest first. An invalid or out-of-range page falls back to the first or last page, like the course catalog.
export const getReviewQueue = (requestedPage = 1) => timed("review_queue", {}, async () => {
  const total = await countPendingSubmissions();
  const totalPages = Math.max(1, Math.ceil(total / REVIEW_PAGE_SIZE));
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, totalPages) : 1;
  const items = total ? await listPendingSubmissions({ skip: (page - 1) * REVIEW_PAGE_SIZE, take: REVIEW_PAGE_SIZE }) : [];
  return { items, total, page, totalPages };
});

export type ReviewOutcome = { ok: true } | { ok: false; error: ReviewRefusal };

// trim() keeps invisible characters such as zero-width spaces, so a reason made only of them would show the student
// an empty "Reason:". These are removed before checking that something readable is left: whitespace, format characters
// (zero-width spaces and joiners, byte order marks), and the blank fillers that count as letters or symbols.
const BLANK_FILLERS = String.fromCodePoint(0x115f, 0x1160, 0x3164, 0xffa0, 0x2800);
const INVISIBLE = new RegExp(String.raw`[\p{White_Space}\p{Cf}${BLANK_FILLERS}]`, "gu");
export const readable = (reason: string) => reason.replace(INVISIBLE, "").length > 0;

// Publishes or rejects one submission for an admin. The reason is passed on to rejectSubmission and never logged.
export async function reviewSubmission(adminId: string, operation: "publish" | "reject", fileId: string, reason = ""): Promise<ReviewOutcome> {
  const limit = checkRateLimit(`review:${adminId}`, reviewLimit(), REVIEW_WINDOW_MS);
  if (!limit.ok) {
    logError("submission_review_rate_limited", { userId: adminId, operation, retryAfterSeconds: String(limit.retryAfterSeconds) });
    return { ok: false, error: "rate_limited" };
  }
  if (operation === "reject" && !readable(reason)) {
    logError("submission_review_refused", { fileId: fileId || undefined, operation, reason: "reason_required", userId: adminId });
    return { ok: false, error: "reason_required" };
  }
  const result = await timed(`submission_${operation}`, { fileId, userId: adminId }, () =>
    operation === "publish" ? publishSubmission(fileId) : rejectSubmission(fileId, reason));
  if (!result.ok) {
    logError("submission_review_refused", { fileId: fileId || undefined, operation, reason: result.error, userId: adminId });
    return result;
  }
  logError("submission_reviewed", { fileId: result.id, courseId: result.courseId, operation, userId: adminId });
  return { ok: true };
}
