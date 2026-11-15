import Link from "next/link";
import { notFound } from "next/navigation";
import { MockExamSitting } from "@/components/mock-exam-sitting";
import { MockExamVersionsSection } from "@/components/mock-exam-versions";
import { versionMessage } from "@/lib/mock-exam-version-rules";
import { getMockExamVersions } from "@/lib/mock-exam-versions";
import { requireUser } from "@/lib/auth";
import { getCourseById } from "@/lib/courses";
import { getMockExam } from "@/lib/mock-exams";
import { DIFFICULTY_LABELS, SAME_QUESTIONS_NOTE, sittingMessage } from "@/lib/mock-exam-rules";

export const dynamic = "force-dynamic";

// One mock exam, sat by its own student (US-45). The notices come from fixed query parameters; their values are never shown.
export default async function MockExamPage({ params, searchParams }: {
  params: Promise<{ courseId: string; mockExamId: string }>;
  searchParams: Promise<{ saved?: string; submitted?: string; error?: string; same?: string; version?: string; version_error?: string; available?: string; length?: string }>;
}) {
  const { courseId, mockExamId } = await params;
  const { saved, submitted, error, same, version, version_error: versionError, available, length } = await searchParams;
  const user = await requireUser(`/courses/${encodeURIComponent(courseId)}/mock-exams/${encodeURIComponent(mockExamId)}`);
  // US-46: the exam's versions are read with it (only the student's own).
  const [course, exam, family] = await Promise.all([getCourseById(courseId), getMockExam(user.id, mockExamId), getMockExamVersions(user.id, mockExamId)]);
  const count = (value?: string) => (value && /^\d{1,3}$/.test(value) ? Number(value) : undefined);
  // Another student's exam, or one of another course, looks the same as one that doesn't exist.
  if (!course || !exam || exam.courseId !== courseId) notFound();
  return <><Link className="back" href={`/courses/${courseId}/mock-exams`}>← Back to Mock Exams</Link><span className="eyebrow">{course.code}</span><h1>Mock Exam</h1>
    <p className="muted">{exam.length} questions · {DIFFICULTY_LABELS[exam.difficulty]} · {exam.topics.length ? exam.topics.join(", ") : "All topics"}{exam.includeGenerated ? " · with generated questions" : ""}</p>
    {same && !error && !saved && !submitted && <p className="notice" role="status">{SAME_QUESTIONS_NOTE}</p>}
    {saved && !error && <p className="notice" role="status">Your answers were saved.</p>}
    {submitted && !error && <p className="notice" role="status">Your exam was submitted.</p>}
    {error && <p className="notice error" role="alert">{sittingMessage(error)}</p>}
    {version === "new" && family.versions.length > 1 && !error && <p className="notice" role="status">This is version {family.current} of this mock exam: the same topics, length and difficulty, with questions not used in its earlier versions.</p>}
    {versionError && <p className="notice error" role="alert">{versionMessage(versionError, count(available), count(length))}</p>}
    <MockExamSitting exam={exam} />
    <MockExamVersionsSection courseId={courseId} mockExamId={exam.id} family={family} />
  </>;
}
