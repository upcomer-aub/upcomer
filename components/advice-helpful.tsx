import Link from "next/link";
import { HELPFUL, helpfulLabel, NOT_HELPFUL } from "@/lib/advice-vote-rules";
import { setAdviceHelpfulAction } from "@/lib/advice-vote-actions";
import type { HelpfulCount } from "@/lib/advice-votes";

export type HelpfulView = {
  courseId: string;
  counts: ReadonlyMap<string, HelpfulCount>;
  // The advice page's current query (search, filters, sort, page), so a vote comes back to the same view.
  returnTo: string;
  loggedIn: boolean;
};

// The helpful count of one piece of advice, and a plain POST form to mark it helpful or undo the mark (US-40). An author
// sees the count of their own advice but no button; a visitor sees the count and a link to log in. Only the count is
// ever shown, never who marked it.
export function AdviceHelpful({ adviceId, isMine, view }: { adviceId: string; isMine: boolean; view: HelpfulView }) {
  const { count, mine } = view.counts.get(adviceId) ?? { count: 0, mine: false };
  const label = <span className="muted">{helpfulLabel(count)}</span>;
  if (!view.loggedIn) {
    const next = `/courses/${view.courseId}/advice${view.returnTo ? `?${view.returnTo}` : ""}`;
    return <p>{label} · <Link href={`/login?next=${encodeURIComponent(next)}`}>Log in to mark it helpful</Link></p>;
  }
  if (isMine) return <p>{label} · <span className="muted">Your advice</span></p>;
  return <form className="inline-form" action={setAdviceHelpfulAction}>
    <input type="hidden" name="courseId" value={view.courseId} />
    <input type="hidden" name="adviceId" value={adviceId} />
    <input type="hidden" name="returnTo" value={view.returnTo} />
    <input type="hidden" name="helpful" value={mine ? NOT_HELPFUL : HELPFUL} />
    {label}{" "}
    <button className="button" type="submit" aria-pressed={mine}>{mine ? "Undo helpful" : "Mark as helpful"}</button>
  </form>;
}
