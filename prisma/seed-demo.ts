// npm run db:seed-demo            fills the database with demo faculties, courses, professors, files, and students
// npm run db:seed-demo -- --reset  deletes only demo records (IDs starting with "demo-") and the demo PDFs
//
// Separate from prisma/seed.ts, which it never changes. Every record it creates has a "demo-" ID and the data is
// generated from a fixed seed, so running it again updates the same records instead of adding new ones.
// Each file is checked with the app's own upload rules before it is saved. It never writes log entries.
import { mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import type { ExamType, FileCategory } from "@prisma/client";
import { createRng } from "../tests/reliability/rng";
import { DEMO_COURSES, DEMO_FACULTIES, FIRST_NAMES, LAST_NAMES, type FacultyCode } from "./demo/catalog";

try {
  process.loadEnvFile?.(".env");
} catch {
  // No .env file; rely on the environment.
}
// The app modules below are loaded after this line, so nothing they do can persist a log entry.
process.env.LOG_PERSIST = "off";

const DEMO = "demo-";
const DEMO_FOLDER = "demo";
const FILE_COUNT = 600;
const PROFESSOR_COUNT = 40;
const STUDENT_COUNT = 20;
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "upcomer-demo";
const STUDENT_DOMAIN = "demo.upcomer.test";
const TERM_NAMES = ["Fall", "Spring", "Summer"] as const;

const storageRoot = () => path.resolve(process.env.FILE_STORAGE_ROOT || "public/uploads");
const demoFolder = () => path.join(storageRoot(), DEMO_FOLDER);
const demoId = { startsWith: DEMO };

async function app() {
  const [{ db }, metadata, uploads, auth] = await Promise.all([
    import("../lib/db"), import("../lib/file-metadata"), import("../lib/uploads"), import("../lib/auth"),
  ]);
  return { db, parseFileMetadata: metadata.parseFileMetadata, checkFileMetadata: metadata.checkFileMetadata, validateUploadFile: uploads.validateUploadFile, BCRYPT_COST: auth.BCRYPT_COST, PASSWORD_MIN_LENGTH: auth.PASSWORD_MIN_LENGTH };
}
type App = Awaited<ReturnType<typeof app>>;

// ---------- One-page PDFs ----------

// Helvetica in a PDF only covers plain ASCII here, so other characters are replaced.
const pdfText = (text: string) => text.replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[^\x20-\x7E]/g, "?").replace(/[()\\]/g, "\\$&");

export function demoPdf(lines: { text: string; size: number }[]) {
  let y = 740;
  const content = ["BT", "/F1 1 Tf"];
  for (const line of lines) {
    content.push(`/F1 ${line.size} Tf`, `1 0 0 1 72 ${y} Tm`, `(${pdfText(line.text)}) Tj`);
    y -= line.size + 14;
  }
  content.push("ET");
  const stream = content.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

// ---------- Generated data ----------

const rng = createRng(2026);
const slug = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const pad = (value: number, length = 2) => String(value).padStart(length, "0");
// A plausible upload date inside the term.
function termDate(term: string, year: number) {
  const [month, span] = term === "Fall" ? [9, 3] : term === "Spring" ? [1, 4] : [6, 2];
  return new Date(Date.UTC(year, month + rng.int(0, span - 1), rng.int(1, 28), rng.int(8, 20), rng.int(0, 59)));
}
const weighted = <T>(items: [T, number][]) => {
  let roll = rng.next() * items.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [item, weight] of items) if ((roll -= weight) < 0) return item;
  return items[items.length - 1][0];
};

// 17 and 40 share no factor, so every professor gets a different last name.
const professorNames = Array.from({ length: PROFESSOR_COUNT }, (_, index) => `${FIRST_NAMES[index % FIRST_NAMES.length]} ${LAST_NAMES[(index * 17) % LAST_NAMES.length]}`);

function studentNames() {
  const names = new Set<string>();
  for (let index = 0; names.size < STUDENT_COUNT; index++) {
    const name = `${FIRST_NAMES[(index * 3 + 5) % FIRST_NAMES.length]} ${LAST_NAMES[(index * 11 + 3) % LAST_NAMES.length]}`;
    if (!professorNames.includes(name)) names.add(name);
  }
  return [...names];
}

