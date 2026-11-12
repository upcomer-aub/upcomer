import Link from "next/link";
import { AdviceAbout } from "@/components/advice-list";
import { getAdviceReportQueue } from "@/lib/advice-moderation";
import { moderateAdviceAction } from "@/lib/advice-moderation-actions";
import { ADVICE_REPORT_REASON_LABELS } from "@/lib/advice-report-rules";
import { requireAdmin } from "@/lib/auth";
import styles from "./advice-reports.module.css";

export const dynamic = "force-dynamic";

const date = (value: Date) => `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const MESSAGES: Record<string, string> = {
  invalid_decision: "Choose to remove the advice or keep it.",
  not_found: "That advice has no open reports any more. Another admin may have decided on it already.",
  rate_limited: "Too many decisions in a minute. Wait a moment and try again.",
  unexpected: "Your decision could not be saved. Please try again.",
};
// Any other value (for example one typed into the URL) gets the general message, never the value itself.
const message = (error: string) => (Object.hasOwn(MESSAGES, error) ? MESSAGES[error] : MESSAGES.unexpected);

// The queue of reported advice (US-77), for admins only. Each advice is shown as students see it (an anonymous author
// stays anonymous), with its reports' reasons and details but not who sent them.
export default async function AdviceReportsPage({ searchParams }: {
  searchParams: Promise<{ page?: string; removed?: string; kept?: string; error?: string }>;
}) {
  await requireAdmin("/admin/advice-reports");
  const { page: requestedPage, removed, kept, error } = await searchParams;
  const { items, total, reportCount, page, totalPages } = await getAdviceReportQueue(requestedPage ?? 1);
  const outcome = error ? <p className="notice error" role="alert">{message(error)}</p>
    : removed ? <p className="notice" role="status">The advice was removed. Students no longer see it, and its reports are resolved.</p>
    : kept ? <p className="notice" role="status">The advice was kept, and its reports are dismissed.</p>
    : null;
  return <><Link className="back" href="/admin/catalog">← Back to catalog</Link><span className="eyebrow">Admin</span><h1>Advice Reports</h1>
    <p className="muted">Student advice that other students reported, reported longest ago first. Remove advice that breaks the rules; keep advice that does not.</p>
    {outcome}
    {total > 0 && <p className="muted" role="status">{plural(total, "advice")} with {plural(reportCount, "open report")}.</p>}
    {items.length ? <ol className="list catalog-list" aria-label="Reported advice">{items.map(item => {
      const label = `advice ${item.advice.id}`;
      return <li className="card" key={item.advice.id}>
        <article aria-label={`Reported advice in ${item.course.code}`}>
          <span className="eyebrow">{item.course.code} · <AdviceAbout courseId={item.course.id} about={item.advice.about} /></span>
          <p className={styles.body}>{item.advice.body}</p>
          {item.advice.resourceUrl && <p className="muted">Resource: {item.advice.resourceUrl}</p>}
          <p className="muted">By {item.advice.author} · {date(item.advice.createdAt)}{item.advice.edited && " · edited"}</p>
          {!item.shown && <p className="notice" role="note">Its author already deleted this advice; students no longer see it. Close its reports.</p>}
          <p className="muted">Reported by {plural(item.reports.length, "student")}, first on {date(item.firstReportedAt)} · {item.reasons.map(entry =>
            `${ADVICE_REPORT_REASON_LABELS[entry.reason]}${entry.count > 1 ? ` ×${entry.count}` : ""}`).join(" · ")}</p>
          {item.reports.some(report => report.note) && <ul aria-label="Details from students">{item.reports.filter(report => report.note).map(report =>
            <li key={report.id}><span className="muted">{ADVICE_REPORT_REASON_LABELS[report.reason]}, {date(report.createdAt)}:</span> {report.note}</li>)}</ul>}
          <div className={styles.decisions}>
            <form action={moderateAdviceAction}>
              <input type="hidden" name="adviceId" value={item.advice.id} />
              <input type="hidden" name="page" value={page} />
              <input type="hidden" name="decision" value="remove" />
              <button className={`button ${styles.remove}`} type="submit" aria-label={item.shown ? `Remove ${label}` : `Close the reports of ${label}`}>{item.shown ? "Remove advice" : "Close reports"}</button>
            </form>
            {item.shown && <form action={moderateAdviceAction}>
              <input type="hidden" name="adviceId" value={item.advice.id} />
              <input type="hidden" name="page" value={page} />
              <input type="hidden" name="decision" value="keep" />
              <button className={`button ${styles.keep}`} type="submit" aria-label={`Keep ${label}`}>Keep advice</button>
            </form>}
            {item.shown && <Link href={`/courses/${encodeURIComponent(item.course.id)}/advice`}>Open the {item.course.code} advice</Link>}
          </div>
        </article>
      </li>;
    })}</ol> : <p className="card muted">No advice is reported.</p>}
    {totalPages > 1 && <nav className="pagination" aria-label="Report pages">
      {page > 1 && <Link className="button" href={`/admin/advice-reports?page=${page - 1}`}>← Older</Link>}
      <span className="muted">Page {page} of {totalPages}</span>
      {page < totalPages && <Link className="button" href={`/admin/advice-reports?page=${page + 1}`}>Newer →</Link>}
    </nav>}
  </>;
}
