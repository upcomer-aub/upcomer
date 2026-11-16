import Link from "next/link";
import { notFound } from "next/navigation";
import { SourceLabel } from "@/components/source-label";
import { requireUser } from "@/lib/auth";
import { getCourseById } from "@/lib/courses";
import { NEUTRAL_WEAKNESS } from "@/lib/learning-profile";
import { getPracticeSet, PRACTICE_SIZES, practiceSize, type PracticeTopic } from "@/lib/practice-set";
import styles from "./practice-set.module.css";

export const dynamic = "force-dynamic";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// How the topic counts in the set, from the student's weakness in it.
function topicStrength(topic: PracticeTopic) {
  if (topic.topic === null) return "no topic";
  return topic.weakness > NEUTRAL_WEAKNESS ? "weaker topic" : topic.weakness < NEUTRAL_WEAKNESS ? "stronger topic" : "neutral topic";
}

// A practice set that emphasizes the student's weak topics (US-31, Lea Tass): N questions from the course's Upcomer Exam,
// more of them from the topics their learning profile says they are weaker in. Without a weak topic it is the N most
// frequent questions. Chosen with a plain GET form; reading the page never changes the profile. Each question links to
// the Upcomer Exam to attempt it; recording outcomes stays on /courses/:courseId/practice (US-25).
export default async function PracticeSetPage({ params, searchParams }: {
  params: Promise<{ courseId: string }>; searchParams: Promise<{ size?: string }>;
}) {
  const { courseId } = await params;
  const { size: requested } = await searchParams;
  const route = `/courses/${encodeURIComponent(courseId)}/practice/weak-topics`;
  const user = await requireUser(route);
  const course = await getCourseById(courseId);
  if (!course) notFound();
  const size = practiceSize(requested);
  const set = await getPracticeSet(user.id, courseId, size);
  const exam = `/courses/${courseId}/exam`;
  const rateTopics = <Link href={`/courses/${courseId}/confidence`}>Rate your topics</Link>;
  return <><Link className="back" href={`/courses/${courseId}`}>← Back to {course.code}</Link><span className="eyebrow">{course.code}</span><h1>Practice your weak topics</h1>
    <SourceLabel kind="statistics">The mix of topics follows your own ratings and practice.</SourceLabel>
    <p className="muted">A set of questions from the <Link href={exam}>Upcomer Exam</Link>, with more of them from the topics you are weaker in. Your stronger topics still appear, less often. Questions you marked done are included.</p>
    {!set.available
      ? <p className="card muted">This course has no questions to practice yet. Once its exam papers are processed, you can practice them here.</p>
      : <>
        <form className="search" action={route} method="get">
          <select name="size" defaultValue={String(size)} aria-label="Number of questions">
            {PRACTICE_SIZES.map(option => <option key={option} value={option}>{option} questions</option>)}
          </select>
          <button className="button" type="submit">Get practice set</button>
        </form>
        {set.mode === "frequency"
          ? <p className="notice" role="note">You have no weak topics in this course yet, so this set follows the exam frequency: the most likely questions first. {rateTopics} to focus it on what you find hard.</p>
          : <p className="muted">Weakest topics first. {rateTopics} to change the mix.</p>}
        {set.questions.length < size && <p className="muted" role="note">This course has only {plural(set.available, "question")}, so the set has all of them.</p>}
        {set.mode === "weak_topics" && <ul className={styles.topics} aria-label="Questions per topic">
          {set.topics.map(topic => <li key={topic.topicKey}><strong>{topic.topic ?? "Questions without a topic"}</strong> <span className="muted">· {topicStrength(topic)} · {plural(topic.count, "question")}</span></li>)}
        </ul>}
        <section className={styles.section} aria-labelledby="practice-set">
          <h2 id="practice-set">Your practice set <span className={styles.count}>· {plural(set.questions.length, "question")}</span></h2>
          <ol className={`list ${styles.questions}`}>{set.questions.map(question => <li className="card" key={question.id} data-topic={question.topic ?? ""}>
            <span className="eyebrow">Question {question.position}{question.topic && <> · {question.topic}</>}</span>
            <p className={styles.text}>{question.text}</p>
            <p className="muted">Appeared in {question.paperCount} of {plural(question.totalPapers, "paper")} · <Link href={`${exam}#question-${question.position}`}>Attempt it in the Upcomer Exam</Link></p>
          </li>)}</ol>
        </section>
      </>}
  </>;
}
