import Link from "next/link";
import { notFound } from "next/navigation";
import { AdviceForm } from "@/components/advice-form";
import { AdviceList } from "@/components/advice-list";
import { SourceLabel } from "@/components/source-label";
import { getAdviceOptions, searchAdvice } from "@/lib/advice";
import { topicKeyOf } from "@/lib/advice-rules";
import { getCurrentUser } from "@/lib/auth";
import { getCourseById } from "@/lib/courses";
import { keptAdviceQuery, parseAdviceSort, voteMessage } from "@/lib/advice-vote-rules";
import { getHelpfulCounts } from "@/lib/advice-votes";
import { commentMessage } from "@/lib/advice-comment-rules";
import { getAdviceComments } from "@/lib/advice-comments";
import styles from "./advice-page.module.css";

export const dynamic = "force-dynamic";

type Params = {
  q?: string; topic?: string; examId?: string; termId?: string; page?: string; sort?: string; helpful?: string; helpful_error?: string;
  thread?: string; comment?: string; comment_error?: string;
};

export default async function AdvicePage({ params, searchParams }: { params: Promise<{ courseId: string }>; searchParams: Promise<Params> }) {
  const { courseId } = await params;
  const { q, topic, examId, termId, page, helpful, helpful_error: helpfulError, thread, comment, comment_error: commentError, ...rest } = await searchParams;
  // US-40: newest first unless "Most helpful" is chosen; any other value is ignored.
  const sort = parseAdviceSort(rest.sort);
  const course = await getCourseById(courseId);
  if (!course) notFound();
  const user = await getCurrentUser();
  const filters = { query: q, topic, examId, termId, page: page ? Number(page) : undefined, sort };
  const [result, options] = await Promise.all([searchAdvice(courseId, user?.id ?? null, filters), getAdviceOptions(courseId)]);
  const adviceIds = result.items.map(item => item.id);
  // US-41: the replies of the shown advice only, read for the session user (their own replies and, for an admin, every reply
  // get a Delete button).
  const [counts, threads] = await Promise.all([
    getHelpfulCounts(adviceIds, user?.id ?? null), getAdviceComments(courseId, adviceIds, user ? { id: user.id, role: user.role } : null),
  ]);
  const sortParam = sort === "helpful" ? sort : undefined;
  // The current view, so a helpful mark comes back to the same search, filters, sort, and page.
  const view = Object.entries({ q, topic, examId, termId, sort: sortParam, page: String(result.page) }).flatMap(([key, value]) => (value ? [[key, value]] : []));
  const returnTo = keptAdviceQuery(new URLSearchParams(view).toString()).toString();
  const filtered = Boolean(q?.trim() || topic || examId || termId);
  const base = `/courses/${courseId}/advice`;
  const link = (pageNumber: number) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ q, topic, examId, termId, sort: sortParam })) if (value) query.set(key, value);
    query.set("page", String(pageNumber));
    return `${base}?${query}`;
  };
  return <><Link className="back" href={`/courses/${courseId}`}>← Back to {course.code}</Link><span className="eyebrow">{course.code}</span><h1>Advice from previous students</h1>
    <p className="muted">Tips from students who took this course. Posts can be about the whole course, an exam, a session, a topic, or a question. Some students post anonymously.</p>
    <SourceLabel kind="opinion">What appeared in past exams is in the <Link href={`/courses/${courseId}/exam`}>Upcomer Exam</Link> (historical exam data).</SourceLabel>
    <form className={`search ${styles.filters}`} action={base} method="get" role="search">
      <input type="search" name="q" defaultValue={q ?? ""} placeholder="Search advice by keyword" aria-label="Search advice" maxLength={100} />
      <select name="topic" defaultValue={topic ? options.topics.find(item => topicKeyOf(item) === topicKeyOf(topic)) ?? "" : ""} aria-label="Filter by topic">
        <option value="">All topics</option>
        {options.topics.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
      <select name="examId" defaultValue={examId ?? ""} aria-label="Filter by exam">
        <option value="">All exams</option>
        {options.exams.map(exam => <option key={exam.id} value={exam.id}>{exam.year ? `${exam.title} (${exam.year})` : exam.title}</option>)}
      </select>
      <select name="termId" defaultValue={termId ?? ""} aria-label="Filter by session">
        <option value="">All sessions</option>
        {options.terms.map(term => <option key={term.id} value={term.id}>{term.name}</option>)}
      </select>
      <select name="sort" defaultValue={sort} aria-label="Sort advice">
        <option value="newest">Newest first</option>
        <option value="helpful">Most helpful first</option>
      </select>
      <button className="button" type="submit">Search</button>
    </form>
    {filtered && <p className="muted"><Link href={base}>Clear search and filters</Link></p>}
    {helpful === "marked" && <p className="notice" role="status">Marked as helpful.</p>}
    {helpful === "unmarked" && <p className="notice" role="status">Your helpful mark was removed.</p>}
    {helpfulError && <p className="notice" role="alert">{voteMessage(helpfulError)}</p>}
    {comment === "added" && <p className="notice" role="status">Your reply was posted.</p>}
    {comment === "deleted" && <p className="notice" role="status">The reply was deleted.</p>}
    {commentError && <p className="notice" role="alert">{commentMessage(commentError)}</p>}
    <AdviceList items={result.items} emptyMessage={filtered ? "No advice matches your search." : "No advice has been published for this course yet. Be the first."}
      helpful={{ courseId, counts, returnTo, loggedIn: Boolean(user) }}
      discussion={{ courseId, threads, returnTo, loggedIn: Boolean(user), openThread: thread }} />
    {result.totalPages > 1 && <nav className="muted" aria-label="Pages">
      {result.page > 1 && <Link href={link(result.page - 1)}>← Previous</Link>}{" "}Page {result.page} of {result.totalPages}{" "}
      {result.page < result.totalPages && <Link href={link(result.page + 1)}>Next →</Link>}
    </nav>}
    <h2>Share your advice</h2>
    {user
      ? <AdviceForm courseId={courseId} options={options} />
      : <p className="muted"><Link href={`/login?next=${encodeURIComponent(base)}`}>Log in</Link> to publish advice.</p>}
  </>;
}
