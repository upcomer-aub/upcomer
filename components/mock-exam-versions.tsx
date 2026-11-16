import Link from "next/link";
import { createAlternativeMockExamAction } from "@/lib/mock-exam-version-actions";
import type { MockExamVersions } from "@/lib/mock-exam-versions";
import styles from "./mock-exam-versions.module.css";

// US-46: the versions of a mock exam (links, this one marked) and a plain POST form to make the next one. Shown on the
// exam page whether the exam is in progress or submitted.
export function MockExamVersionsSection({ courseId, mockExamId, family }: { courseId: string; mockExamId: string; family: MockExamVersions }) {
  return <section className={styles.versions} aria-labelledby="versions-heading">
    <h2 id="versions-heading">Versions</h2>
    {family.versions.length > 1 && <ol className={styles.list}>{family.versions.map(item => <li key={item.id}>
      {item.id === mockExamId
        ? <strong aria-current="page">Version {item.version} (this one)</strong>
        : <Link href={`/courses/${courseId}/mock-exams/${item.id}`}>Version {item.version}</Link>}
      <span className="muted"> · {item.status === "SUBMITTED" ? "submitted" : "in progress"}</span>
    </li>)}</ol>}
    <p className="muted">An alternative version has the same topics, length and difficulty, with questions that are not in this exam or any of its earlier versions.</p>
    <form className="inline-form" action={createAlternativeMockExamAction}>
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="mockExamId" value={mockExamId} />
      <button className="button" type="submit">Make an alternative version</button>
    </form>
  </section>;
}
