import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getCourseById } from "@/lib/courses";
import { listAnswerKeyGroups } from "@/lib/mock-marking";
import { answerKeyMessage } from "@/lib/mock-marking-rules";

export const dynamic = "force-dynamic";

// The answer keys of one course (US-49): its question groups in rank order, 20 a page, each with or without a key.
// Mock exam answers are marked only against these keys; a question without one is shown to the student as not marked.
export default async function AnswerKeysPage({ params, searchParams }: {
  params: Promise<{ courseId: string }>; searchParams: Promise<{ page?: string; saved?: string; removed?: string; error?: string }>;
}) {
  const { courseId } = await params;
  const { page, saved, removed, error } = await searchParams;
  const base = `/admin/answer-keys/${encodeURIComponent(courseId)}`;
  await requireAdmin(base);
  const course = await getCourseById(courseId);
  if (!course) notFound();
  const result = await listAnswerKeyGroups(courseId, page);
  return <><Link className="back" href="/admin/questions">← Back to the question bank</Link><span className="eyebrow">Admin · {course.code}</span><h1>Answer Keys</h1>
    <p className="muted">Past papers have no answer keys, so mock exam answers are marked only against the key points you write here. A question without a key is shown to students as not marked. Changing a key does not change exams that were already marked.</p>
    <p><Link href={`${base}/generated`}>Review generated rubrics</Link></p>
    <p className="muted" data-key-count>{result.withKey} of {result.total} {result.total === 1 ? "question has" : "questions have"} an answer key.</p>
    {saved && <p className="notice" role="status">The answer key was saved.</p>}
    {removed && <p className="notice" role="status">The answer key was removed.</p>}
    {error && <p className="notice" role="alert">{answerKeyMessage(error)}</p>}
    {result.groups.length ? <ol className="list question-list">{result.groups.map(group => <li className="card" key={group.id} data-group={group.id}>
      <span className="eyebrow">#{group.rank} · in {group.paperCount} {group.paperCount === 1 ? "paper" : "papers"} · {group.answerKey ? `${group.answerKey.keyPoints.length} key ${group.answerKey.keyPoints.length === 1 ? "point" : "points"}` : "No answer key"}</span>
      <p style={{ whiteSpace: "pre-wrap" }}>{group.text}</p>
      <p><Link href={`${base}/${encodeURIComponent(group.id)}`}>{group.answerKey ? "Edit the answer key" : "Write an answer key"}</Link></p>
    </li>)}</ol> : <p className="card muted">This course has no questions from published exam papers yet.</p>}
    {result.totalPages > 1 && <nav className="muted" aria-label="Pages">
      {result.page > 1 && <Link href={`${base}?page=${result.page - 1}`}>← Previous</Link>}{" "}Page {result.page} of {result.totalPages}{" "}
      {result.page < result.totalPages && <Link href={`${base}?page=${result.page + 1}`}>Next →</Link>}
    </nav>}
  </>;
}
