import { describe, type Client } from "../client";
import { pdfBytes, result, type Context, type Feature } from "../context";

// Admin uploads, catalog saves, and file metadata saves, plus the same requests from a student or a visitor.

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const latestYear = () => new Date().getFullYear() + 1;

async function randomCourse(ctx: Context) {
  const courses = await ctx.db.course.findMany({ where: { NOT: { code: { startsWith: ctx.stamp } } }, select: { id: true, professors: { select: { professorId: true } } } });
  const course = ctx.rng.pick(courses);
  return { id: course.id, professorIds: course.professors.map(item => item.professorId) };
}

async function professorNotTeaching(ctx: Context, courseId: string) {
  const others = await ctx.db.professor.findMany({ where: { courses: { none: { courseId } } }, select: { id: true } });
  return others.length ? ctx.rng.pick(others).id : `${ctx.stamp.toLowerCase()}-no-professor`;
}

// A denied caller: a logged-in student or a visitor.
async function deniedCaller(ctx: Context): Promise<{ who: string; client: Client }> {
  return ctx.rng.chance(0.6) ? { who: "student", client: (await ctx.anyStudent()).client } : { who: "visitor", client: ctx.client() };
}

// ---------- Upload ----------

type UploadFields = { courseId: string; category: "EXAM" | "MATERIAL"; title: string; professorId?: string; year?: string; examType?: string; topic?: string };

function upload(client: Client, fields: UploadFields, file: { name: string; bytes: Buffer; type: string }) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) if (value !== undefined) form.append(name, value);
  form.append("file", new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
  return client.request("/api/admin/uploads", { method: "POST", body: form });
}

const reasonOf = (body: string) => {
  try {
    return (JSON.parse(body) as { reason?: string }).reason ?? "";
  } catch {
    return "";
  }
};

async function uploadFields(ctx: Context): Promise<UploadFields> {
  const course = await randomCourse(ctx);
  const category = ctx.rng.pick(["EXAM", "MATERIAL"] as const);
  return {
    courseId: course.id, category, title: ctx.name("upload"),
    professorId: course.professorIds.length && ctx.rng.chance(0.5) ? ctx.rng.pick(course.professorIds) : undefined,
    year: ctx.rng.chance(0.5) ? String(ctx.rng.int(1950, latestYear())) : undefined,
    examType: category === "EXAM" && ctx.rng.chance(0.5) ? ctx.rng.pick(["MIDTERM", "FINAL", "QUIZ", "OTHER"]) : undefined,
    topic: ctx.rng.chance(0.3) ? `Topic ${ctx.rng.letters(6)}` : undefined,
  };
}

// An upload the API should refuse: it answers with the status and reason, and no file record appears.
function refusedUpload(name: string, input: string, status: number, reason: string, build: (ctx: Context, fields: UploadFields) => Promise<{ fields: UploadFields; file: { name: string; bytes: Buffer; type: string }; client?: Client }>) {
  return {
    name, valid: false,
    async run(ctx: Context) {
      const built = await build(ctx, await uploadFields(ctx));
      const before = await ctx.db.courseFile.count();
      const reply = await upload(built.client ?? ctx.admin!, built.fields, built.file);
      const after = await ctx.db.courseFile.count();
      const actualReason = reasonOf(reply.body);
      return result(input, `${status} ${reason}, no file record`, `${reply.status} ${actualReason || "(no reason)"}, records ${before} → ${after}`,
        reply.status === status && actualReason === reason && after === before, reply.ms);
    },
  };
}

const pdf = (ctx: Context) => ({ name: `${ctx.rng.letters(6)}.pdf`, bytes: pdfBytes(ctx.stamp), type: "application/pdf" });
let largeFile: Buffer | undefined;

