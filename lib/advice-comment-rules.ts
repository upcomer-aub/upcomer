import { ANONYMOUS_AUTHOR_LABEL, FORMER_STUDENT_LABEL } from "@/lib/advice-rules";

// US-41: replies beneath advice. Pure rules shared by the service, the action, and the page.

export const ADVICE_COMMENT_MAX_LENGTH = 1000;

export type CommentRefusal = "body_required" | "body_too_long" | "not_found" | "forbidden" | "rate_limited" | "unexpected";

const MESSAGES: Record<CommentRefusal, string> = {
  body_required: "Write a reply before sending it.",
  body_too_long: `A reply can be at most ${ADVICE_COMMENT_MAX_LENGTH} characters.`,
  not_found: "That advice or reply is no longer available.",
  forbidden: "You can only delete your own replies.",
  rate_limited: "Too many replies in a minute. Please wait a moment and try again.",
  unexpected: "Your reply could not be saved. Please try again.",
};
export const commentMessage = (error: string) => (Object.hasOwn(MESSAGES, error) ? MESSAGES[error as CommentRefusal] : MESSAGES.unexpected);

export const POST_AUTHOR_SUFFIX = " (author)";

// Who a reply is shown as. The post's own author is marked "(author)"; on an anonymous post that is "Anonymous student
// (author)", so the name never appears. Everyone else replies under their name (no anonymous replies, as agreed for
// US-41). A deleted account is "Former student". A missing author ID never counts as the post's author.
export function commentAuthorLabel(input: { commentAuthorId: string | null; authorName: string | null; postAuthorId: string | null; postAnonymous: boolean }) {
  const byPostAuthor = input.commentAuthorId !== null && input.commentAuthorId === input.postAuthorId;
  if (input.commentAuthorId === null || input.authorName === null) return { label: FORMER_STUDENT_LABEL, byPostAuthor: false };
  if (!byPostAuthor) return { label: input.authorName, byPostAuthor };
  return { label: `${input.postAnonymous ? ANONYMOUS_AUTHOR_LABEL : input.authorName}${POST_AUTHOR_SUFFIX}`, byPostAuthor };
}
