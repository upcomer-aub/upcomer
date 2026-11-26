import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { aiPracticeAvailable } from "@/lib/ai-practice";
import { readGeneratedRubric } from "@/lib/generated-rubric-rules";
import { getCourseById } from "@/lib/courses";
import { getCourseTopics } from "@/lib/topic-confidence";
import { getGeneratedPracticeQuestions } from "@/lib/practice-generation";
import { generationMessage } from "@/lib/practice-generation-rules";
import { generatePracticeAction } from "../actions";
import styles from "@/components/practice.module.css";

export const dynamic = "force-dynamic";
export default async function GeneratedPracticePage({ params, searchParams }: { params: Promise<{ courseId: string }>; searchParams: Promise<{ generated?: string; error?: string; page?: string; count?: string; difficulty?: string; topicKey?: string }> }) {
  const { courseId } = await params;
  const route = `/courses/${encodeURIComponent(courseId)}/practice/generated`;
  const user = await requireUser(route);
  const [course, topics, questions, notice] = await Promise.all([getCourseById(courseId), getCourseTopics(courseId), getGeneratedPracticeQuestions(user.id, courseId), searchParams]);
  if (!course) notFound();
  const aiAvailable = aiPracticeAvailable();
  const pages = Math.max(1, Math.ceil(questions.length / 20));
  const page = Math.min(pages, Math.max(1, Number.parseInt(notice.page ?? "1", 10) || 1));
  return <><Link className="back" href={`/courses/${courseId}/practice`}>Back to question practice</Link><span className="eyebrow">{course.code}</span><h1>Generate practice questions</h1>
    <p className="muted">Create practice questions from your course’s published exams. Template practice creates reasoning tasks from past-paper context. AI-generated questions can be used for practice right away, and their rubrics need admin approval before they can be used to mark a mock exam.</p>
    {notice.generated && /^\d+$/.test(notice.generated) && <p className="notice" role="status">New practice questions saved to your library.</p>}
    {notice.error && <p className="notice error" role="alert">{generationMessage(notice.error)}</p>}
    <form className="card form" action={generatePracticeAction}>
      <input type="hidden" name="courseId" value={courseId} />
      <div className="field"><label htmlFor="practice-topic">Topic</label><select id="practice-topic" name="topicKey" defaultValue={topics.some(topic => topic.topicKey === notice.topicKey) ? notice.topicKey : ""}><option value="">All topics</option>{topics.map(topic => <option key={topic.topicKey} value={topic.topicKey}>{topic.topic}</option>)}</select></div>
      <label className="field">Number of questions<input type="number" name="count" min="1" max="10" defaultValue={/^(?:[1-9]|10)$/.test(notice.count ?? "") ? notice.count : "3"} required /></label>
      <div className="field"><label htmlFor="practice-difficulty">Difficulty</label><select id="practice-difficulty" name="difficulty" defaultValue={notice.difficulty === "EASY" || notice.difficulty === "HARD" ? notice.difficulty : "MEDIUM"}><option value="EASY">Easy: identify and understand</option><option value="MEDIUM">Medium: apply and check</option><option value="HARD">Hard: compare and generalize</option></select></div>
      <div className="catalog-links">
        {aiAvailable && <button className="button" type="submit" name="mode" value="ai">Generate AI questions</button>}
        <button className="button" type="submit" name="mode" value="template">Template practice</button>
      </div>
      {!aiAvailable && <p className="muted">AI practice is currently unavailable.</p>}
    </form>
    <h2>Your generated questions</h2>
    {!questions.length && <p className="card muted">No generated questions yet. Published, topic-tagged exam questions are needed to get started.</p>}
    <ol className="list" start={(page - 1) * 20 + 1}>{questions.slice((page - 1) * 20, page * 20).map(question => {
      const rubric = question.rubricStatus === "APPROVED" ? readGeneratedRubric(question.rubric) : null;
      return <li className="card" key={question.id}>
      <span className="eyebrow">{question.topic} · {question.difficulty.toLowerCase()}</span>
      <p className={styles.prompt}>{question.prompt}</p>
      <p className="muted">Source: <Link href={`/files/${encodeURIComponent(question.sourceQuestion.fileId)}`}>{question.sourceQuestion.file.title}</Link> · {question.aiPromptVersion ? "AI-generated" : "Template practice"}
        {rubric ? " · Approved rubric" : " · No verified rubric available."}
      </p>
      {rubric && <details><summary>Worked explanation</summary><p className={styles.prompt}>{rubric.explanation}</p></details>}
    </li>;
    })}</ol>
    {pages > 1 && <nav className="pagination" aria-label="Generated question pages">{page > 1 && <Link href={`${route}?page=${page - 1}`}>Previous</Link>}<span>Page {page} of {pages}</span>{page < pages && <Link href={`${route}?page=${page + 1}`}>Next</Link>}</nav>}
  </>;
}