export const uploadFeature: Feature = {
  name: "Admin upload",
  needsAdmin: true,
  trials: [
    {
      name: "valid PDF", valid: true,
      async run(ctx) {
        const fields = await uploadFields(ctx);
        const file = pdf(ctx);
        const reply = await upload(ctx.admin!, fields, file);
        const id = reply.status === 201 ? (JSON.parse(reply.body) as { file: { id: string } }).file.id : "";
        if (id) ctx.uploadedFileIds.add(id);
        const record = id ? await ctx.db.courseFile.findUnique({ where: { id } }) : null;
        const served = id ? await ctx.client().get(`/files/${id}`) : undefined;
        const ok = Boolean(record) && record!.title === fields.title && record!.courseId === fields.courseId && record!.category === fields.category &&
          record!.year === (fields.year ? Number(fields.year) : null) && record!.professorId === (fields.professorId ?? null) && served?.status === 200 && served.bytes.equals(file.bytes);
        return result(`${fields.category} PDF with random optional fields`, "201, a matching record, and /files/<id> serves the same bytes",
          `${reply.status} ${reasonOf(reply.body)}${record ? ", record saved" : ", no record"}${served ? `, file ${served.status} ${served.bytes.equals(file.bytes) ? "same bytes" : "different bytes"}` : ""}`,
          reply.status === 201 && ok, reply.ms);
      },
    },
    refusedUpload("corrupt file", ".pdf whose bytes are not a PDF", 400, "content_mismatch", async (ctx, fields) => ({
      fields, file: { name: "exam.pdf", bytes: Buffer.from(ctx.rng.pick(["PDF-1.4 but no percent sign", "<html>not a pdf</html>", "\x89PNG\r\n\x1a\n"]) + ctx.rng.letters(50)), type: "application/pdf" },
    })),
    refusedUpload("wrong type", "a file with an unsupported extension", 415, "unsupported_type", async (ctx, fields) => ({
      fields, file: { name: `notes.${ctx.rng.pick(["exe", "txt", "html", "svg", "zip", "js", "pdf.exe", ""])}`, bytes: Buffer.from("%PDF-1.4 hidden"), type: "application/octet-stream" },
    })),
    refusedUpload("too large", "a PDF just over 20 MB", 413, "file_too_large", async (ctx, fields) => {
      largeFile ??= Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 0x20)]);
      return { fields, file: { name: "big.pdf", bytes: largeFile.subarray(0, MAX_UPLOAD_BYTES + ctx.rng.int(1, 1024)), type: "application/pdf" } };
    }),
    refusedUpload("empty file", "a .pdf of 0 bytes", 400, "empty_file", async (_ctx, fields) => ({ fields, file: { name: "empty.pdf", bytes: Buffer.alloc(0), type: "application/pdf" } })),
    refusedUpload("unknown course", "a valid PDF for a course that does not exist", 404, "course_not_found", async (ctx, fields) => ({
      fields: { ...fields, courseId: `${ctx.stamp.toLowerCase()}-no-course`, professorId: undefined }, file: pdf(ctx),
    })),
    refusedUpload("professor not teaching", "a valid PDF tagged with a professor who doesn't teach the course", 404, "professor_not_assigned", async (ctx, fields) => ({
      fields: { ...fields, professorId: await professorNotTeaching(ctx, fields.courseId) }, file: pdf(ctx),
    })),
    refusedUpload("non-admin", "a valid PDF from a student or a visitor", 403, "forbidden", async (ctx, fields) => ({ fields, file: pdf(ctx), client: (await deniedCaller(ctx)).client })),
  ],
};

// ---------- Catalog ----------

type Section = "courses" | "faculties" | "professors" | "terms";
const ACTION: Record<Section, "saveCourse" | "saveFaculty" | "saveProfessor" | "saveTerm"> = { courses: "saveCourse", faculties: "saveFaculty", professors: "saveProfessor", terms: "saveTerm" };

async function tableCount(ctx: Context, section: Section) {
  return { courses: () => ctx.db.course.count(), faculties: () => ctx.db.faculty.count(), professors: () => ctx.db.professor.count(), terms: () => ctx.db.term.count() }[section]();
}

function saveCatalog(ctx: Context, client: Client, section: Section, fields: Record<string, string | string[]>) {
  return client.postAction(`/admin/catalog/${section}`, ctx.actions[ACTION[section]], fields);
}

// A new stamped code that is valid once normalized: sometimes lower case or with a space, which the app removes.
function newCode(ctx: Context) {
  const code = `${ctx.stamp}${ctx.next()}`;
  if (ctx.rng.chance(0.3)) return code.toLowerCase();
  return ctx.rng.chance(0.3) ? `${code.slice(0, 2)} ${code.slice(2)}` : code;
}

