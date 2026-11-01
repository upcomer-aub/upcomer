import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getCourseById } from "@/lib/courses";
import { getCourseTopics, getTopicConfidence } from "@/lib/topic-confidence";
import { saveTopicConfidenceAction } from "@/lib/topic-confidence-actions";
import { CONFIDENCE_SCALE, confidenceMessage, RATING_FIELD, SKIP } from "@/lib/topic-confidence-rules";
import styles from "./confidence.module.css";

export const dynamic = "force-dynamic";

// A student rates their confidence in each topic of a course (US-24), from 1 (not confident) to 5 (very confident), or
// skips it. The ratings set their learning profile, so the Upcomer Exam's personal order puts their weak topics first.
// One plain POST form, pre-filled with the student's saved ratings.
export default async function TopicConfidencePage({ params, searchParams }: {
  params: Promise<{ courseId: string }>; searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { courseId } = await params;
  const { saved, error } = await searchParams;
  const user = await requireUser(`/courses/${encodeURIComponent(courseId)}/confidence`);
  const course = await getCourseById(courseId);
  if (!course) notFound();
  const [topics, ratings] = await Promise.all([getCourseTopics(courseId), getTopicConfidence(user.id, courseId)]);
  const exam = `/courses/${courseId}/exam`;
  return <><Link className="back" href={`/courses/${courseId}`}>← Back to {course.code}</Link><span className="eyebrow">{course.code}</span><h1>Rate your topics</h1>
    <p className="muted">How confident are you in each topic of {course.code}? Your ratings set your personal order of the <Link href={exam}>Upcomer Exam</Link>: questions on topics you are less confident in come first. Skip a topic you don&apos;t want to rate.</p>
    {error && <p className="notice error" role="alert">{confidenceMessage(error)}</p>}
    {saved && !error && <p className="notice" role="status">Your ratings were saved. <Link href={`${exam}?order=personal`}>See your personal order</Link></p>}
    {!topics.length
      ? <p className="card muted">This course&apos;s exam papers have no topics yet, so there is nothing to rate.</p>
      : <form className={`form ${styles.form}`} action={saveTopicConfidenceAction}>
        <input type="hidden" name="courseId" value={courseId} />
        {topics.map(topic => {
          const rating = ratings.get(topic.topicKey) ?? null;
          return <fieldset key={topic.topicKey} className={`checkbox-list ${styles.topic}`}>
            <legend>{topic.topic}</legend>
            {CONFIDENCE_SCALE.map(step => <label key={step.rating}>
              <input type="radio" name={`${RATING_FIELD}${topic.topicKey}`} value={step.rating} defaultChecked={rating === step.rating} /> {step.rating} · {step.label}
            </label>)}
            <label><input type="radio" name={`${RATING_FIELD}${topic.topicKey}`} value={SKIP} defaultChecked={rating === null} /> Skip</label>
          </fieldset>;
        })}
        <button className="button" type="submit">Save ratings</button>
      </form>}
  </>;
}
