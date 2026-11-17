import Link from "next/link";
import { notFound } from "next/navigation";
import { WalkthroughGenerateForm, WalkthroughSteps } from "@/components/question-walkthrough";
import styles from "@/components/question-walkthrough.module.css";
import { SourceLabel } from "@/components/source-label";
import { requireUser } from "@/lib/auth";
import { getCourseById } from "@/lib/courses";
import { canRetry, walkthroughMessage } from "@/lib/walkthrough-rules";
import { getWalkthroughPage } from "@/lib/walkthroughs";

export const dynamic = "force-dynamic";

// US-51 (Lea Tass): the step-by-step walkthrough of one past-exam question, for logged-in students. Only a question of a
// published exam paper of this course is found. Opening the page never calls the AI: it shows the stored walkthrough, or the
// form that makes one. The notice comes from a fixed reason code; the query value itself is never shown.
export default async function WalkthroughPage({ params, searchParams }: {
  params: Promise<{ courseId: string; questionId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { courseId, questionId } = await params;
  const { error } = await searchParams;
  const user = await requireUser(`/courses/${encodeURIComponent(courseId)}/questions/${encodeURIComponent(questionId)}/walkthrough`);
  const [course, data] = await Promise.all([getCourseById(courseId), getWalkthroughPage(user.id, courseId, questionId)]);
  if (!course || !data) notFound();
  const { question, walkthrough } = data;
  const failed = !walkthrough && error ? error : undefined;
  return <><Link className="back" href={`/courses/${courseId}/exam`}>← Back to the Upcomer Exam</Link><span className="eyebrow">{course.code}</span>
    <h1>Step-by-step walkthrough</h1>
    <SourceLabel kind="ai" />
    <section className={`card ${styles.question}`} aria-labelledby="question-heading">
      <h2 id="question-heading" className="eyebrow">The question · {question.paperTitle}{question.year ? ` (${question.year})` : ""}{question.topic ? ` · ${question.topic}` : ""}</h2>
      <p className={styles.questionText}>{question.text}</p>
    </section>
    {failed && <p className="notice error" role="alert">{walkthroughMessage(failed)}</p>}
    {walkthrough
      ? <WalkthroughSteps steps={walkthrough.steps} createdAt={walkthrough.createdAt} />
      : (!failed || canRetry(failed)) && <WalkthroughGenerateForm courseId={courseId} questionId={question.id} retry={Boolean(failed)} />}
  </>;
}