// A refused catalog save: the expected error in the redirect, and no new row.
function refusedCatalog(name: string, input: string, section: Section, error: string, build: (ctx: Context) => Promise<Record<string, string | string[]>>) {
  return {
    name, valid: false,
    async run(ctx: Context) {
      const fields = await build(ctx);
      const before = await tableCount(ctx, section);
      const reply = await saveCatalog(ctx, ctx.admin!, section, fields);
      const after = await tableCount(ctx, section);
      return result(input, `303 → /admin/catalog/${section}?error=${error}, no new ${section} row`, `${describe(reply)}, ${section} ${before} → ${after}`,
        reply.status === 303 && reply.location.startsWith(`/admin/catalog/${section}?error=${error}`) && after === before, reply.ms);
    },
  };
}

async function courseFields(ctx: Context) {
  const faculties = await ctx.db.faculty.findMany({ select: { id: true } });
  const professors = await ctx.db.professor.findMany({ select: { id: true } });
  return { code: newCode(ctx), name: ctx.name("Course"), facultyId: ctx.rng.pick(faculties).id, professorIds: ctx.rng.subset(professors).map(item => item.id) };
}

export const catalogFeature: Feature = {
  name: "Catalog save",
  needsAdmin: true,
  trials: [
    {
      name: "valid course", valid: true,
      async run(ctx) {
        const fields = await courseFields(ctx);
        const reply = await saveCatalog(ctx, ctx.admin!, "courses", fields);
        const code = fields.code.replace(/\s+/g, "").toUpperCase();
        const course = await ctx.db.course.findUnique({ where: { code }, include: { professors: true } });
        const professorsMatch = course && course.professors.map(item => item.professorId).sort().join() === [...fields.professorIds].sort().join();
        return result("new stamped code (random case/space), name, faculty, random professors", "303 → /admin/catalog/courses?saved=1, the course saved as entered",
          `${describe(reply)}, ${course ? `saved${professorsMatch && course.facultyId === fields.facultyId ? "" : " with different faculty/professors"}` : "not saved"}`,
          reply.location === "/admin/catalog/courses?saved=1" && Boolean(course) && course!.name === fields.name && course!.facultyId === fields.facultyId && Boolean(professorsMatch), reply.ms);
      },
    },
    {
      name: "valid faculty, professor, or term", valid: true,
      async run(ctx) {
        const section = ctx.rng.pick(["faculties", "professors", "terms"] as const);
        const name = ctx.name(section);
        const code = section === "faculties" ? `${ctx.stamp}${ctx.next()}` : "";
        const reply = await saveCatalog(ctx, ctx.admin!, section, section === "faculties" ? { code, name } : { name });
        const saved = section === "faculties" ? await ctx.db.faculty.count({ where: { code, name } })
          : section === "professors" ? await ctx.db.professor.count({ where: { name } }) : await ctx.db.term.count({ where: { name } });
        return result(`a new stamped ${{ faculties: "faculty", professors: "professor", terms: "term" }[section]}`, `303 → /admin/catalog/${section}?saved=1, one row saved`,
          `${describe(reply)}, ${saved} row(s)`, reply.location === `/admin/catalog/${section}?saved=1` && saved === 1, reply.ms);
      },
    },
    refusedCatalog("duplicate course code", "an existing course's code in random case, sometimes spaced", "courses", "duplicate_code", async ctx => {
      const existing = ctx.rng.pick(await ctx.db.course.findMany({ select: { code: true } })).code;
      const code = ctx.rng.chance(0.5) ? ctx.rng.mixCase(existing) : `${existing.slice(0, 2)} ${existing.slice(2)}`.toLowerCase();
      return { ...(await courseFields(ctx)), code };
    }),
    refusedCatalog("duplicate term", "an existing term's name in random case", "terms", "duplicate_name", async ctx => {
      let term = await ctx.db.term.findFirst({ select: { name: true } });
      if (!term) {
        await saveCatalog(ctx, ctx.admin!, "terms", { name: ctx.name("terms") });
        term = await ctx.db.term.findFirstOrThrow({ select: { name: true } });
      }
      return { name: ctx.rng.mixCase(term.name) };
    }),
    refusedCatalog("invalid course fields", "a bad code, a blank or 121+ character name, or no faculty", "courses", "invalid_fields", async ctx => {
      const fields = await courseFields(ctx);
      const flaw = ctx.rng.pick(["symbols", "long code", "short code", "blank name", "long name", "no faculty"]);
      if (flaw === "symbols") return { ...fields, code: `${ctx.stamp}-${ctx.next()}!` };
      if (flaw === "long code") return { ...fields, code: `${ctx.stamp}${"X".repeat(20)}` };
      if (flaw === "short code") return { ...fields, code: ctx.rng.pick(["A", "", " "]) };
      if (flaw === "blank name") return { ...fields, name: ctx.rng.pick(["", "   "]) };
      if (flaw === "long name") return { ...fields, name: `${ctx.stamp} ${"n".repeat(121)}` };
      return { ...fields, facultyId: "" };
    }),
    refusedCatalog("invalid faculty fields", "a faculty with a bad or missing code, or a blank name", "faculties", "invalid_fields", async ctx => (
      ctx.rng.pick([{ code: `${ctx.stamp}_${ctx.next()}`, name: ctx.name("faculties") }, { code: `${ctx.stamp}${ctx.next()}`, name: " " }, { code: "", name: ctx.name("faculties") }])
    )),
    refusedCatalog("unknown faculty", "a valid course whose faculty does not exist", "courses", "unknown_faculty", async ctx => ({ ...(await courseFields(ctx)), facultyId: `${ctx.stamp.toLowerCase()}-no-faculty` })),
    refusedCatalog("unknown professor", "a valid course with a professor who does not exist", "courses", "unknown_professor", async ctx => {
      const fields = await courseFields(ctx);
      return { ...fields, professorIds: [...fields.professorIds, `${ctx.stamp.toLowerCase()}-no-professor`] };
    }),
    {
      name: "student or visitor denied", valid: false,
      async run(ctx) {
        const { who, client } = await deniedCaller(ctx);
        const before = await ctx.db.course.count();
        const reply = await saveCatalog(ctx, client, "courses", await courseFields(ctx));
        const after = await ctx.db.course.count();
        const refused = who === "student" ? reply.status === 404 : [303, 307].includes(reply.status) && reply.location.startsWith("/login");
        return result(`a valid course saved by a ${who}`, who === "student" ? "404, nothing saved" : "redirect to /login, nothing saved",
          `${describe(reply)}, courses ${before} → ${after}`, refused && after === before, reply.ms);
      },
    },
  ],
};

