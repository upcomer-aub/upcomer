import type { ReactNode } from "react";
import styles from "./source-label.module.css";

// US-42: tells students where what they are reading comes from. "Student opinion" is advice from previous students
// (US-34 and later); "Historical exam data" is what was counted from published past exam papers (question bank, Upcomer
// Exam). The two never mix: advice is not read by any ranking or count. The difference is in the words and the tag's
// outline (solid or dashed), never in color alone. US-51 adds "AI-generated" (a dotted outline) for walkthroughs written by
// an AI model from a past-exam question.

export type SourceKind = "opinion" | "statistics" | "ai";

export const SOURCE_LABELS: Record<SourceKind, { tag: string; note: string }> = {
  opinion: {
    tag: "Student opinion",
    note: "Personal experience of previous students, not exam data; it never changes the question rankings or counts.",
  },
  statistics: {
    tag: "Historical exam data",
    note: "Counted from published past exam papers only; student advice never changes these rankings or counts.",
  },
  ai: {
    tag: "AI-generated",
    note: "Written by an AI model from the question alone. It may contain mistakes and is not an official answer; check it against your course material.",
  },
};

// The tag alone (for each advice post), or the tag with its explanation (for a page or a section). `children` follows the
// explanation in the same paragraph (for example a link to the other kind), so the label adds one line to a page header.
export function SourceLabel({ kind, withNote = true, children }: { kind: SourceKind; withNote?: boolean; children?: ReactNode }) {
  const { tag, note } = SOURCE_LABELS[kind];
  const badge = <span className={`${styles.tag} ${styles[kind]}`} data-source={kind}>{tag}</span>;
  if (!withNote) return badge;
  return <p className={styles.label}>{badge} <span className="muted">{note}{children && <> {children}</>}</span></p>;
}
