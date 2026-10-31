import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getCatalogAdminData } from "@/lib/catalog-admin";

export const dynamic = "force-dynamic";

export default async function CatalogAdminPage() {
  await requireAdmin("/admin/catalog");
  const { faculties, courses, professors, terms } = await getCatalogAdminData();
  const sections = [
    { href: "/admin/catalog/faculties", title: "Faculties", count: faculties.length, text: "Faculties group courses in the catalog filters." },
    { href: "/admin/catalog/courses", title: "Courses", count: courses.length, text: "Course codes, names, faculties, and professors." },
    { href: "/admin/catalog/professors", title: "Professors", count: professors.length, text: "Professors can be assigned to courses and uploads." },
    { href: "/admin/catalog/terms", title: "Terms", count: terms.length, text: "The terms content can be organized by." },
  ];
  return <><span className="eyebrow">Admin</span><h1>Manage Catalog</h1><p className="muted">Add and edit what students see in the course catalog. Changes appear straight away.</p>
    <div className="grid">
      {sections.map(section => <section className="card" key={section.href}>
        <h2>{section.title}</h2><p className="muted">{section.count} {section.count === 1 ? "entry" : "entries"}. {section.text}</p>
        <Link className="button" href={section.href}>Manage {section.title.toLowerCase()}</Link>
      </section>)}
      <section className="card"><h2>Files</h2><p className="muted">Tag uploaded files with their course, professor, year, term, topic, and type.</p><Link className="button" href="/admin/files">Manage files</Link></section>
      <section className="card"><h2>Submissions</h2><p className="muted">Exams and materials students submitted, oldest first. Publish them or reject them with a reason.</p><Link className="button" href="/admin/submissions">Review submissions</Link></section>
      <section className="card"><h2>Question bank</h2><p className="muted">Extracted questions per course, grouped and ranked by how often they appear.</p><Link className="button" href="/admin/questions">Open question bank</Link></section>
      <section className="card"><h2>Question reports</h2><p className="muted">Questions students reported as wrong or grouped wrongly, with their reasons.</p><Link className="button" href="/admin/reports">Open question reports</Link></section>
      <section className="card"><h2>Monitoring</h2><p className="muted">Errors and warnings from every feature, with alerts when errors pile up.</p><Link className="button" href="/admin/monitoring">Open monitoring</Link></section>
      <section className="card"><h2>Uploads</h2><p className="muted">Add previous exams and course materials.</p><Link className="button" href="/admin/uploads">Upload content</Link></section>
    </div>
  </>;
}
