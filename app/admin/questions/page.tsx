import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getQuestionBankOverview } from "@/lib/question-bank";
import { rebuildQuestionBankAction } from "@/lib/question-bank-actions";

export const dynamic = "force-dynamic";

const errors: Record<string, string> = {
  not_found: "That course doesn't exist anymore.",
  unexpected: "The questions could not be grouped. Please try again.",
};

export default async function AdminQuestionsPage({ searchParams }: { searchParams: Promise<{ rebuilt?: string; groups?: string; error?: string }> }) {
  await requireAdmin("/admin/questions");
  const { rebuilt, groups, error } = await searchParams;
  const courses = await getQuestionBankOverview();
  const rebuiltCourse = courses.find(course => course.id === rebuilt);
  return <><Link className="back" href="/admin/catalog">← Back to catalog</Link><span className="eyebrow">Admin</span><h1>Question Bank</h1>
    <p className="muted">Extracted questions are grouped and ranked after each paper is processed. Regroup a course here after fixing its papers or questions.</p>
    {error && <p className="notice error" role="alert">{errors[error] ?? errors.unexpected}</p>}
    {rebuiltCourse && <p className="notice" role="status">Regrouped {rebuiltCourse.code}: {Number(groups) || 0} distinct questions. <Link href={`/courses/${rebuiltCourse.id}/questions`}>Open its question bank</Link></p>}
    {courses.length ? <ul className="list catalog-list">{courses.map(course => <li className="card" key={course.id}>
      <span className="eyebrow">{course.code}</span><h3>{course.name}</h3>
      <p className="muted">{course.questions} {course.questions === 1 ? "question" : "questions"} from {course.papers} {course.papers === 1 ? "paper" : "papers"} · {course.groupCount} distinct</p>
      <form action={rebuildQuestionBankAction}>
        <input type="hidden" name="courseId" value={course.id} />
        <button className="button" type="submit" aria-label={`Regroup and rank ${course.code}`}>Regroup and rank</button>
      </form>
      <p className="catalog-links"><Link href={`/admin/questions/${encodeURIComponent(course.id)}`} aria-label={`Correct questions in ${course.code}`}>Correct questions</Link></p>
    </li>)}</ul> : <p className="card muted">No questions have been extracted yet.</p>}
  </>;
}