// ---------- File metadata ----------

const metadataRow = (ctx: Context, id: string) => ctx.db.courseFile.findUniqueOrThrow({ where: { id }, select: { courseId: true, professorId: true, termId: true, year: true, topic: true, examType: true } });

function saveMetadata(ctx: Context, client: Client, fields: Record<string, string>) {
  return client.postAction(`/admin/files/${encodeURIComponent(fields.id)}`, ctx.actions.saveFileMetadata, fields);
}

async function metadataFields(ctx: Context, category: "EXAM" | "MATERIAL") {
  const course = await randomCourse(ctx);
  const terms = await ctx.db.term.findMany({ select: { id: true } });
  return {
    id: category === "EXAM" ? ctx.fixtures.examFileId : ctx.fixtures.materialFileId, courseId: course.id,
    professorId: course.professorIds.length && ctx.rng.chance(0.6) ? ctx.rng.pick(course.professorIds) : "",
    year: ctx.rng.chance(0.6) ? String(ctx.rng.int(1950, latestYear())) : "",
    termId: terms.length && ctx.rng.chance(0.5) ? ctx.rng.pick(terms).id : "",
    examType: category === "EXAM" && ctx.rng.chance(0.6) ? ctx.rng.pick(["MIDTERM", "FINAL", "QUIZ", "OTHER"]) : "",
    topic: ctx.rng.chance(0.5) ? `Topic ${ctx.rng.letters(ctx.rng.int(1, 40))}` : "",
  };
}

