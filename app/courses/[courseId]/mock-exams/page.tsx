import Link from "next/link";
import { notFound } from "next/navigation";
import { MockExamForm } from "@/components/mock-exam-form";
import { getCurrentUser } from "@/lib/auth";
import { getCourseById } from "@/lib/courses";
import { getMockExamOptions, listMyMockExams } from "@/lib/mock-exams";
import { DIFFICULTY_LABELS } from "@/lib/mock-exam-rules";
import { timeLimitLabel } from "@/lib/mock-exam-timing";

export const dynamic = "force-dynamic";

// Mock exams of one course (US-45): the form that generates one, and the student's own exams. A visitor sees what the page
// is for and a link to log in; the exams listed are always the session student's.
export default async function MockExamsPage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const [course, user] = await Promise.all([getCourseById(courseId), getCurrentUser()]);
  if (!course) notFound();
  const [options, mine] = await Promise.all([getMockExamOptions(courseId, user?.id), user ? listMyMockExams(user.id, courseId) : Promise.resolve([])]);
  const base = `/courses/${courseId}/mock-exams`;
  return <><Link className="back" href={`/courses/${courseId}`}>← Back to {course.code}</Link><span className="eyebrow">{course.code}</span><h1>Mock Exams</h1>
    <p className="muted">Generate a practice exam from this course&apos;s previous exam questions. Choose the topics, the number of questions, and the difficulty, and a time limit if you want one.</p>
    {options.total === 0
      ? <p className="card muted">No questions have been extracted for this course yet, so a mock exam can&apos;t be made.</p>
      : user
        ? <MockExamForm courseId={courseId} options={options} />
        : <p className="muted"><Link href={`/login?next=${encodeURIComponent(base)}`}>Log in</Link> to generate a mock exam.</p>}
    {mine.length > 0 && <>
      <h2>Your mock exams</h2>
      <ul className="list question-list">{mine.map(exam => <li className="card" key={exam.id}>
        <Link href={`${base}/${exam.id}`}>{exam.length} questions · {DIFFICULTY_LABELS[exam.difficulty]} · {exam.topics.length ? exam.topics.join(", ") : "All topics"}{exam.includeGenerated ? " · with generated questions" : ""}{exam.timeLimitMinutes !== null ? ` · Timed, ${timeLimitLabel(exam.timeLimitMinutes)}` : ""}</Link>
        <p className="muted">{exam.timedOut ? "Time is up" : exam.status === "SUBMITTED" ? "Submitted" : exam.timeLimitMinutes !== null && !exam.startedAt ? "Not started" : "In progress"} · created {exam.createdAt.toISOString().slice(0, 10)}</p>
      </li>)}</ul>
    </>}
  </>;
}
