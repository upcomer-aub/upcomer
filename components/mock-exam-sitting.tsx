import { saveMockExamAction, startMockExamAction } from "@/app/courses/[courseId]/mock-exams/actions";
import { MockExamTimer } from "@/components/mock-exam-timer";
import type { MockExamView } from "@/lib/mock-exams";
import { MOCK_ANSWER_MAX_LENGTH } from "@/lib/mock-exam-rules";
import { timeLimitLabel } from "@/lib/mock-exam-timing";
import { OUTCOME_LABELS } from "@/lib/mock-marking-rules";
import styles from "./mock-exam-sitting.module.css";

// The sitting flow: every question with a box for the answer. "Save progress" keeps the answers (they are still there after a
// refresh); "Submit exam" locks them. After submitting the answers are shown read-only.
// A past-paper question shows how often it appeared and in which papers. A generated practice question (US-44) appeared in
// no paper (paperCount 0), so it says which paper it is based on instead.
// A timed exam (US-48) first shows a start page without any question: getMockExam leaves the questions out until Start is
// pressed, so they are not in this markup at all. Once started, the countdown sits above the questions; the form itself
// stays a plain form, and the server enforces the deadline with or without JavaScript.
export function MockExamSitting({ exam }: { exam: MockExamView }) {
  if (exam.locked && exam.timeLimitMinutes !== null) return <form className="card" action={startMockExamAction} data-testid="mock-start">
    <input type="hidden" name="courseId" value={exam.courseId} />
    <input type="hidden" name="mockExamId" value={exam.id} />
    <h2>Timed exam: {timeLimitLabel(exam.timeLimitMinutes)}</h2>
    <p>You have {timeLimitLabel(exam.timeLimitMinutes)} for {exam.length} {exam.length === 1 ? "question" : "questions"}. The questions appear when you press Start.</p>
    <p className="muted">The timer starts then and keeps running if you close the page or log out. When it ends, the answers saved by then are submitted automatically and can&apos;t change.</p>
    <button className="button" type="submit">Start exam</button>
  </form>;
  const submitted = exam.status === "SUBMITTED";
  const answered = exam.questions.filter(question => question.answer).length;
  return <form action={saveMockExamAction}>
    <input type="hidden" name="courseId" value={exam.courseId} />
    <input type="hidden" name="mockExamId" value={exam.id} />
    {!submitted && exam.remainingMs !== null && <MockExamTimer remainingMs={exam.remainingMs} examUrl={`/courses/${exam.courseId}/mock-exams/${exam.id}`} />}
    <p className="muted" data-answered>{answered} of {exam.questions.length} {exam.questions.length === 1 ? "answer" : "answers"} saved.</p>
    <ol className="list question-list">{exam.questions.map(question => <li className={`card ${styles.question}`} key={question.id} data-kind={question.paperCount === 0 ? "generated" : "past-paper"}>
      <span className="eyebrow">Question {question.position}{question.topic ? ` · ${question.topic}` : ""}</span>
      <p className={styles.text}>{question.text}</p>
      <p className="muted" data-source>{question.paperCount === 0
        ? `Generated practice question${question.sourcePapers.length ? `, based on ${question.sourcePapers.join(", ")}` : ""}. It did not appear in a past paper.`
        : `Appeared in ${question.paperCount} of ${question.totalPapers} ${question.totalPapers === 1 ? "paper" : "papers"}${question.sourcePapers.length ? `: ${question.sourcePapers.join(", ")}` : ""}`}</p>
      <label className="field"><span>Your answer to question {question.position}</span>
        <textarea name={`answer_${question.id}`} defaultValue={question.answer ?? ""} rows={6} maxLength={MOCK_ANSWER_MAX_LENGTH} readOnly={submitted} />
      </label>
      {/* US-49: the marking against the answer key, once the exam is marked. */}
      {submitted && question.outcome && <div className={styles.marking} data-marking={question.outcome}>
        <p><strong data-outcome>{OUTCOME_LABELS[question.outcome]}</strong></p>
        {question.matchedPoints.length > 0 && <p className="muted">Covered: {question.matchedPoints.map(point => `"${point}"`).join("; ")}</p>}
        {question.feedback && <p className={styles.feedback}>{question.feedback}</p>}
      </div>}
      {/* US-51: a step-by-step walkthrough of a past-paper question, once the exam is submitted (a generated question has none). */}
      {submitted && question.questionId && <p className="muted"><a href={`/courses/${encodeURIComponent(exam.courseId)}/questions/${encodeURIComponent(question.questionId)}/walkthrough`} aria-label={`Step-by-step walkthrough of question ${question.position}`}>Step-by-step walkthrough</a> (AI-generated)</p>}
    </li>)}</ol>
    {submitted
      ? <p className="muted">{exam.timedOut ? "Time ran out, so the answers saved by then were submitted. They are locked." : "Submitted. Your answers are locked."}{exam.markedAt && " Each answer is marked only against the key points an admin wrote for the question; a question without a key is not marked."}</p>
      : <div className={styles.actions}>
        <button className="button" type="submit" name="intent" value="save">Save progress</button>
        <button className="button" type="submit" name="intent" value="submit">Submit exam</button>
        <p className="muted">Submitting saves your answers and locks them. You can&apos;t change them afterwards.</p>
      </div>}
  </form>;
}