// Professors teach within one faculty: each faculty gets professors in proportion to its courses, every course has a
// main professor, and some get a second one. Every professor ends up with 1 to 4 courses.
function assignProfessors(courses: { id: string; faculty: FacultyCode }[], professorIds: string[]) {
  const byFaculty = new Map<FacultyCode, string[]>();
  for (const course of courses) byFaculty.set(course.faculty, [...(byFaculty.get(course.faculty) ?? []), course.id]);
  const faculties = [...byFaculty.keys()];
  const shares = faculties.map(faculty => Math.max(1, Math.round((professorIds.length * byFaculty.get(faculty)!.length) / courses.length)));
  for (let index = 0; shares.reduce((a, b) => a + b, 0) !== professorIds.length; index = (index + 1) % shares.length) {
    const total = shares.reduce((a, b) => a + b, 0);
    if (total > professorIds.length && shares[index] > 1) shares[index]--;
    if (total < professorIds.length && shares[index] < byFaculty.get(faculties[index])!.length) shares[index]++;
  }
  const links: { courseId: string; professorId: string }[] = [];
  let next = 0;
  faculties.forEach((faculty, facultyIndex) => {
    const facultyCourses = byFaculty.get(faculty)!;
    const facultyProfessors = professorIds.slice(next, next + shares[facultyIndex]);
    next += shares[facultyIndex];
    const load = new Map(facultyProfessors.map(id => [id, 0]));
    facultyCourses.forEach((courseId, index) => {
      const professorId = facultyProfessors[index % facultyProfessors.length];
      links.push({ courseId, professorId });
      load.set(professorId, load.get(professorId)! + 1);
    });
    for (const courseId of facultyCourses) {
      if (!rng.chance(0.3)) continue;
      const second = facultyProfessors.filter(id => load.get(id)! < 4 && !links.some(link => link.courseId === courseId && link.professorId === id));
      if (!second.length) continue;
      const professorId = rng.pick(second);
      links.push({ courseId, professorId });
      load.set(professorId, load.get(professorId)! + 1);
    }
  });
  for (const professorId of professorIds) {
    const count = links.filter(link => link.professorId === professorId).length;
    if (count < 1 || count > 4) throw new Error(`Professor ${professorId} would teach ${count} courses.`);
  }
  return links;
}

const EXAM_TYPES: [ExamType, number][] = [["MIDTERM", 40], ["FINAL", 30], ["QUIZ", 20], ["OTHER", 10]];
function examTitle(type: ExamType) {
  if (type === "MIDTERM") return rng.pick(["Midterm Exam", "Midterm 1", "Midterm 2"]);
  if (type === "FINAL") return "Final Exam";
  if (type === "QUIZ") return `Quiz ${rng.int(1, 5)}`;
  return rng.pick(["Practice Exam", "Make-up Exam", "Sample Exam"]);
}
function materialTitle(topic: string) {
  return rng.pick([`Lecture Notes: ${topic}`, `Slides: ${topic}`, `Problem Set ${rng.int(1, 8)}: ${topic}`, `Review Sheet: ${topic}`, `Worked Examples: ${topic}`, `Lab Handout: ${topic}`]);
}

// ---------- Seed ----------

