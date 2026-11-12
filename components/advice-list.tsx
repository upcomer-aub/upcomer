import Link from "next/link";
import type { AdviceItem } from "@/lib/advice";
import { adviceDate, SCOPE_PREFIX } from "@/lib/advice-rules";
import styles from "./advice-list.module.css";

// One course's advice from previous students (US-38), newest first. Every item is labelled as student advice, so it is
// never mistaken for the exam statistics of the Upcomer Exam. The author line comes ready from lib/advice.ts: an
// anonymous author's name never reaches this component.

function About({ courseId, item }: { courseId: string; item: AdviceItem }) {
  const { about } = item;
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

export function AdviceList({ courseId, items }: { courseId: string; items: AdviceItem[] }) {
  return <ol className={`list ${styles.feed}`} aria-label="Advice from previous students">
    {items.map(item => <li key={item.id}>
      <article className={`card ${styles.advice}`} aria-labelledby={`advice-${item.id}-about`}>
        <p className="eyebrow">Student advice</p>
        <p className={styles.about} id={`advice-${item.id}-about`}><About courseId={courseId} item={item} /></p>
        <p className={styles.body}>{item.body}</p>
        {item.resourceUrl && <p className={styles.resource}>
          Resource: <a href={item.resourceUrl} target="_blank" rel="noopener noreferrer nofollow">{item.resourceUrl}</a>
        </p>}
        <p className="muted">
          By {item.author} · <time dateTime={item.createdAt.toISOString()}>{adviceDate(item.createdAt)}</time>{item.edited && " · edited"}
        </p>
      </article>
    </li>)}
  </ol>;
}
