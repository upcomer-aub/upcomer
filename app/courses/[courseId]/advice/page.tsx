import Link from "next/link";
import { notFound } from "next/navigation";
import { AdviceList } from "@/components/advice-list";
import { allowAdviceFeedRead, getCourseAdvice } from "@/lib/advice";
import { adviceReportMessage } from "@/lib/advice-report-rules";
import { getOpenReportedAdviceIds } from "@/lib/advice-reports";
import { adviceChangeMessage } from "@/lib/advice-rules";
import { requireUser } from "@/lib/auth";
import { getCourseById } from "@/lib/courses";

export const dynamic = "force-dynamic";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// The course's advice from previous students (US-38), newest first, 20 a page. Advice is other students' writing, so
// only logged-in users see it.
export default async function CourseAdvicePage({ params, searchParams }: {
  params: Promise<{ courseId: string }>; searchParams: Promise<{ page?: string; edited?: string; unchanged?: string; deleted?: string; change_error?: string; reported?: string; report_error?: string }>;
}) {
  const { courseId } = await params;
  const { page: requestedPage, edited, unchanged, deleted, change_error: changeError, reported, report_error: reportError } = await searchParams;
  const route = `/courses/${encodeURIComponent(courseId)}/advice`;
  const user = await requireUser(route);
  const course = await getCourseById(courseId);
  if (!course) notFound();
  const back = <Link className="back" href={`/courses/${encodeURIComponent(courseId)}`}>← Back to {course.code}</Link>;
  // DoS protection: a script reading page after page is stopped before it reaches the database.
  if (!allowAdviceFeedRead(user.id)) {
    return <>{back}<span className="eyebrow">{course.code}</span><h1>Advice from previous students</h1>
      <p className="notice error" role="alert">Too many pages opened in a minute. Wait a moment, then reload the page.</p></>;
  }
  const { items, total, page, totalPages } = await getCourseAdvice(courseId, requestedPage ?? 1, user.id);
  // Which advice on this page the viewer already reported (US-43); their own advice cannot be reported.
  const reportedIds = await getOpenReportedAdviceIds(user.id, items.filter(item => !item.mine).map(item => item.id));
  // The outcome of the author's own edit or delete (US-36), or of a report (US-43).
  const outcome = reportError ? <p className="notice error" role="alert">{adviceReportMessage(reportError)}</p>
    : reported ? <p className="notice" role="status">Thanks, your report was sent. An admin will check the advice.</p>
    : changeError ? <p className="notice error" role="alert">{adviceChangeMessage(changeError)}</p>
    : deleted ? <p className="notice" role="status">Your advice was deleted. Other students no longer see it.</p>
    : edited ? <p className="notice" role="status">Your advice was updated.</p>
    : unchanged ? <p className="notice" role="status">Nothing was changed.</p>
    : null;
  return <>{back}
    <span className="eyebrow">{course.code}</span><h1>Advice from previous students</h1>
    <p className="muted">What students who took {course.code} before you suggest. This is their opinion, not statistics from previous exams.</p>
    {outcome}
    {total > 0 && <p className="muted" role="status">{plural(total, "piece")} of advice{totalPages > 1 && `, page ${page} of ${totalPages}`}.</p>}
    {items.length ? <AdviceList courseId={courseId} items={items} page={page} reported={reportedIds} /> : <p className="card muted">No advice has been shared for {course.code} yet.</p>}
    {totalPages > 1 && <nav className="pagination" aria-label="Advice pages">
      {page > 1 && <Link className="button" href={`${route}?page=${page - 1}`}>← Newer</Link>}
      <span className="muted">Page {page} of {totalPages}</span>
      {page < totalPages && <Link className="button" href={`${route}?page=${page + 1}`}>Older →</Link>}
    </nav>}
  </>;
}
