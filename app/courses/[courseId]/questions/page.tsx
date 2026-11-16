import Link from "next/link";
import { notFound } from "next/navigation";
import { QuestionList } from "@/components/question-list";
import { SourceLabel } from "@/components/source-label";
import { getCourseById } from "@/lib/courses";
import { examTypeLabel } from "@/lib/file-metadata-rules";
import { getQuestionBank, getQuestionBankFilterOptions, parseQuestionBankFilters } from "@/lib/question-bank";

export const dynamic = "force-dynamic";

type Params = { q?: string; year?: string; termId?: string; examType?: string; professorId?: string };

export default async function QuestionBankPage({ params, searchParams }: { params: Promise<{ courseId: string }>; searchParams: Promise<Params> }) {
  const { courseId } = await params;
  const { q, ...paperFilters } = await searchParams;
  const course = await getCourseById(courseId);
  if (!course) notFound();
  const filters = { query: q, ...paperFilters };
  const [bank, options] = await Promise.all([getQuestionBank(courseId, filters), getQuestionBankFilterOptions(courseId)]);
  const chosen = parseQuestionBankFilters(filters);
  const filtered = Boolean(chosen.query || chosen.year || chosen.termId || chosen.examType || chosen.professorId);
  const empty = bank.totalPapers === 0;
  return <><Link className="back" href={`/courses/${courseId}`}>← Back to {course.code}</Link><span className="eyebrow">{course.code}</span><h1>Question Bank</h1>
    {/* US-42: these counts are historical exam data, kept apart from student advice. */}
    <SourceLabel kind="statistics">Tips are on the <Link href={`/courses/${courseId}/advice`}>Advice</Link> page (student opinion).</SourceLabel>
    <p className="muted">{empty
      ? "Questions from this course's previous exams will appear here."
      : `Questions from ${bank.totalPapers} previous ${bank.totalPapers === 1 ? "exam" : "exams"}, the most frequent first. The same question is listed once.`}</p>
    {!empty && <form className="search" action={`/courses/${courseId}/questions`} method="get" role="search">
      <input type="search" name="q" defaultValue={chosen.query} placeholder="Search questions by keyword" aria-label="Search questions" />
      <select name="year" defaultValue={chosen.year ? String(chosen.year) : ""} aria-label="Filter by year">
        <option value="">All years</option>
        {options.years.map(year => <option key={year} value={year}>{year}</option>)}
      </select>
      <select name="termId" defaultValue={chosen.termId ?? ""} aria-label="Filter by term">
        <option value="">All terms</option>
        {options.terms.map(term => <option key={term.id} value={term.id}>{term.name}</option>)}
      </select>
      <select name="examType" defaultValue={chosen.examType ?? ""} aria-label="Filter by type">
        <option value="">All types</option>
        {options.examTypes.map(type => <option key={type} value={type}>{examTypeLabel(type)}</option>)}
      </select>
      <select name="professorId" defaultValue={chosen.professorId ?? ""} aria-label="Filter by professor">
        <option value="">All professors</option>
        {options.professors.map(professor => <option key={professor.id} value={professor.id}>{professor.name}</option>)}
      </select>
      <button className="button" type="submit">Search</button>
    </form>}
    {filtered && <p className="muted"><Link href={`/courses/${courseId}/questions`}>Clear search and filters</Link></p>}
    <QuestionList groups={bank.groups} emptyMessage={empty ? "No questions have been extracted for this course yet." : "No questions match your search."} />
  </>;
}