// A refused metadata save: the expected error in the redirect, and the stored values unchanged.
function refusedMetadata(name: string, input: string, error: string, build: (ctx: Context) => Promise<Record<string, string>>) {
  return {
    name, valid: false,
    async run(ctx: Context) {
      const fields = await build(ctx);
      const before = JSON.stringify(await metadataRow(ctx, fields.id));
      const reply = await saveMetadata(ctx, ctx.admin!, fields);
      const unchanged = JSON.stringify(await metadataRow(ctx, fields.id)) === before;
      return result(input, `303 → /admin/files/<id>?error=${error}, stored values unchanged`, `${describe(reply)}, values ${unchanged ? "unchanged" : "CHANGED"}`,
        reply.status === 303 && reply.location === `/admin/files/${encodeURIComponent(fields.id)}?error=${error}` && unchanged, reply.ms);
    },
  };
}

export const metadataFeature: Feature = {
  name: "File metadata save",
  needsAdmin: true,
  trials: [
    {
      name: "valid", valid: true,
      async run(ctx) {
        const fields = await metadataFields(ctx, ctx.rng.pick(["EXAM", "MATERIAL"] as const));
        const reply = await saveMetadata(ctx, ctx.admin!, fields);
        const row = await metadataRow(ctx, fields.id);
        const stored = row.courseId === fields.courseId && row.professorId === (fields.professorId || null) && row.termId === (fields.termId || null) &&
          row.year === (fields.year ? Number(fields.year) : null) && row.topic === (fields.topic || null) && row.examType === (fields.examType || null);
        return result("a course, and random valid professor, year, term, type, and topic", `303 → /admin/files?courseId=<course>&saved=1, values stored`,
          `${describe(reply)}, values ${stored ? "stored" : "NOT stored as sent"}`,
          reply.location === `/admin/files?${new URLSearchParams({ courseId: fields.courseId, saved: "1" })}` && stored, reply.ms);
      },
    },
    refusedMetadata("no course", "no course chosen", "course_required", async ctx => ({ ...(await metadataFields(ctx, "EXAM")), courseId: ctx.rng.pick(["", "  "]) })),
    refusedMetadata("professor not teaching", "a professor who doesn't teach the chosen course", "professor_not_assigned", async ctx => {
      const fields = await metadataFields(ctx, "EXAM");
      return { ...fields, professorId: await professorNotTeaching(ctx, fields.courseId) };
    }),
    refusedMetadata("invalid year", "a year that is not a 4-digit year in range", "invalid_year", async ctx => ({
      ...(await metadataFields(ctx, "EXAM")), year: ctx.rng.pick(["1800", "1949", "20x5", "99", "12345", String(latestYear() + ctx.rng.int(1, 50)), "-2020", "2020.5"]),
    })),
    refusedMetadata("topic too long", "a topic of 101+ characters", "topic_too_long", async ctx => ({ ...(await metadataFields(ctx, "EXAM")), topic: ctx.rng.letters(ctx.rng.int(101, 300)) })),
    refusedMetadata("invalid exam type", "a type that is not Midterm, Final, Quiz, or Other", "invalid_type", async ctx => ({
      ...(await metadataFields(ctx, "EXAM")), examType: ctx.rng.pick(["ESSAY", "final", "0", "<b>"]),
    })),
    refusedMetadata("type on a material", "an exam type on a material", "type_not_allowed", async ctx => ({ ...(await metadataFields(ctx, "MATERIAL")), examType: "FINAL" })),
    refusedMetadata("unknown course", "a course that does not exist", "course_not_found", async ctx => ({ ...(await metadataFields(ctx, "EXAM")), courseId: `${ctx.stamp.toLowerCase()}-no-course`, professorId: "" })),
    {
      name: "student or visitor denied", valid: false,
      async run(ctx) {
        const { who, client } = await deniedCaller(ctx);
        const fields = await metadataFields(ctx, "EXAM");
        const before = JSON.stringify(await metadataRow(ctx, fields.id));
        const reply = await saveMetadata(ctx, client, fields);
        const unchanged = JSON.stringify(await metadataRow(ctx, fields.id)) === before;
        const refused = who === "student" ? reply.status === 404 : [303, 307].includes(reply.status) && reply.location.startsWith("/login");
        return result(`valid details saved by a ${who}`, who === "student" ? "404, values unchanged" : "redirect to /login, values unchanged",
          `${describe(reply)}, values ${unchanged ? "unchanged" : "CHANGED"}`, refused && unchanged, reply.ms);
      },
    },
  ],
};
