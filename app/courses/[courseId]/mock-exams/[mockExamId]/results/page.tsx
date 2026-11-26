import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getCourseById } from "@/lib/courses";
import { OUTCOME_LABELS } from "@/lib/mock-marking-rules";
import { allowResultsRead, getMockResults } from "@/lib/mock-results";
import { percent } from "@/lib/mock-results-rules";
import { mockAiFeedbackAvailable } from "@/lib/mock-ai-feedback";
import { mockAiFeedbackMessages } from "@/lib/mock-ai-feedback-rules";
import { generateMockAiFeedbackAction } from "./feedback-action";

export const dynamic = "force-dynamic";

// The results report of one of the student's own marked mock exams (US-50): the score over the marked questions, the
// breakdown by topic, what was missed, and which questions could not be marked for lack of an answer key.
export default async function MockResultsPage({ params, searchParams }: {
  params: Promise<{ courseId: string; mockExamId: string }>;
  searchParams?: Promise<{ aiError?: string; item?: string }>;
}) {
  const { courseId, mockExamId } = await params;
  const examRoute = `/courses/${encodeURIComponent(courseId)}/mock-exams/${encodeURIComponent(mockExamId)}`;
  const user = await requireUser(`${examRoute}/results`);
  const course = await getCourseById(courseId);
  if (!course) notFound();
  if (!allowResultsRead(user.id)) {
    return <><Link className="back" href={examRoute}>← Back to the exam</Link><h1>Mock Exam Results</h1>
      <p className="notice" role="alert">You are opening results too quickly. Wait a minute and try again.</p></>;
  }
  const results = await getMockResults(user.id, mockExamId);
  // Another student's exam, or one of another course, looks the same as one that doesn't exist.
  if (!results.ok && results.error === "not_found") notFound();
  if (results.ok && results.exam.courseId !== courseId) notFound();
  const header = <><Link className="back" href={examRoute}>← Back to the exam</Link><span className="eyebrow">{course.code}</span><h1>Mock Exam Results</h1></>;
  if (!results.ok) {
    return <>{header}<p className="notice" role="status">{results.error === "not_submitted"
      ? "Submit the exam to see your results."
      : "Your results could not be prepared yet. Reload the page to try again."}</p></>;
  }
  const { report } = results;
  const aiAvailable = mockAiFeedbackAvailable();
  const notice = await searchParams;
  const notMarked = report.counts.NO_KEY;
  return <>{header}
    <section className="card" aria-labelledby="score">
      <h2 id="score">Score</h2>
      {report.marked
        ? <p data-score><strong>{report.counts.CORRECT} of {report.marked}</strong> marked {report.marked === 1 ? "question" : "questions"} fully correct · {percent(report.credit)} of the key points covered</p>
        : <p data-score>None of the questions could be marked, because none has an answer key yet.</p>}
      <p className="muted">{OUTCOME_LABELS.CORRECT} {report.counts.CORRECT} · {OUTCOME_LABELS.PARTIAL} {report.counts.PARTIAL} · {OUTCOME_LABELS.INCORRECT} {report.counts.INCORRECT} · {OUTCOME_LABELS.UNANSWERED} {report.counts.UNANSWERED}</p>
      {notMarked > 0 && <p className="muted" data-not-marked>{notMarked} of {report.questions} {report.questions === 1 ? "question" : "questions"} {notMarked === 1 ? "was" : "were"} not marked, because {notMarked === 1 ? "it has" : "they have"} no answer key. {notMarked === 1 ? "It does" : "They do"} not count in the score.</p>}
      <p className="muted">The score reflects how many of the rubric points written or approved by an admin your answers covered.</p>
    </section>
    <section aria-labelledby="topics">
      <h2 id="topics">By topic</h2>
      <p className="muted">Weakest first.</p>
      <table className="log-table" aria-label="Results by topic">
        <thead><tr><th scope="col">Topic</th><th scope="col">Questions</th><th scope="col">Correct</th><th scope="col">Partly</th><th scope="col">Incorrect</th><th scope="col">Not answered</th><th scope="col">Not marked</th><th scope="col">Key points covered</th></tr></thead>
        <tbody>{report.topics.map(topic => <tr key={topic.topic} data-topic={topic.topic}>
          <th scope="row">{topic.topic}</th><td>{topic.questions}</td><td>{topic.counts.CORRECT}</td><td>{topic.counts.PARTIAL}</td><td>{topic.counts.INCORRECT}</td>
          <td>{topic.counts.UNANSWERED}</td><td>{topic.counts.NO_KEY}</td><td>{percent(topic.credit)}</td>
        </tr>)}</tbody>
      </table>
    </section>
    <section aria-labelledby="missed">
      <h2 id="missed">What you missed</h2>
      {report.missed.length ? <ol className="list question-list">{report.missed.map(question => <li className="card" key={question.id} data-missed={question.position}>
        <span className="eyebrow">Question {question.position}{question.topic ? ` · ${question.topic}` : ""} · {OUTCOME_LABELS[question.outcome!]}</span>
        <p style={{ whiteSpace: "pre-wrap" }}>{question.text}</p>
        <p className="muted">Missed: {question.missedPoints.map(point => `"${point}"`).join("; ")}</p>
        {question.feedback && <p style={{ whiteSpace: "pre-wrap" }}>{question.feedback}</p>}
        <div id={`feedback-${question.id}`}>
          {question.aiExplanation ? <>
            <h3>AI feedback</h3><p style={{ whiteSpace: "pre-wrap" }}>{question.aiExplanation}</p>
          </> : question.aiFeedbackEligible && <>
            {notice?.item === question.id && notice.aiError && Object.hasOwn(mockAiFeedbackMessages, notice.aiError)
              && <p className="notice error" role="alert">{mockAiFeedbackMessages[notice.aiError]}</p>}
            {aiAvailable && <form action={generateMockAiFeedbackAction.bind(null, courseId, mockExamId, question.id)} className="form">
              <p className="muted" id={`deepseek-notice-${question.id}`}>Generating an AI explanation sends your answer, the question, and the marking rubric and key points to DeepSeek.</p>
              <button className="button" type="submit" name="consent" value="deepseek" aria-describedby={`deepseek-notice-${question.id}`}>Generate AI explanation</button>
            </form>}
          </>}
        </div>
      </li>)}</ol> : <p className="muted">{report.marked ? "Nothing: every marked answer covered all its key points." : "Nothing could be marked."}</p>}
    </section>
    {report.notMarked.length > 0 && <section aria-labelledby="not-marked">
      <h2 id="not-marked">Not marked</h2>
      <ul className="list">{report.notMarked.map(question => <li key={question.id} data-unmarked={question.position}>Question {question.position}{question.topic ? ` · ${question.topic}` : ""}: no answer key yet.</li>)}</ul>
    </section>}
  </>;
}
