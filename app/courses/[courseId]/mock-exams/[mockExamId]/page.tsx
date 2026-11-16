import Link from "next/link";
import { notFound } from "next/navigation";
import { MockExamSitting } from "@/components/mock-exam-sitting";
import { requireUser } from "@/lib/auth";
import { getCourseById } from "@/lib/courses";
import { getMockExam } from "@/lib/mock-exams";
import { DIFFICULTY_LABELS, mixMessage, SAME_QUESTIONS_NOTE, shorterMessage, sittingMessage } from "@/lib/mock-exam-rules";
import { TIME_UP_NOTICE, timeLimitLabel } from "@/lib/mock-exam-timing";

export const dynamic = "force-dynamic";

// One mock exam, sat by its own student (US-45). The notices come from fixed query parameters; their values are never shown.
// Each time it is opened, it says when the exam is shorter than asked (US-45) and why it has its mix of topics (US-47).
// An exam whose time ran out (US-48) says so every time, instead of the notice of a normal submit; getMockExam has
// already submitted it by the time this renders, and leaves out the questions of a timed exam that was not started.
export default async function MockExamPage({ params, searchParams }: {
  params: Promise<{ courseId: string; mockExamId: string }>; searchParams: Promise<{ saved?: string; submitted?: string; error?: string; same?: string }>;
}) {
  const { courseId, mockExamId } = await params;
  const { saved, submitted, error, same } = await searchParams;
  const user = await requireUser(`/courses/${encodeURIComponent(courseId)}/mock-exams/${encodeURIComponent(mockExamId)}`);
  const [course, exam] = await Promise.all([getCourseById(courseId), getMockExam(user.id, mockExamId)]);
  // Another student's exam, or one of another course, looks the same as one that doesn't exist.
  if (!course || !exam || exam.courseId !== courseId) notFound();
  const shorter = shorterMessage(exam.requestedLength, exam.length, exam.includeGenerated);
  const mix = mixMessage(exam.mixBasis, exam.weakTopics);
  return <><Link className="back" href={`/courses/${courseId}/mock-exams`}>← Back to Mock Exams</Link><span className="eyebrow">{course.code}</span><h1>Mock Exam</h1>
    <p className="muted">{exam.length} questions · {DIFFICULTY_LABELS[exam.difficulty]} · {exam.topics.length ? exam.topics.join(", ") : "All topics"}{exam.includeGenerated ? " · with generated questions" : ""}{exam.timeLimitMinutes !== null ? ` · Timed, ${timeLimitLabel(exam.timeLimitMinutes)}` : ""}</p>
    {mix && <p className="muted" data-testid="mock-mix">{mix}</p>}
    {shorter && <p className="notice" role="status">{shorter}</p>}
    {exam.timedOut && <p className="notice" role="status" data-testid="mock-time-up">{TIME_UP_NOTICE}</p>}
    {same && !shorter && !error && !saved && !submitted && !exam.timedOut && <p className="notice" role="status">{SAME_QUESTIONS_NOTE}</p>}
    {saved && !error && !exam.timedOut && <p className="notice" role="status">Your answers were saved.</p>}
    {submitted && !error && !exam.timedOut && <p className="notice" role="status">Your exam was submitted.</p>}
    {error && !(exam.timedOut && error === "time_up") && <p className="notice error" role="alert">{sittingMessage(error)}</p>}
    <MockExamSitting exam={exam} />
  </>;
}
