import Link from "next/link";
import { notFound } from "next/navigation";
import { CourseHeader } from "@/components/course-header";
import { SourceLabel } from "@/components/source-label";
import { getCourseById } from "@/lib/courses";
import { addCourseAction } from "@/lib/my-courses-actions";

export default async function CoursePage({ params, searchParams }: { params: Promise<{ courseId: string }>; searchParams?: Promise<{ added?: string }> }) {
  const { courseId } = await params;
  const { added } = (await searchParams) ?? {};
  const course = await getCourseById(courseId);
  if (!course) notFound();
  return <><CourseHeader course={course} />
    <form className="inline-form" action={addCourseAction}>
      <input type="hidden" name="courseId" value={course.id} />
      <button className="button" type="submit">Add to My Courses</button>
    </form>
    {added && <p className="notice" role="status">{added === "already" ? "Already in My Courses." : "Added to My Courses."} <Link href="/my-courses">Open My Courses</Link></p>}
    <h2>Course Resources</h2><div className="grid">
    <section className="card"><h2>Question practice</h2><p className="muted">Record practice outcomes, understand priorities, and generate new study questions.</p><Link className="button" href={`/courses/${course.id}/practice`}>Practice questions</Link></section>
    <section className="card"><h2>Weak-topic practice</h2><p className="muted">A set of exam questions with more from the topics you find hard.</p><Link className="button" href={`/courses/${course.id}/practice/weak-topics`}>Practice your weak topics</Link></section>
    <section className="card"><h2>Previous Exams</h2><p className="muted">Browse exams from earlier terms.</p><Link className="button" href={`/courses/${course.id}/exams`}>Browse Previous Exams</Link></section>
    <section className="card"><h2>Course Materials</h2><p className="muted">Find notes, slides, and readings.</p><Link className="button" href={`/courses/${course.id}/materials`}>Browse Course Materials</Link></section>
    <section className="card"><h2>Mock Exams</h2><p className="muted">Generate a practice exam by topic, length, and difficulty.</p><Link className="button" href={`/courses/${course.id}/mock-exams`}>Generate a Mock Exam</Link></section>
  </div>
  {/* US-42: exam statistics and student advice sit in separate, labelled sections. */}
  <section aria-labelledby="exam-statistics" data-source="statistics">
    <h2 id="exam-statistics">Exam statistics</h2><SourceLabel kind="statistics" />
    <div className="grid">
    <section className="card"><h3>Question Bank</h3><p className="muted">Questions from previous exams, the most frequent first.</p><Link className="button" href={`/courses/${course.id}/questions`}>Browse Question Bank</Link></section>
    <section className="card"><h3>Upcomer Exam</h3><p className="muted">Every distinct question from previous exams once, the most likely first.</p><Link className="button" href={`/courses/${course.id}/exam`}>Open Upcomer Exam</Link></section>
    </div>
  </section>
  <section aria-labelledby="student-advice" data-source="opinion">
    <h2 id="student-advice">Advice from previous students</h2><SourceLabel kind="opinion" />
    <div className="grid">
    <section className="card"><h3>Advice</h3><p className="muted">Tips from students who took this course.</p><Link className="button" href={`/courses/${course.id}/advice`}>Read Student Advice</Link></section>
    </div>
  </section></>;
}
