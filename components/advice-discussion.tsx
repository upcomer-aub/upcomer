import Link from "next/link";
import type { PublicAdvice } from "@/lib/advice";
import { addAdviceCommentAction, deleteAdviceCommentAction } from "@/lib/advice-comment-actions";
import { ADVICE_COMMENT_MAX_LENGTH } from "@/lib/advice-comment-rules";
import type { PublicComment } from "@/lib/advice-comments";
import styles from "./advice-discussion.module.css";

export type DiscussionView = {
  courseId: string;
  threads: ReadonlyMap<string, PublicComment[]>;
  // The advice page's current query, so a reply comes back to the same view.
  returnTo: string;
  loggedIn: boolean;
  // The post whose thread was just used; it opens again after the redirect.
  openThread?: string;
};

const when = (date: Date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

// The discussion beneath one piece of advice (US-41): its replies, oldest first, each with who wrote it (the post's author is
// marked "(author)", and stays anonymous on an anonymous post), a Delete button for the reply's author or an admin, and a
// plain POST form to reply. A visitor sees the replies and a link to log in.
export function AdviceDiscussion({ advice, view }: { advice: PublicAdvice; view: DiscussionView }) {
  const replies = view.threads.get(advice.id) ?? [];
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const shownAs = advice.isMine
    ? (advice.isAnonymous ? "Your reply is shown as Anonymous student (author)." : "Your reply is shown with your name, marked (author).")
    : "Your reply is shown with your name.";
  const next = `/courses/${view.courseId}/advice${view.returnTo ? `?${view.returnTo}` : ""}`;
  return <details className={styles.discussion} open={view.openThread === advice.id} id={`discussion-${advice.id}`}>
    <summary>Discussion ({replies.length} {replies.length === 1 ? "reply" : "replies"})</summary>
    {replies.length === 0
      ? <p className="muted">No replies yet.</p>
      : <ol className={styles.replies} aria-label={`Replies to ${advice.title}`}>{replies.map(reply => <li key={reply.id} className={styles.reply}>
        <p className={styles.meta}><strong>{reply.authorLabel}</strong> <span className="muted">· <time dateTime={reply.createdAt.toISOString()}>{when(reply.createdAt)}</time></span></p>
        <p className={styles.body}>{reply.body}</p>
        {reply.canDelete && <form className="inline-form" action={deleteAdviceCommentAction}>
          {hidden("courseId", view.courseId)}{hidden("adviceId", advice.id)}{hidden("commentId", reply.id)}{hidden("returnTo", view.returnTo)}
          <button className={styles.delete} type="submit">{reply.isMine ? "Delete my reply" : "Delete reply"}</button>
        </form>}
      </li>)}</ol>}
    {view.loggedIn
      ? <form className={`form ${styles.form}`} action={addAdviceCommentAction}>
        {hidden("courseId", view.courseId)}{hidden("adviceId", advice.id)}{hidden("returnTo", view.returnTo)}
        <label className="field">Your reply
          <textarea name="body" required maxLength={ADVICE_COMMENT_MAX_LENGTH} rows={3} />
        </label>
        <p className="muted">{shownAs}</p>
        <button className="button" type="submit">Post reply</button>
      </form>
      : <p><Link href={`/login?next=${encodeURIComponent(next)}`}>Log in to reply</Link></p>}
  </details>;
}
