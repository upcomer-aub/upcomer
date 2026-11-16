import Link from "next/link";
import { notFound } from "next/navigation";
import { MockExamSitting } from "@/components/mock-exam-sitting";
import { requireUser } from "@/lib/auth";
import { getCourseById } from "@/lib/courses";
import { getMockExam } from "@/lib/mock-exams";
import { DIFFICULTY_LABELS, mixMessage, SAME_QUESTIONS_NOTE, shorterMessage, sittingMessage } from "@/lib/mock-exam-rules";

export const dynamic = "force-dynamic";

// One mock exam, sat by its own student (US-45). The notices come from fixed query parameters; their values are never shown.
// Each time it is opened, it says when the exam is shorter than asked (US-45) and why it has its mix of topics (US-47).
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
    <p className="muted">{exam.length} questions · {DIFFICULTY_LABELS[exam.difficulty]} · {exam.topics.length ? exam.topics.join(", ") : "All topics"}{exam.includeGenerated ? " · with generated questions" : ""}</p>
    {mix && <p className="muted" data-testid="mock-mix">{mix}</p>}
    {shorter && <p className="notice" role="status">{shorter}</p>}
    {same && !shorter && !error && !saved && !submitted && <p className="notice" role="status">{SAME_QUESTIONS_NOTE}</p>}
    {saved && !error && <p className="notice" role="status">Your answers were saved.</p>}
    {submitted && !error && <p className="notice" role="status">Your exam was submitted.</p>}
    {error && <p className="notice error" role="alert">{sittingMessage(error)}</p>}
    <MockExamSitting exam={exam} />
  </>;
}
