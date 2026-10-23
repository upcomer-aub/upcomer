import Link from "next/link";
import { notFound } from "next/navigation";
import { CorrectionLog, CorrectionTags } from "@/components/correction-log";
import { requireAdmin } from "@/lib/auth";
import { getCorrectionPage } from "@/lib/question-corrections";

export const dynamic = "force-dynamic";

// Question corrections: every group of a course in rank order, with its questions, and the course's activity log.
export default async function CourseQuestionCorrectionsPage({ params, searchParams }: {
  params: Promise<{ courseId: string }>; searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const [{ courseId }, { page: requestedPage, q }] = await Promise.all([params, searchParams]);
  const route = `/admin/questions/${encodeURIComponent(courseId)}`;
  await requireAdmin(route);
  const view = await getCorrectionPage(courseId, { page: Number(requestedPage ?? 1), query: q ?? "" });
  if (!view) notFound();
  const { course, groups, total, page, totalPages, totalPapers, log, query } = view;
  const pageLink = (target: number) => `${route}?${new URLSearchParams({ ...(query ? { q: query } : {}), page: String(target) })}`;
  return <><Link className="back" href="/admin/questions">← Back to the question bank</Link>
    <span className="eyebrow">Admin · {course.code}</span><h1>Correct Questions</h1>
    <p className="muted">{course.name}. Fix a question&apos;s text if it was extracted wrongly, or move it to the right group if it was grouped wrongly. Corrections are kept when the questions are regrouped or a paper is processed again.</p>
    <form className="search" action={route} method="get" role="search">
      <input type="search" name="q" defaultValue={query} maxLength={200} aria-label="Find a question" placeholder="Find a question" />
      <button className="button" type="submit">Search</button>
    </form>
    <p className="muted" role="status">{total} {total === 1 ? "group" : "groups"}{query ? ` with a question containing “${query}”` : ""}, from {totalPapers} {totalPapers === 1 ? "paper" : "papers"}.</p>
    {groups.length ? <ol className="list catalog-list" aria-label="Question groups">{groups.map(group => <li className="card" key={group.id}>
      <span className="eyebrow">#{group.rank} · in {group.paperCount} of {totalPapers} {totalPapers === 1 ? "paper" : "papers"}</span><h3>{group.text}</h3>
      <ul className="question-list">{group.questions.map(question => <li key={question.id}>
        <p className="muted">{question.file.title}, question {question.number} <CorrectionTags question={question} /></p>
        <p style={{ whiteSpace: "pre-line" }}>{question.text}</p>
        <p className="catalog-links"><Link href={`${route}/${encodeURIComponent(question.id)}`} aria-label={`Correct ${question.file.title} question ${question.number}`}>Correct</Link></p>
      </li>)}</ul>
    </li>)}</ol> : <p className="card muted">{query ? "No question contains that text." : "This course has no extracted questions yet."}</p>}
    {totalPages > 1 && <nav className="pagination" aria-label="Group pages">
      {page > 1 && <Link className="button" href={pageLink(page - 1)}>← Previous</Link>}
      <span className="muted">Page {page} of {totalPages}</span>
      {page < totalPages && <Link className="button" href={pageLink(page + 1)}>Next →</Link>}
    </nav>}
    <h2>Activity log</h2>
    <p className="muted">The latest corrections in {course.code}, newest first.</p>
    <CorrectionLog entries={log} label={`Corrections in ${course.code}`} />
  </>;
}
