import { KIND_LABELS } from "@/lib/question-correction-rules";
import type { CorrectionLogEntry } from "@/lib/question-corrections";

const date = (value: Date) => `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;

function Change({ entry }: { entry: CorrectionLogEntry }) {
  if (entry.kind === "EDIT_TEXT") return <>From “{entry.before}” to “{entry.after}”</>;
  if (entry.kind === "MOVE") return <>From the group “{entry.before ?? "no group"}” to “{entry.after}”</>;
  return <>Left the group “{entry.before ?? "no group"}”</>;
}

// The activity log of question corrections, newest first.
export function CorrectionLog({ entries, label }: { entries: CorrectionLogEntry[]; label: string }) {
  if (!entries.length) return <p className="card muted">No corrections yet.</p>;
  return <table className="log-table" aria-label={label}>
    <thead><tr><th>When</th><th>Admin</th><th>Question</th><th>Correction</th></tr></thead>
    <tbody>{entries.map(entry => <tr key={entry.id}>
      <td>{date(entry.createdAt)}</td>
      <td>{entry.admin?.name ?? "A deleted account"}</td>
      <td>{entry.paperTitle}, question {entry.questionNumber}</td>
      <td><strong>{KIND_LABELS[entry.kind]}</strong><div className="log-details"><Change entry={entry} /></div></td>
    </tr>)}</tbody>
  </table>;
}

// Shows how a question was corrected, next to the question.
export function CorrectionTags({ question }: { question: { textCorrectedAt: Date | null; pinnedToQuestionId: string | null; splitOut: boolean } }) {
  const tags = [
    question.textCorrectedAt && "Text corrected",
    question.pinnedToQuestionId && "Moved by an admin",
    question.splitOut && "Split by an admin",
  ].filter((tag): tag is string => Boolean(tag));
  return <>{tags.map(tag => <span className="status-tag status-pending" key={tag}>{tag}</span>)}</>;
}
