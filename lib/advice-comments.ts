import { AdviceStatus, Role } from "@prisma/client";
import { ADVICE_COMMENT_MAX_LENGTH, commentAuthorLabel, type CommentRefusal } from "@/lib/advice-comment-rules";
import { cleanAdviceBody } from "@/lib/advice-rules";
import { db } from "@/lib/db";
import { errorCode, logError } from "@/lib/logger";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";
import { hasReadableText } from "@/lib/readable-text";

// US-41: replies beneath advice. A reply always belongs to one visible advice of one course; the advice page only lists
// visible advice, and every read and write here also checks it, so a removed post's thread is hidden and cannot grow.
// Nothing here checks the session: the actions call requireUser() first and pass the session user. Reply text is never
// logged; students never receive an author ID (see PublicComment).

// Replies per student per minute. Far above what a person types, so it only stops a script or a stolen session.
export const ADVICE_COMMENT_WINDOW_MS = 60_000;
export const adviceCommentLimit = () => limitFromEnv("ADVICE_COMMENT_RATE_LIMIT_PER_MINUTE", 10);

export type CommentActor = { id: string; role: Role };

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");
const short = (value: string) => value.slice(0, 100) || undefined;

export type AddCommentResult = { ok: true; id: string } | { ok: false; error: CommentRefusal };

// Adds the session student's reply beneath visible advice of the course. The text is trimmed (line breaks kept) and must have
// something readable in it.
export async function addAdviceComment(userId: string, courseId: string, adviceId: string, rawBody: string): Promise<AddCommentResult> {
  const context = { userId, courseId: short(courseId), adviceId: short(adviceId) };
  const refuse = (error: CommentRefusal): AddCommentResult => {
    logError("advice_comment_refused", { ...context, reason: error });
    return { ok: false, error };
  };
  const body = cleanAdviceBody(rawBody);
  if (!hasReadableText(body)) return refuse("body_required");
  if (body.length > ADVICE_COMMENT_MAX_LENGTH) return refuse("body_too_long");
  const limit = checkRateLimit(`advice-comment:${userId}`, adviceCommentLimit(), ADVICE_COMMENT_WINDOW_MS);
  if (!limit.ok) {
    logError("advice_comment_rate_limited", { ...context, retryAfterSeconds: String(limit.retryAfterSeconds) });
    return { ok: false, error: "rate_limited" };
  }
  try {
    const advice = adviceId && courseId
      ? await db.advice.findFirst({ where: { id: adviceId, courseId, status: AdviceStatus.VISIBLE }, select: { id: true } })
      : null;
    if (!advice) return refuse("not_found");
    const created = await db.adviceComment.create({ data: { adviceId, authorId: userId, body }, select: { id: true } });
    logError("advice_comment_saved", { ...context, commentId: created.id });
    return { ok: true, id: created.id };
  } catch (error) {
    // P2003: the advice (or the account) was deleted between the check and the save.
    if (errorCode(error) === "P2003") return refuse("not_found");
    logError("advice_comment_failed", { ...context, operation: "add", errorType: errorType(error), errorCode: errorCode(error) });
    return { ok: false, error: "unexpected" };
  }
}

export type DeleteCommentResult = { ok: true; adviceId: string } | { ok: false; error: CommentRefusal };

// Deletes one reply of the course. Only its author or an admin may; anyone else is refused ("forbidden") and nothing changes.
// The delete itself repeats the condition, so a reply cannot be deleted by someone else between the check and the write.
export async function deleteAdviceComment(actor: CommentActor, courseId: string, commentId: string): Promise<DeleteCommentResult> {
  const isAdmin = actor.role === "ADMIN";
  const context = { userId: actor.id, courseId: short(courseId), commentId: short(commentId), byAdmin: String(isAdmin) };
  const refuse = (error: CommentRefusal): DeleteCommentResult => {
    logError("advice_comment_delete_refused", { ...context, reason: error });
    return { ok: false, error };
  };
  try {
    const comment = commentId && courseId
      ? await db.adviceComment.findFirst({ where: { id: commentId, advice: { courseId } }, select: { authorId: true, adviceId: true } })
      : null;
    if (!comment) return refuse("not_found");
    if (!isAdmin && comment.authorId !== actor.id) return refuse("forbidden");
    const { count } = await db.adviceComment.deleteMany({ where: { id: commentId, ...(isAdmin ? {} : { authorId: actor.id }) } });
    if (!count) return refuse("not_found");
    logError("advice_comment_deleted", { ...context, adviceId: comment.adviceId });
    return { ok: true, adviceId: comment.adviceId };
  } catch (error) {
    logError("advice_comment_failed", { ...context, operation: "delete", errorType: errorType(error), errorCode: errorCode(error) });
    return { ok: false, error: "unexpected" };
  }
}

// What students see of a reply: no author ID. `isMine` and `canDelete` are only about the viewer.
export type PublicComment = { id: string; body: string; createdAt: Date; authorLabel: string; byPostAuthor: boolean; isMine: boolean; canDelete: boolean };

// The replies beneath each given advice, oldest first (ties by ID), for visible advice of the course only. Advice without
// replies gets an empty list. Throws on a failed read, after logging it.
export async function getAdviceComments(courseId: string, adviceIds: string[], viewer: CommentActor | null): Promise<Map<string, PublicComment[]>> {
  const threads = new Map<string, PublicComment[]>(adviceIds.map(id => [id, []]));
  if (!adviceIds.length) return threads;
  try {
    const rows = await db.adviceComment.findMany({
      where: { adviceId: { in: adviceIds }, advice: { courseId, status: AdviceStatus.VISIBLE } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, adviceId: true, authorId: true, body: true, createdAt: true, author: { select: { name: true } }, advice: { select: { authorId: true, isAnonymous: true } } },
    });
    for (const row of rows) {
      const { label, byPostAuthor } = commentAuthorLabel({
        commentAuthorId: row.authorId, authorName: row.author?.name ?? null, postAuthorId: row.advice.authorId, postAnonymous: row.advice.isAnonymous,
      });
      const isMine = viewer !== null && row.authorId === viewer.id;
      threads.get(row.adviceId)?.push({ id: row.id, body: row.body, createdAt: row.createdAt, authorLabel: label, byPostAuthor, isMine, canDelete: isMine || viewer?.role === "ADMIN" });
    }
    return threads;
  } catch (error) {
    logError("advice_comment_retrieval_failed", { userId: viewer?.id, courseId: short(courseId), errorType: errorType(error), errorCode: errorCode(error) });
    throw error;
  }
}
