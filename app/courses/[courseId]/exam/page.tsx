import Link from "next/link";
import { notFound } from "next/navigation";
import { ConsolidatedExamView, PersonalExamView } from "@/components/consolidated-exam";
import { OrderSwitch } from "@/components/order-switch";
import { ProgressSummary } from "@/components/question-progress";
import { getCurrentUser } from "@/lib/auth";
import { getConsolidatedExam } from "@/lib/consolidated-exam";
import { getCourseById } from "@/lib/courses";
import { MIN_CONFIDENT_PAPERS } from "@/lib/likelihood-tiers";
import { getPersonalOrder } from "@/lib/personal-order";
import { getCourseProgress } from "@/lib/question-progress";
import { progressMessage } from "@/lib/question-progress-rules";
import { reportMessage } from "@/lib/question-report-rules";

export const dynamic = "force-dynamic";

// The outcome of a question report (US-23).
function ReportNotice({ reported, error }: { reported?: string; error?: string }) {
  if (error) return <p className="notice error" role="alert">{reportMessage(error)}</p>;
  if (reported) return <p className="notice" role="status">Thanks, your report was sent. An admin will check the question.</p>;
  return null;
}

export default async function ConsolidatedExamPage({ params, searchParams }: {
  params: Promise<{ courseId: string }>; searchParams: Promise<{ reported?: string; report_error?: string; progress_error?: string; at?: string; order?: string }>;
}) {
  const { courseId } = await params;
  const { reported, report_error: reportError, progress_error: progressError, at, order } = await searchParams;
  const [course, user] = await Promise.all([getCourseById(courseId), getCurrentUser()]);
  if (!course) notFound();
  const exam = await getConsolidatedExam(courseId);
  // The logged-in student's own marks (US-21); a visitor has none.
  const done = user && exam.questions.length ? new Set((await getCourseProgress(user.id, courseId)).keys()) : null;
  // The student's personal order (US-28); without a learning profile in the course it stays the frequency order.
  const personal = Boolean(done) && order === "personal";
  const personalOrder = user && personal ? await getPersonalOrder(user.id, courseId, exam.questions) : null;
  const shown = personalOrder?.hasProfile ? personalOrder.questions : exam.questions;
  const papers = `${exam.totalPapers} previous ${exam.totalPapers === 1 ? "exam" : "exams"}`;
  const route = `/courses/${courseId}/exam`;
  // Topic ratings set the personal order (US-24); the link sits in the note when there is no profile, else under the switch.
  const rateTopics = <Link href={`/courses/${courseId}/confidence`}>Rate your topics</Link>;
  const noProfile = Boolean(personalOrder && !personalOrder.hasProfile);
  return <><Link className="back" href={`/courses/${courseId}`}>← Back to {course.code}</Link><span className="eyebrow">{course.code}</span><h1>Upcomer Exam</h1>
    <ReportNotice reported={reported} error={reportError} />
    {progressError && <p className="notice error" role="alert">{progressMessage(progressError)}</p>}
    {exam.totalPapers === 0
      ? <p className="card muted">No exam papers have been processed for this course yet. Once they are, every distinct question will appear here once, the most likely first.</p>
      : !exam.questions.length
        ? <p className="card muted">This course&apos;s questions are still being prepared. Please check back later.</p>
        : <>
          <p className="muted">{exam.questions.length} distinct {exam.questions.length === 1 ? "question" : "questions"} from {papers}, {personalOrder?.hasProfile ? "in your personal order" : "the most likely first"}. Each question is listed once.</p>
          {done && <OrderSwitch route={route} personal={personal} />}
          {done && !noProfile && <p className="muted">{rateTopics} to change your personal order.</p>}
          {noProfile && <p className="muted" role="note">You have no learning profile for this course yet, so this is the frequency order. {rateTopics} to get a personal order.</p>}
          {exam.lowConfidence && <p className="notice" role="note">Low confidence: these tiers are based on only {papers}. They become more reliable from {MIN_CONFIDENT_PAPERS} papers.</p>}
          {done && <ProgressSummary positions={shown} done={done} at={Number(at) || undefined} />}
          {!user && <p className="muted">Logged-in students can mark questions done, continue where they stopped, and see a personal order.</p>}
          {!user && <p className="muted"><Link href={`/login?next=${encodeURIComponent(route)}`}>Log in</Link> to report a question that is wrong or grouped wrongly.</p>}
          {personalOrder?.hasProfile
            ? <PersonalExamView questions={shown} report={user ? { courseId } : null} progress={done && { courseId, done, personal }} />
            : <ConsolidatedExamView sections={exam.sections} report={user ? { courseId } : null} progress={done && { courseId, done, personal }} />}
        </>}
  </>;
}