async function seed(a: App) {
  const { db } = a;
  if (DEMO_PASSWORD.length < a.PASSWORD_MIN_LENGTH) throw new Error(`DEMO_PASSWORD must be at least ${a.PASSWORD_MIN_LENGTH} characters.`);

  // Faculties: reuse one with the same code (from the normal seed or the admin pages), otherwise create a demo one.
  const facultyIds = new Map<FacultyCode, string>();
  for (const faculty of DEMO_FACULTIES) {
    const existing = await db.faculty.findUnique({ where: { code: faculty.code }, select: { id: true } });
    facultyIds.set(faculty.code, existing?.id ?? (await db.faculty.create({ data: { id: faculty.id, code: faculty.code, name: faculty.name } })).id);
  }

  // Terms: reuse Fall, Spring, and Summer; create a demo one only if it is missing.
  const termIds = new Map<string, string>();
  for (const name of TERM_NAMES) {
    const existing = await db.term.findUnique({ where: { name }, select: { id: true } });
    termIds.set(name, existing?.id ?? (await db.term.create({ data: { id: `${DEMO}term-${name.toLowerCase()}`, name } })).id);
  }

  // Courses: a code that already belongs to a non-demo course is left alone.
  const courses: (typeof DEMO_COURSES[number] & { id: string })[] = [];
  for (const course of DEMO_COURSES) {
    const id = `${DEMO}course-${course.code.toLowerCase()}`;
    const taken = await db.course.findUnique({ where: { code: course.code }, select: { id: true } });
    if (taken && taken.id !== id) {
      console.warn(`  Skipping ${course.code}: a non-demo course already uses that code.`);
      continue;
    }
    const data = { code: course.code, name: course.name, facultyId: facultyIds.get(course.faculty)! };
    await db.course.upsert({ where: { id }, update: data, create: { id, ...data } });
    courses.push({ ...course, id });
  }

  // Professors and who teaches what.
  const professorIds = professorNames.map((_, index) => `${DEMO}prof-${pad(index + 1)}`);
  for (const [index, id] of professorIds.entries()) await db.professor.upsert({ where: { id }, update: { name: professorNames[index] }, create: { id, name: professorNames[index] } });
  const links = assignProfessors(courses, professorIds);
  // Drop demo-to-demo links that are no longer generated; links involving a real course or professor are never touched.
  await db.courseProfessor.deleteMany({ where: { courseId: demoId, professorId: demoId, NOT: { OR: links.map(link => ({ courseId: link.courseId, professorId: link.professorId })) } } });
  await db.courseProfessor.createMany({ data: links, skipDuplicates: true });
  const teachers = new Map<string, string[]>();
  for (const link of links) teachers.set(link.courseId, [...(teachers.get(link.courseId) ?? []), link.professorId]);

  // Files: every course gets at least one; the rest are spread at random. Titles are unique within a course.
  const titles = new Map<string, Set<string>>();
  const files = Array.from({ length: FILE_COUNT }, (_, index) => {
    const course = index < courses.length ? courses[index] : rng.pick(courses);
    const category: FileCategory = rng.chance(0.55) ? "EXAM" : "MATERIAL";
    const year = rng.int(2019, 2025);
    const term = weighted<string>([["Fall", 45], ["Spring", 45], ["Summer", 10]]);
    const topic = rng.pick(course.topics);
    const examType = category === "EXAM" ? weighted(EXAM_TYPES) : undefined;
    const used = titles.get(course.id) ?? new Set<string>();
    let title = category === "EXAM" ? `${examTitle(examType!)} — ${term} ${year}` : materialTitle(topic);
    if (used.has(title) && category === "MATERIAL") title = `${title} (${term} ${year})`;
    for (let version = 0; used.has(title); version++) title = `${title.replace(/ \(Version [A-Z]\)$/, "")} (Version ${"BCDEFGH"[version]})`;
    used.add(title);
    titles.set(course.id, used);
    const id = `${DEMO}file-${pad(index + 1, 4)}`;
    return {
      id, course, category, title, year, term, topic, examType, professorId: rng.pick(teachers.get(course.id)!), createdAt: termDate(term, year),
      originalFileName: `${course.code.toLowerCase()}-${slug(title)}.pdf`, storageKey: `${DEMO_FOLDER}/${id}.pdf`,
    };
  });

  await mkdir(demoFolder(), { recursive: true });
  const professorName = new Map(professorIds.map((id, index) => [id, professorNames[index]]));
  for (let start = 0; start < files.length; start += 25) {
    await Promise.all(files.slice(start, start + 25).map(async file => {
      const bytes = demoPdf([
        { text: "Upcomer demo document", size: 11 },
        { text: `${file.course.code} - ${file.course.name}`, size: 20 },
        { text: file.title, size: 16 },
        { text: `${file.term} ${file.year}`, size: 13 },
        { text: `Professor: ${professorName.get(file.professorId)}`, size: 12 },
        { text: `Topic: ${file.topic}`, size: 12 },
        { text: "Generated sample for demonstration only. Not real course material.", size: 10 },
      ]);
      // The same checks an admin upload goes through.
      const fields: Record<string, string> = {
        courseId: file.course.id, professorId: file.professorId, year: String(file.year), termId: termIds.get(file.term)!, topic: file.topic, examType: file.examType ?? "",
      };
      const parsed = a.parseFileMetadata({ get: (name: string) => fields[name] ?? null }, file.category);
      if (!parsed.ok) throw new Error(`${file.id} fails the upload rules: ${parsed.error}`);
      const invalid = await a.checkFileMetadata(parsed.metadata);
      if (invalid) throw new Error(`${file.id} fails the upload rules: ${invalid}`);
      const { mimeType } = a.validateUploadFile(file.originalFileName, bytes);
      if (file.title.length > 150) throw new Error(`${file.id} has a title longer than 150 characters.`);

      await writeFile(path.join(storageRoot(), file.storageKey), bytes);
      const data = {
        courseId: file.course.id, professorId: file.professorId, title: file.title, originalFileName: file.originalFileName, storageKey: file.storageKey,
        category: file.category, year: file.year, termId: termIds.get(file.term)!, examType: file.examType ?? null, topic: file.topic,
        mimeType, sizeBytes: bytes.length, createdAt: file.createdAt,
      };
      await db.courseFile.upsert({ where: { id: file.id }, update: data, create: { id: file.id, ...data } });
    }));
  }
  // Demo files from an earlier, larger run.
  const fileIds = new Set(files.map(file => file.id));
  await db.courseFile.deleteMany({ where: { id: { startsWith: `${DEMO}file-`, notIn: [...fileIds] } } });
  for (const name of await readdir(demoFolder())) {
    if (/^demo-file-\d+\.pdf$/.test(name) && !fileIds.has(name.replace(/\.pdf$/, ""))) await rm(path.join(demoFolder(), name));
  }

  // Students, each with several courses in My Courses.
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, a.BCRYPT_COST);
  const students = studentNames().map((name, index) => ({
    id: `${DEMO}student-${pad(index + 1)}`, name, email: `${slug(name).replace(/-/g, ".")}@${STUDENT_DOMAIN}`,
  }));
  for (const student of students) {
    await db.user.upsert({ where: { id: student.id }, update: { name: student.name, email: student.email, passwordHash }, create: { ...student, passwordHash } });
    const picked = new Set<string>();
    for (const target = rng.int(3, 7); picked.size < target;) picked.add(rng.pick(courses).id);
    const now = Date.now();
    await db.userCourse.createMany({
      data: [...picked].map(courseId => ({ userId: student.id, courseId, createdAt: new Date(now - rng.int(1, 120) * 86_400_000) })),
      skipDuplicates: true,
    });
  }
  return students;
}

