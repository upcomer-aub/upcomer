import Link from "next/link";
import { notFound } from "next/navigation";
import { ConsolidatedExamView } from "@/components/consolidated-exam";
import { getCurrentUser } from "@/lib/auth";
import { getConsolidatedExam } from "@/lib/consolidated-exam";
import { getCourseById } from "@/lib/courses";
import { MIN_CONFIDENT_PAPERS } from "@/lib/likelihood-tiers";
import { reportMessage } from "@/lib/question-report-rules";

export const dynamic = "force-dynamic";

// The outcome of a question report (US-23).
function ReportNotice({ reported, error }: { reported?: string; error?: string }) {
  if (error) return <p className="notice error" role="alert">{reportMessage(error)}</p>;
  if (reported) return <p className="notice" role="status">Thanks, your report was sent. An admin will check the question.</p>;
  return null;
}

export default async function ConsolidatedExamPage({ params, searchParams }: {
  params: Promise<{ courseId: string }>; searchParams: Promise<{ reported?: string; report_error?: string }>;
}) {
  const { courseId } = await params;
  const { reported, report_error: reportError } = await searchParams;
  const [course, user] = await Promise.all([getCourseById(courseId), getCurrentUser()]);
  if (!course) notFound();
  const exam = await getConsolidatedExam(courseId);
  const papers = `${exam.totalPapers} previous ${exam.totalPapers === 1 ? "exam" : "exams"}`;
  const route = `/courses/${courseId}/exam`;
  return <><Link className="back" href={`/courses/${courseId}`}>← Back to {course.code}</Link><span className="eyebrow">{course.code}</span><h1>Upcomer Exam</h1>
    <ReportNotice reported={reported} error={reportError} />
    {exam.totalPapers === 0
      ? <p className="card muted">No exam papers have been processed for this course yet. Once they are, every distinct question will appear here once, the most likely first.</p>
      : !exam.questions.length
        ? <p className="card muted">This course&apos;s questions are still being prepared. Please check back later.</p>
        : <>
          <p className="muted">{exam.questions.length} distinct {exam.questions.length === 1 ? "question" : "questions"} from {papers}, the most likely first. Each question is listed once.</p>
          {exam.lowConfidence && <p className="notice" role="note">Low confidence: these tiers are based on only {papers}. They become more reliable from {MIN_CONFIDENT_PAPERS} papers.</p>}
          {!user && <p className="muted"><Link href={`/login?next=${encodeURIComponent(route)}`}>Log in</Link> to report a question that is wrong or grouped wrongly.</p>}
          <ConsolidatedExamView sections={exam.sections} report={user ? { courseId } : null} />
        </>}
  </>;
}
