import Link from "next/link";
import { requireAdmin } from "@/lib/auth";

export default async function UploadsPage() {
  await requireAdmin("/admin/uploads");
  return <><span className="eyebrow">Admin</span><h1>Upload Content</h1><p className="muted">Add files to a course. They appear on the course pages as soon as the upload finishes.</p><p><Link href="/admin/processing">Exam processing status</Link></p><div className="grid">
    <section className="card"><h2>Previous Exams</h2><p className="muted">Add an exam from an earlier term to a course.</p><Link className="button" href="/admin/uploads/exams">Upload Previous Exam</Link></section>
    <section className="card"><h2>Course Materials</h2><p className="muted">Add notes, slides, or readings to a course.</p><Link className="button" href="/admin/uploads/materials">Upload Course Material</Link></section>
  </div></>;
}
