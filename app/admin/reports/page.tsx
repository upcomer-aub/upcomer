import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { REASON_LABELS } from "@/lib/question-report-rules";
import { getReportQueue } from "@/lib/question-reports";

export const dynamic = "force-dynamic";

const date = (value: Date) => `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export default async function QuestionReportsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requireAdmin("/admin/reports");
  const { page: requestedPage } = await searchParams;
  const { items, total, reportCount, page, totalPages } = await getReportQueue(Number(requestedPage ?? 1));
  return <><Link className="back" href="/admin/catalog">← Back to catalog</Link><span className="eyebrow">Admin</span><h1>Question Reports</h1>
    <p className="muted">Questions students reported from the Upcomer Exam, reported longest ago first. Reports of the same question are shown together.</p>
    {total > 0 && <p className="muted" role="status">{plural(total, "question")} with {plural(reportCount, "open report")}.</p>}
    {items.length ? <ol className="list catalog-list" aria-label="Reported questions">{items.map(item => <li className="card" key={item.key}>
      <span className="eyebrow">{item.course.code}{item.rank !== null && ` · Rank ${item.rank}`}{item.paperCount !== null && ` · ${plural(item.paperCount, "paper")}`}</span>
      <h3>{item.text}</h3>
      {!item.groupId && <p className="notice" role="note">This question was regrouped after it was reported, so the text is the one the student saw.</p>}
      <p className="muted">Reported by {plural(item.reports.length, "student")}, first on {date(item.firstReportedAt)} · {item.reasons.map(entry =>
        `${REASON_LABELS[entry.reason]}${entry.count > 1 ? ` ×${entry.count}` : ""}`).join(" · ")}</p>
      {item.reports.some(report => report.note) && <ul aria-label={`Details from students about ${item.text}`}>{item.reports.filter(report => report.note).map(report =>
        <li key={report.id}><span className="muted">{REASON_LABELS[report.reason]}, {date(report.createdAt)}:</span> {report.note}</li>)}</ul>}
      <p className="catalog-links">
        <Link href={`/courses/${encodeURIComponent(item.course.id)}/exam`}>Open the {item.course.code} Upcomer Exam</Link>
        <Link href="/admin/questions">Open the question bank</Link>
      </p>
    </li>)}</ol> : <p className="card muted">No questions are reported.</p>}
    {totalPages > 1 && <nav className="pagination" aria-label="Report pages">
      {page > 1 && <Link className="button" href={`/admin/reports?page=${page - 1}`}>← Older</Link>}
      <span className="muted">Page {page} of {totalPages}</span>
      {page < totalPages && <Link className="button" href={`/admin/reports?page=${page + 1}`}>Newer →</Link>}
    </nav>}
  </>;
}
