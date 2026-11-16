import Link from "next/link";
import { notFound } from "next/navigation";
import { ReportAdviceForm } from "@/components/report-advice";
import { adviceReportMessage } from "@/lib/advice-report-rules";
import { SCOPE_LABELS } from "@/lib/advice-rules";
import { getReportableAdvice } from "@/lib/advice-reports";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// A student reports another student's advice (US-43). The page shows the advice as students see it (an anonymous author
// stays anonymous) and the report form. Advice that is no longer shown, or not in this course, is not found; the
// student's own advice and advice they already reported say so instead of offering the form.
export default async function ReportAdvicePage({ params, searchParams }: {
  params: Promise<{ courseId: string; adviceId: string }>; searchParams: Promise<{ error?: string; page?: string }>;
}) {
  const { courseId, adviceId } = await params;
  const { error, page } = await searchParams;
  const feed = `/courses/${encodeURIComponent(courseId)}/advice`;
  const user = await requireUser(`${feed}/${encodeURIComponent(adviceId)}/report`);
  const found = await getReportableAdvice(user.id, courseId, adviceId);
  if (!found) notFound();
  const { advice, own, reported } = found;
  const feedPage = Number(page);
  const returnPage = Number.isInteger(feedPage) && feedPage > 1 ? feedPage : 1;
  const back = `${feed}${returnPage > 1 ? `?page=${returnPage}` : ""}`;
  return <>
    <Link className="back" href={back}>← Back to the advice</Link>
    <span className="eyebrow">Student advice</span><h1>Report this advice</h1>
    <article className="card" aria-label="The advice you are reporting">
      <h2>{advice.title}</h2>
      <p className="muted">{advice.scope.kind === "COURSE" ? SCOPE_LABELS.COURSE : `${SCOPE_LABELS[advice.scope.kind]}: ${advice.scope.label}`} · By {advice.authorLabel}</p>
      <p style={{ whiteSpace: "pre-wrap" }}>{advice.body}</p>
    </article>
    {error && <p className="notice" role="alert">{adviceReportMessage(error)}</p>}
    {own ? <p className="notice" role="note">{adviceReportMessage("own_advice")}</p>
      : reported ? <p className="notice" role="note">{adviceReportMessage("duplicate")}</p>
      : <ReportAdviceForm courseId={courseId} adviceId={advice.id} page={returnPage} />}
  </>;
}