// ---------- Reset ----------

// Non-demo records that depend on demo ones. Deleting the demo records would delete or change these, so reset stops.
async function dependents(a: App) {
  const { db } = a;
  const notDemo = { NOT: { id: demoId } };
  const [files, enrollments, courseLinks, courses] = await Promise.all([
    db.courseFile.count({ where: { ...notDemo, OR: [{ courseId: demoId }, { professorId: demoId }, { termId: demoId }] } }),
    db.userCourse.count({ where: { courseId: demoId, NOT: { userId: demoId } } }),
    db.courseProfessor.count({ where: { OR: [{ courseId: demoId, NOT: { professorId: demoId } }, { professorId: demoId, NOT: { courseId: demoId } }] } }),
    db.course.count({ where: { ...notDemo, facultyId: demoId } }),
  ]);
  return Object.entries({ files, "My Courses entries of real users": enrollments, "course-professor links": courseLinks, courses }).filter(([, count]) => count > 0);
}

async function reset(a: App) {
  const { db } = a;
  const blocking = await dependents(a);
  if (blocking.length) {
    console.error(`Reset stopped: these non-demo records depend on demo data and would be deleted or changed: ${blocking.map(([name, count]) => `${count} ${name}`).join(", ")}.`);
    console.error("Remove or reassign them first (for example in /admin/files), then run the reset again.");
    process.exitCode = 1;
    return;
  }
  const [users, files, links, courses, professors, faculties, terms] = await db.$transaction([
    // Sessions and My Courses entries of demo students go with them (cascade).
    db.user.deleteMany({ where: { id: demoId } }),
    db.courseFile.deleteMany({ where: { id: demoId } }),
    db.courseProfessor.deleteMany({ where: { OR: [{ courseId: demoId }, { professorId: demoId }] } }),
    db.course.deleteMany({ where: { id: demoId } }),
    db.professor.deleteMany({ where: { id: demoId } }),
    db.faculty.deleteMany({ where: { id: demoId } }),
    db.term.deleteMany({ where: { id: demoId } }),
  ]);
  let pdfs = 0;
  const names = await readdir(demoFolder()).catch(() => [] as string[]);
  for (const name of names.filter(item => /^demo-.*\.pdf$/.test(item))) {
    await rm(path.join(demoFolder(), name));
    pdfs++;
  }
  // Only removes the folder when nothing else is in it.
  await rmdir(demoFolder()).catch(() => undefined);
  console.log(`Removed demo data: ${users.count} students, ${files.count} files (${pdfs} PDFs), ${links.count} course-professor links, ${courses.count} courses, ${professors.count} professors, ${faculties.count} faculties, ${terms.count} terms.`);
}

// ---------- Counts ----------

async function counts(a: App) {
  const { db } = a;
  const pair = async (model: { count: (args?: { where: { id: typeof demoId } }) => Promise<number> }) => `${await model.count()} (${await model.count({ where: { id: demoId } })} demo)`;
  return {
    faculties: await pair(db.faculty), courses: await pair(db.course), professors: await pair(db.professor), terms: await pair(db.term),
    files: await pair(db.courseFile), users: await pair(db.user),
    "course-professor links": String(await db.courseProfessor.count()),
    "My Courses entries": `${await db.userCourse.count()} (${await db.userCourse.count({ where: { userId: demoId } })} demo)`,
    "log entries": String(await db.logEntry.count()),
  };
}

async function main() {
  const a = await app();
  try {
    if (process.argv.includes("--reset")) {
      await reset(a);
    } else {
      console.log("Seeding demo data…");
      const students = await seed(a);
      console.log("\nDemo logins (password for all: the DEMO_PASSWORD env var, default \"upcomer-demo\"):");
      for (const student of students) console.log(`  ${student.email.padEnd(40)} ${student.name}`);
      console.log(`  Password: ${DEMO_PASSWORD}`);
    }
    console.log("\nDatabase counts (total, demo):");
    for (const [name, value] of Object.entries(await counts(a))) console.log(`  ${name.padEnd(24)} ${value}`);
  } finally {
    await a.db.$disconnect();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
