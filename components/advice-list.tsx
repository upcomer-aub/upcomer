import Link from "next/link";
import type { FeedItem } from "@/lib/advice";
import { adviceDate, ANONYMOUS_AUTHOR, SCOPE_PREFIX, type AdviceAbout as About } from "@/lib/advice-rules";
import styles from "./advice-list.module.css";

// One course's advice from previous students (US-38), newest first. Every item is labelled as student advice, so it is
// never mistaken for the exam statistics of the Upcomer Exam. The author line comes ready from lib/advice.ts: an
// anonymous author's name never reaches this component. The viewer's own advice (US-36) is marked as theirs, with a link
// to edit or delete it; only they see that.

// What one advice is about, for the feed and the edit page.
export function AdviceAbout({ courseId, about }: { courseId: string; about: About }) {
  switch (about.scope) {
    case "COURSE":
      return <>{SCOPE_PREFIX.COURSE}{about.targetGone && <span className="muted"> (what it was about is no longer available)</span>}</>;
    case "EXAM":
      return <>{SCOPE_PREFIX.EXAM}: <Link href={`/files/${encodeURIComponent(about.fileId)}`}>{about.label}</Link></>;
    case "QUESTION":
      return <>{SCOPE_PREFIX.QUESTION}: <Link href={`/courses/${encodeURIComponent(courseId)}/exam`}>{about.label}</Link></>;
    default:
      return <>{SCOPE_PREFIX[about.scope]}: {about.label}</>;
  }
}

export function AdviceList({ courseId, items, page = 1 }: { courseId: string; items: FeedItem[]; page?: number }) {
  return <ol className={`list ${styles.feed}`} aria-label="Advice from previous students">
    {items.map(item => <li key={item.id}>
      <article className={`card ${styles.advice}`} id={`advice-${item.id}`} aria-labelledby={`advice-${item.id}-about`}>
        <p className="eyebrow">Student advice{item.mine && <span className={styles.mine}> · Your advice</span>}</p>
        <p className={styles.about} id={`advice-${item.id}-about`}><AdviceAbout courseId={courseId} about={item.about} /></p>
        <p className={styles.body}>{item.body}</p>
        {item.resourceUrl && <p className={styles.resource}>
          Resource: <a href={item.resourceUrl} target="_blank" rel="noopener noreferrer nofollow">{item.resourceUrl}</a>
        </p>}
        <p className="muted">
          By {item.author} · <time dateTime={item.createdAt.toISOString()}>{adviceDate(item.createdAt)}</time>{item.edited && " · edited"}
        </p>
        {item.mine && <p className={styles.own}>
          {item.anonymous && <span className="muted">Others see you as {ANONYMOUS_AUTHOR}. </span>}
          <Link href={`/courses/${encodeURIComponent(courseId)}/advice/${encodeURIComponent(item.id)}/edit${page > 1 ? `?page=${page}` : ""}`}>Edit or delete</Link>
        </p>}
      </article>
    </li>)}
  </ol>;
}
