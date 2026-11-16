import Link from "next/link";
import { notFound } from "next/navigation";
import { MockExamSitting } from "@/components/mock-exam-sitting";
import { MockExamVersionsSection } from "@/components/mock-exam-versions";
import { versionMessage } from "@/lib/mock-exam-version-rules";
import { getMockExamVersions } from "@/lib/mock-exam-versions";
import { requireUser } from "@/lib/auth";
import { getCourseById } from "@/lib/courses";
import { getMockExam } from "@/lib/mock-exams";
import { DIFFICULTY_LABELS, mixMessage, SAME_QUESTIONS_NOTE, shorterMessage, sittingMessage } from "@/lib/mock-exam-rules";
import { TIME_UP_NOTICE, timeLimitLabel } from "@/lib/mock-exam-timing";
import { markMockExam } from "@/lib/mock-marking";

export const dynamic = "force-dynamic";

// One mock exam, sat by its own student (US-45). The notices come from fixed query parameters; their values are never shown.
// Each time it is opened, it says when the exam is shorter than asked (US-45) and why it has its mix of topics (US-47).
// An exam whose time ran out (US-48) says so every time, instead of the notice of a normal submit; getMockExam has
// already submitted it by the time this renders, and leaves out the questions of a timed exam that was not started.
export default async function MockExamPage({ params, searchParams }: {
  params: Promise<{ courseId: string; mockExamId: string }>;
  searchParams: Promise<{ saved?: string; submitted?: string; error?: string; same?: string; version?: string; version_error?: string; available?: string; length?: string }>;
}) {
  const { courseId, mockExamId } = await params;
  const { saved, submitted, error, same, version, version_error: versionError, available, length } = await searchParams;
  const user = await requireUser(`/courses/${encodeURIComponent(courseId)}/mock-exams/${encodeURIComponent(mockExamId)}`);
  // US-46: the exam's versions are read with it (only the student's own).
  const [course, found, family] = await Promise.all([getCourseById(courseId), getMockExam(user.id, mockExamId), getMockExamVersions(user.id, mockExamId)]);
  const count = (value?: string) => (value && /^\d{1,3}$/.test(value) ? Number(value) : undefined);
  // Another student's exam, or one of another course, looks the same as one that doesn't exist.
  if (!course || !found || found.courseId !== courseId) notFound();
  // US-49: a submitted exam that is not marked yet (submitted before marking existed, or marking failed) is marked now.
  let exam = found;
  if (exam.status === "SUBMITTED" && !exam.markedAt) {
    const marked = await markMockExam(user.id, exam.id);
    if (marked.ok) exam = (await getMockExam(user.id, mockExamId)) ?? exam;
  }

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
    {version === "new" && family.versions.length > 1 && !error && <p className="notice" role="status">This is version {family.current} of this mock exam: the same topics, length and difficulty, with questions not used in its earlier versions.</p>}
    {versionError && <p className="notice error" role="alert">{versionMessage(versionError, count(available), count(length))}</p>}
    {/* US-49: whether the answers were marked. */}
    {exam.status === "SUBMITTED" && <p className="muted" data-marked={exam.markedAt ? "yes" : "no"}>{exam.markedAt
      ? <>Your answers were marked against the answer keys. See each question below, or <Link href={`/courses/${encodeURIComponent(courseId)}/mock-exams/${encodeURIComponent(exam.id)}/results`}>See your results</Link>.</>
      : "Your answers could not be marked yet. Reload the page to try again."}</p>}
    <MockExamSitting exam={exam} />
    <MockExamVersionsSection courseId={courseId} mockExamId={exam.id} family={family} />
  </>;
}
