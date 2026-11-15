import { AdviceDiscussion, type DiscussionView } from "@/components/advice-discussion";
import { AdviceHelpful, type HelpfulView } from "@/components/advice-helpful";
import type { PublicAdvice } from "@/lib/advice";
import { SCOPE_LABELS } from "@/lib/advice-rules";
import { SourceLabel } from "@/components/source-label";

// Shows advice exactly as students may see it: PublicAdvice has no author ID, and an anonymous post has no author name.
// `helpful` (US-40) adds each post's helpful count and mark button; `discussion` (US-41) adds its replies and reply form.
export function AdviceList({ items, emptyMessage, helpful, discussion }: { items: PublicAdvice[]; emptyMessage: string; helpful?: HelpfulView; discussion?: DiscussionView }) {
  if (!items.length) return <p className="muted">{emptyMessage}</p>;
  return <>{items.map(advice => <article key={advice.id} className="card">
    <SourceLabel kind="opinion" withNote={false} />
    <h3>{advice.title}</h3>
    <p className="muted">
      {advice.scope.kind === "COURSE" ? SCOPE_LABELS.COURSE : `${SCOPE_LABELS[advice.scope.kind]}: ${advice.scope.label}`}
      {" · "}{advice.authorLabel}{" · "}<time dateTime={advice.createdAt.toISOString()}>{advice.createdAt.toISOString().slice(0, 10)}</time>
    </p>
    <p style={{ whiteSpace: "pre-wrap" }}>{advice.body}</p>
    {/* Defense in depth: the link was checked when it was saved, and only an https link is ever rendered. */}
    {advice.resourceUrl?.startsWith("https://") && <p><a href={advice.resourceUrl} target="_blank" rel="noopener noreferrer nofollow">{advice.resourceTitle || advice.resourceUrl}</a> <span className="muted">(external link)</span></p>}
    {helpful && <AdviceHelpful adviceId={advice.id} isMine={advice.isMine} view={helpful} />}
    {discussion && <AdviceDiscussion advice={advice} view={discussion} />}
  </article>)}</>;
}
