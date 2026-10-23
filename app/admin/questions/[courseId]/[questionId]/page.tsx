import Link from "next/link";
import { notFound } from "next/navigation";
import { CorrectionLog, CorrectionTags } from "@/components/correction-log";
import { requireAdmin } from "@/lib/auth";
import { editQuestionTextAction, moveQuestionAction, resetQuestionGroupAction, splitQuestionAction } from "@/lib/question-correction-actions";
import { correctionMessage, MAX_QUESTION_TEXT_LENGTH, REGROUP_FAILED_MESSAGE, savedMessage } from "@/lib/question-correction-rules";
import { getQuestionCorrection } from "@/lib/question-corrections";

export const dynamic = "force-dynamic";

const short = (text: string, length = 90) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

function Notice({ saved, regroup, error }: { saved?: string; regroup?: string; error?: string }) {
  if (error) return <p className="notice error" role="alert">{correctionMessage(error)}</p>;
  const message = saved && savedMessage(saved);
  if (!message) return null;
  return <><p className="notice" role="status">{message}</p>{regroup === "failed" && <p className="notice error" role="alert">{REGROUP_FAILED_MESSAGE}</p>}</>;
}

// Question corrections for one question: edit its text, move it to another group, split it out, or undo a move or split.
export default async function QuestionCorrectionPage({ params, searchParams }: {
  params: Promise<{ courseId: string; questionId: string }>; searchParams: Promise<{ saved?: string; regroup?: string; error?: string }>;
}) {
  const [{ courseId, questionId }, notice] = await Promise.all([params, searchParams]);
  const courseRoute = `/admin/questions/${encodeURIComponent(courseId)}`;
  await requireAdmin(`${courseRoute}/${encodeURIComponent(questionId)}`);
  const view = await getQuestionCorrection(courseId, questionId);
  if (!view) notFound();
  const { course, question, groups, history } = view;
  const label = `${question.file.title}, question ${question.number}`;
  const hidden = <><input type="hidden" name="courseId" value={course.id} /><input type="hidden" name="questionId" value={question.id} /></>;
  const otherGroups = groups.filter(group => group.id !== question.group?.id);
  return <><Link className="back" href={courseRoute}>← Back to {course.code} questions</Link>
    <span className="eyebrow">Admin · {course.code}</span><h1>Correct a Question</h1>
    <p className="muted">{label} <CorrectionTags question={question} /></p>
    <Notice {...notice} />
    <section className="card" aria-label="Current group">
      <h2>Group</h2>
      {question.group ? <p>#{question.group.rank} “{question.group.text}”, in {question.group.paperCount} {question.group.paperCount === 1 ? "paper" : "papers"}.</p>
        : <p className="muted">Not in any group: no text is left once its number is removed.</p>}
    </section>
    <form className="card form" action={editQuestionTextAction}>
      {hidden}
      <input type="hidden" name="previousText" value={question.text} />
      <label className="field">Question text
        <textarea name="text" required maxLength={MAX_QUESTION_TEXT_LENGTH} rows={6} defaultValue={question.text} />
      </label>
      <button className="button" type="submit">Save text</button>
    </form>
    {otherGroups.length > 0 && <form className="card form" action={moveQuestionAction}>
      {hidden}
      <label className="field">Move to group
        <select name="groupId" required defaultValue="">
          <option value="" disabled>Choose a group</option>
          {otherGroups.map(group => <option key={group.id} value={group.id}>#{group.rank} {short(group.text)}</option>)}
        </select>
      </label>
      <button className="button" type="submit">Move question</button>
    </form>}
    <section className="card" aria-label="Group corrections">
      {!question.splitOut && <form action={splitQuestionAction}>{hidden}
        <p className="muted">Split it out if it is a different question from the others in its group.</p>
        <button className="button" type="submit">Split into its own group</button>
      </form>}
      {(question.splitOut || question.pinnedToQuestionId) && <form action={resetQuestionGroupAction}>{hidden}
        <p className="muted">Undo the move or split, so the question is grouped by its text again.</p>
        <button className="button" type="submit">Group by text again</button>
      </form>}
    </section>
    <h2>Corrections to this question</h2>
    <CorrectionLog entries={history} label={`Corrections to ${label}`} />
  </>;
}
