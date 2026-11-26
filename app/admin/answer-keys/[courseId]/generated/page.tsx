import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getCourseById } from "@/lib/courses";
import { listGeneratedRubrics, rubricReviewMessages } from "@/lib/generated-rubrics";
import { ANSWER_KEY_EXPLANATION_MAX_LENGTH, ANSWER_KEY_MAX_POINTS, ANSWER_KEY_POINT_MAX_LENGTH } from "@/lib/mock-marking-rules";
import { reviewGeneratedRubricAction } from "@/lib/answer-key-actions";

export const dynamic = "force-dynamic";

const labels = { DRAFT: "Draft", APPROVED: "Approved", REJECTED: "Rejected" };

export default async function GeneratedRubricsPage({ params, searchParams }: {
  params: Promise<{ courseId: string }>; searchParams: Promise<{ page?: string; saved?: string; error?: string }>;
}) {
  const { courseId } = await params;
  const notice = await searchParams;
  const base = `/admin/answer-keys/${encodeURIComponent(courseId)}`;
  const route = `${base}/generated`;
  await requireAdmin(route);
  const course = await getCourseById(courseId);
  if (!course) notFound();
  const { items, page, pages } = await listGeneratedRubrics(courseId, notice.page);

  return <>
    <Link className="back" href={base}>Back to Answer Keys</Link>
    <span className="eyebrow">{course.code}</span><h1>Generated rubric review</h1>
    {notice.saved === "1" && <p className="notice" role="status">Rubric review saved.</p>}
    {notice.error && <p className="notice error" role="alert">{Object.hasOwn(rubricReviewMessages, notice.error)
      ? rubricReviewMessages[notice.error] : rubricReviewMessages.unexpected}</p>}
    {!items.length && <p className="card muted">No generated rubrics in this course yet.</p>}
    <ul className="list">{items.map(item => <li className="card" key={item.id}>
      <h2>{item.topic}</h2>
      <p className="muted">{item.rubricStatus && labels[item.rubricStatus]}
        {item.reviewedAt && <> · Reviewed {item.reviewedAt.toISOString().slice(0, 10)}{item.reviewedBy && ` by ${item.reviewedBy.name}`}</>}
      </p>
      <p style={{ whiteSpace: "pre-wrap" }}>{item.prompt}</p>
      <details><summary>Source · {item.sourceQuestion.file.title}</summary>
        {item.currentSource
          ? <><p style={{ whiteSpace: "pre-wrap" }}>{item.sourceQuestion.text}</p><Link href={`/files/${encodeURIComponent(item.sourceQuestion.fileId)}`}>Open published paper</Link></>
          : <p className="muted">The source has changed or is no longer published in this course.</p>}
      </details>
      <form action={reviewGeneratedRubricAction.bind(null, "approve")} className="form">
        <input type="hidden" name="courseId" value={courseId} />
        <input type="hidden" name="id" value={item.id} />
        <input type="hidden" name="revision" value={item.reviewedAt?.toISOString() ?? ""} />
        <input type="hidden" name="page" value={page} />
        <label className="field">Key points ({ANSWER_KEY_MAX_POINTS} max, one per line)
          <textarea name="keyPoints" rows={5} defaultValue={item.rubric?.keyPoints.join("\n")} maxLength={ANSWER_KEY_MAX_POINTS * (ANSWER_KEY_POINT_MAX_LENGTH + 2)} required />
        </label>
        <label className="field">Worked explanation
          <textarea name="explanation" rows={5} defaultValue={item.rubric?.explanation} maxLength={ANSWER_KEY_EXPLANATION_MAX_LENGTH} required />
        </label>
        <div className="catalog-links">
          <button className="button" type="submit" disabled={!item.currentSource}>Approve rubric</button>
          <button className="button" type="submit" formAction={reviewGeneratedRubricAction.bind(null, "reject")} formNoValidate>Reject rubric</button>
        </div>
      </form>
    </li>)}</ul>
    {pages > 1 && <nav className="pagination" aria-label="Generated rubric pages">
      {page > 1 && <Link href={`${route}?page=${page - 1}`}>Previous</Link>}<span>Page {page} of {pages}</span>
      {page < pages && <Link href={`${route}?page=${page + 1}`}>Next</Link>}
    </nav>}
  </>;
}
