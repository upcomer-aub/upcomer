import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Member 1's independent cross-test of Member 5's uploads (US-70, US-71), run against current main.
// Only the database, the session cookie and (for one case) unlink are faked. The route, the upload service,
// the metadata checks, the auth check, the storage folder and Member 3's file route are all the real code.
// Set M5_CALL_LOG=<file> to write every API call and its response to a JSON file for the cross-test report.

const fake = vi.hoisted(() => {
  const courses = [
    { id: "course-b", code: "EECE 351", name: "Operating Systems", professors: ["prof-b"] },
    { id: "course-a", code: "EECE 350", name: "Computer Networks", professors: ["prof-a"] },
  ];
  const professorNames: Record<string, string> = { "prof-a": "Dr. A", "prof-b": "Dr. B" };
  const users: Record<string, { user: { id: string; role: string }; expiresAt: Date }> = {
    "admin-token": { user: { id: "admin-1", role: "ADMIN" }, expiresAt: new Date(Date.now() + 3_600_000) },
    "student-token": { user: { id: "student-1", role: "STUDENT" }, expiresAt: new Date(Date.now() + 3_600_000) },
    "expired-admin-token": { user: { id: "admin-2", role: "ADMIN" }, expiresAt: new Date(Date.now() - 1000) },
  };
  const state = {
    token: "admin-token" as string | undefined,
    files: new Map<string, Record<string, unknown>>(),
    nextId: 1,
    idOverride: undefined as string | undefined,
    failCreate: false, failCourseLookup: false, failCourseList: false, failSession: false, failUnlink: false,
  };
  const db = {
    session: {
      findUnique: vi.fn(async () => {
        if (state.failSession) throw new Error("session db down");
        const entry = state.token ? users[state.token] : undefined;
        return entry ? { id: `session-${entry.user.id}`, userId: entry.user.id, expiresAt: entry.expiresAt, user: entry.user } : null;
      }),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    course: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (state.failCourseLookup) throw new Error("connect ECONNREFUSED postgres://admin:secret@db");
        return courses.some(course => course.id === where.id) ? { id: where.id } : null;
      }),
      findMany: vi.fn(async () => {
        if (state.failCourseList) throw new Error("db down");
        return [...courses].sort((a, b) => a.code.localeCompare(b.code))
          .map(({ professors, ...course }) => ({ ...course, professors: professors.map(id => ({ professor: { id, name: professorNames[id] } })) }));
      }),
    },
    courseProfessor: {
      findUnique: vi.fn(async ({ where }: { where: { courseId_professorId: { courseId: string; professorId: string } } }) => {
        const { courseId, professorId } = where.courseId_professorId;
        return courses.find(course => course.id === courseId)?.professors.includes(professorId) ? { courseId } : null;
      }),
    },
    term: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === "term-fall" ? { id: "term-fall" } : null)) },
    courseFile: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (state.failCreate) throw Object.assign(new Error("unique constraint"), { name: "PrismaClientKnownRequestError", code: "P2002" });
        const record = { id: state.idOverride ?? `file-${state.nextId++}`, ...data };
        state.files.set(record.id, record);
        return record;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.files.get(where.id) ?? null),
    },
  };
  return { state, db };
});

vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (fake.state.token ? { value: fake.state.token } : undefined) }) }));
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>();
  const unlink = (...args: Parameters<typeof real.unlink>) =>
    fake.state.failUnlink ? Promise.reject(Object.assign(new Error("busy"), { code: "EBUSY" })) : real.unlink(...args);
  return { ...real, default: { ...real, unlink }, unlink };
});

import { POST } from "@/app/api/admin/uploads/route";
import { GET } from "@/app/files/[fileId]/route";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-rules";
import { getUploadOptions, parseUploadForm, validateUploadFile } from "@/lib/uploads";

const bytes = {
  pdf: Buffer.from("%PDF-1.4\n% cross-test exam\n"),
  zip: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]),
  docx: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("[Content_Types].xml word/document.xml")]),
  pptx: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("[Content_Types].xml ppt/presentation.xml")]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
  jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
};

type Call = { test: string; request: string; status: number; response: unknown; logs: string[] };
const calls: Call[] = [];
let currentTest = "";
let errors: ReturnType<typeof vi.spyOn>;
const logged = (): Record<string, string>[] => errors.mock.calls.map(call => JSON.parse(String(call[0])));
const events = () => logged().map(line => line.event);

let root: string;
const originalRoot = process.env.FILE_STORAGE_ROOT;
const storedFiles = async () => (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());

function form(fields: Record<string, string> = {}, file: File | string | null = new File([bytes.pdf], "final.pdf")) {
  const data = new FormData();
  for (const [name, value] of Object.entries({ category: "EXAM", courseId: "course-a", title: "Final Exam", ...fields })) data.set(name, value);
  if (file !== null) data.set("file", file);
  return data;
}

function describeForm(data: FormData) {
  return [...data.entries()].map(([name, value]) => {
    if (typeof value !== "string") return `${name}=<file ${value.name}, ${value.size} B, type "${value.type}">`;
    return `${name}=${value.length > 40 ? `${JSON.stringify(value.slice(0, 20))}…(${value.length} chars)` : JSON.stringify(value)}`;
  }).join(" ");
}

async function record(request: string, response: Response) {
  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("json") ? await response.clone().json()
    : type.includes("text/html") ? "<html: File unavailable page>"
    : `<${type}, ${(await response.clone().arrayBuffer()).byteLength} B, ${response.headers.get("content-disposition")}>`;
  calls.push({ test: currentTest, request, status: response.status, response: body, logs: events() });
  return response;
}

async function upload(data: FormData | null, init: { headers?: Record<string, string>; body?: string } = {}) {
  const request = new Request("http://localhost/api/admin/uploads", { method: "POST", body: data ?? init.body, headers: init.headers });
  const label = `POST /api/admin/uploads [${fake.state.token ?? "no session"}] ${data ? describeForm(data) : `headers=${JSON.stringify(init.headers ?? {})} body=${JSON.stringify(init.body)}`}`;
  return record(label, await POST(request));
}

async function open(fileId: string) {
  return record(`GET /files/${fileId}`, await GET(new Request(`http://localhost/files/${fileId}`), { params: Promise.resolve({ fileId }) }));
}

beforeEach(async ctx => {
  currentTest = ctx.task.name;
  vi.clearAllMocks();
  root = await mkdtemp(path.join(os.tmpdir(), "upcomer-m5-cross-"));
  process.env.FILE_STORAGE_ROOT = root;
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  Object.assign(fake.state, { token: "admin-token", nextId: 1, idOverride: undefined, failCreate: false, failCourseLookup: false, failCourseList: false, failSession: false, failUnlink: false });
  fake.state.files.clear();
});
afterEach(async () => {
  errors.mockRestore();
  await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  if (originalRoot === undefined) delete process.env.FILE_STORAGE_ROOT;
  else process.env.FILE_STORAGE_ROOT = originalRoot;
  if (process.env.M5_CALL_LOG) await writeFile(process.env.M5_CALL_LOG, JSON.stringify(calls, null, 2));
});

describe("A. POST /api/admin/uploads — access control", () => {
  it("A-01 logged-out visitor gets 403 and nothing is stored", async () => {
    fake.state.token = undefined;
    const response = await upload(form());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ reason: "forbidden", error: "Only an admin can upload files." });
    expect(await storedFiles()).toEqual([]);
    expect(logged()).toContainEqual(expect.objectContaining({ event: "unauthorized_access", route: "POST /api/admin/uploads", role: "anonymous" }));
  });
  it("A-02 logged-in student gets 403 and nothing is stored", async () => {
    fake.state.token = "student-token";
    const response = await upload(form());
    expect(response.status).toBe(403);
    expect(await storedFiles()).toEqual([]);
    expect(fake.db.courseFile.create).not.toHaveBeenCalled();
    expect(logged()).toContainEqual(expect.objectContaining({ event: "unauthorized_access", role: "STUDENT", userId: "student-1" }));
  });
  it("A-03 admin with an expired session gets 403", async () => {
    fake.state.token = "expired-admin-token";
    expect((await upload(form())).status).toBe(403);
    expect(events()).toEqual(expect.arrayContaining(["session_validation_failed", "unauthorized_access"]));
  });
  it("A-04 unknown session token gets 403", async () => {
    fake.state.token = "forged-token";
    expect((await upload(form())).status).toBe(403);
  });
  it("A-05 session lookup failure fails closed with 403", async () => {
    fake.state.failSession = true;
    expect((await upload(form())).status).toBe(403);
    expect(await storedFiles()).toEqual([]);
  });
  it("A-06 a student's oversized request is 403, not 413 (auth is checked first)", async () => {
    fake.state.token = "student-token";
    expect((await upload(null, { headers: { "content-length": String(50 * 1024 * 1024) }, body: "x" })).status).toBe(403);
  });
});

describe("B. POST /api/admin/uploads — request handling", () => {
  it("B-01 Content-Length over 20 MB + 1 MB overhead is refused with 413 before the body is read", async () => {
    const response = await upload(null, { headers: { "content-length": String(MAX_UPLOAD_BYTES + 1024 * 1024 + 1) }, body: "x" });
    expect(response.status).toBe(413);
    expect((await response.json()).reason).toBe("file_too_large");
    expect(logged()).toContainEqual(expect.objectContaining({ event: "upload_rejected", reason: "file_too_large" }));
  });
  it("B-02 Content-Length exactly at the limit passes the size gate", async () => {
    const response = await upload(null, { headers: { "content-length": String(MAX_UPLOAD_BYTES + 1024 * 1024) }, body: "x" });
    expect(response.status).not.toBe(413);
  });
  it("B-03 a JSON body is refused with 400 invalid_form", async () => {
    const response = await upload(null, { headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) });
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toBe("invalid_form");
  });
  it("B-05 a streamed body with no Content-Length stops being read at the limit and gets 413", async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull: controller => {
        if (cancelled) return;
        pulled += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel: () => { cancelled = true; },
    });
    const request = new Request("http://localhost/api/admin/uploads", { method: "POST", body: endless, headers: { "content-type": "multipart/form-data; boundary=x" }, duplex: "half" } as RequestInit);
    const response = await record("POST /api/admin/uploads [admin-token] endless 1 MB chunks, no Content-Length", await POST(request));
    expect(response.status).toBe(413);
    expect((await response.json()).reason).toBe("file_too_large");
    expect(pulled).toBeLessThan(30);
    expect(cancelled).toBe(true);
  });
  it("B-04 a non-numeric Content-Length header does not crash the route", async () => {
    const response = await upload(null, { headers: { "content-length": "abc", "content-type": "text/plain" }, body: "x" });
    expect(response.status).toBe(400);
  });
});

describe("C. POST /api/admin/uploads — form fields", () => {
  it("C-01 valid exam with every optional field returns 201 and the file link", async () => {
    const response = await upload(form({ professorId: "prof-a", termId: "term-fall", year: "2025", examType: "FINAL", topic: "Routing" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ file: { id: "file-1", title: "Final Exam", category: "EXAM", courseId: "course-a", url: "/files/file-1" } });
    expect(fake.state.files.get("file-1")).toMatchObject({ professorId: "prof-a", termId: "term-fall", year: 2025, examType: "FINAL", topic: "Routing", category: "EXAM" });
    expect(errors).not.toHaveBeenCalled();
  });
  it("C-02 valid material with only required fields returns 201", async () => {
    const response = await upload(form({ category: "MATERIAL", title: "Lecture 1" }, new File([bytes.pptx], "lecture1.pptx")));
    expect(response.status).toBe(201);
    expect(fake.state.files.get("file-1")).toMatchObject({ category: "MATERIAL", storageKey: expect.stringMatching(/^materials\/[0-9a-f-]{36}\.pptx$/) });
  });
  it.each([
    ["C-03 missing category", { category: "" }, "invalid_fields"],
    ["C-04 lowercase category", { category: "exam" }, "invalid_fields"],
    ["C-05 unknown category", { category: "HOMEWORK" }, "invalid_fields"],
    ["C-06 missing course", { courseId: "" }, "course_required"],
    ["C-07 missing title", { title: "" }, "invalid_fields"],
    ["C-08 whitespace-only title", { title: "   " }, "invalid_fields"],
    ["C-09 title of 151 characters", { title: "t".repeat(151) }, "invalid_fields"],
    ["C-10 year 1949", { year: "1949" }, "invalid_year"],
    ["C-11 two-digit year", { year: "25" }, "invalid_year"],
    ["C-12 year two years ahead", { year: String(new Date().getFullYear() + 2) }, "invalid_year"],
    ["C-13 decimal year", { year: "2025.0" }, "invalid_year"],
    ["C-14 topic of 101 characters", { topic: "x".repeat(101) }, "topic_too_long"],
    ["C-15 lowercase exam type", { examType: "final" }, "invalid_type"],
    ["C-16 exam type on a material", { category: "MATERIAL", examType: "FINAL" }, "type_not_allowed"],
    ["C-17 unknown term", { termId: "term-nope" }, "term_not_found"],
  ])("%s is refused with 400", async (_name, fields, reason) => {
    const response = await upload(form(fields));
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toBe(reason);
    expect(await storedFiles()).toEqual([]);
    expect(fake.db.courseFile.create).not.toHaveBeenCalled();
    expect(logged()).toContainEqual(expect.objectContaining({ event: "upload_rejected", reason }));
  });
  it.each([
    ["C-18 professor from another course", "prof-b"],
    ["C-19 professor that does not exist", "prof-ghost"],
  ])("%s is refused with 404, as the Sprint 1 plan says", async (_name, professorId) => {
    const response = await upload(form({ professorId }));
    expect(response.status).toBe(404);
    expect((await response.json()).reason).toBe("professor_not_assigned");
    expect(await storedFiles()).toEqual([]);
    expect(fake.db.courseFile.create).not.toHaveBeenCalled();
  });
  it("C-20 unknown course is refused with 404", async () => {
    const response = await upload(form({ courseId: "course-ghost" }));
    expect(response.status).toBe(404);
    expect((await response.json()).reason).toBe("course_not_found");
    expect(await storedFiles()).toEqual([]);
  });
  it.each([
    ["C-21 title of exactly 150 characters", { title: "t".repeat(150) }],
    ["C-22 year 1950", { year: "1950" }],
    ["C-23 next year", { year: String(new Date().getFullYear() + 1) }],
    ["C-24 topic of exactly 100 characters", { topic: "x".repeat(100) }],
    ["C-25 padded fields are trimmed", { title: "  Midterm  ", year: " 2024 ", courseId: " course-a " }],
  ])("%s is accepted", async (_name, fields) => {
    expect((await upload(form(fields))).status).toBe(201);
  });
  it("C-26 file sent as a text field is refused with 400", async () => {
    const response = await upload(form({}, "not-a-file"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ reason: "invalid_fields", error: "Choose a file to upload." });
  });
  it("C-27 missing file is refused with 400", async () => {
    expect((await upload(form({}, null))).status).toBe(400);
  });
  it("C-28 rejection logs never contain the title, file name or a long course ID", async () => {
    await upload(form({ title: "SECRET-TITLE", courseId: "c".repeat(500) }, new File([bytes.pdf], "SECRET-NAME.pdf")));
    const text = JSON.stringify(logged());
    expect(text).not.toContain("SECRET-TITLE");
    expect(text).not.toContain("SECRET-NAME");
    expect(logged().find(line => line.event === "upload_rejected")?.courseId).toHaveLength(100);
  });
});

describe("D. POST /api/admin/uploads — file checks", () => {
  it.each([
    ["D-01 .exe", "setup.exe", bytes.pdf, 415, "unsupported_type"],
    ["D-02 no extension", "README", bytes.pdf, 415, "unsupported_type"],
    ["D-03 double extension .pdf.exe", "exam.pdf.exe", bytes.pdf, 415, "unsupported_type"],
    ["D-04 .html", "page.html", Buffer.from("<html></html>"), 415, "unsupported_type"],
    ["D-05 empty .pdf", "empty.pdf", Buffer.alloc(0), 400, "empty_file"],
    ["D-06 HTML renamed to .pdf", "fake.pdf", Buffer.from("<html><script>alert(1)</script></html>"), 400, "content_mismatch"],
    ["D-07 PDF renamed to .docx", "fake.docx", bytes.pdf, 400, "content_mismatch"],
    ["D-08 JPEG renamed to .png", "fake.png", bytes.jpg, 400, "content_mismatch"],
    ["D-09 truncated PDF header", "short.pdf", Buffer.from("%PD"), 400, "content_mismatch"],
  ])("%s is refused", async (_name, fileName, content, status, reason) => {
    const response = await upload(form({}, new File([content], fileName)));
    expect(response.status).toBe(status);
    expect((await response.json()).reason).toBe(reason);
    expect(await storedFiles()).toEqual([]);
  });
  it("D-10 a file over the request limit without a Content-Length header is refused with 413", async () => {
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1024 * 1024 + 1);
    big.set(bytes.pdf);
    // Sent as raw multipart bytes, like a network client: undici's own FormData body stream errors when cancelled.
    const encoded = new Response(form({}, new File([big], "big.pdf")));
    const body = new Uint8Array(await encoded.arrayBuffer());
    const request = new Request("http://localhost/api/admin/uploads", { method: "POST", body, headers: { "content-type": encoded.headers.get("content-type")! } });
    expect(request.headers.get("content-length")).toBeNull();
    const response = await record(`POST /api/admin/uploads [admin-token] multipart bytes with file=<file big.pdf, ${big.length} B>, no Content-Length`, await POST(request));
    expect(response.status).toBe(413);
    expect(await storedFiles()).toEqual([]);
  });
  it("D-11 a file of exactly 20 MB is accepted", async () => {
    const max = new Uint8Array(MAX_UPLOAD_BYTES);
    max.set(bytes.pdf);
    expect((await upload(form({}, new File([max], "max.pdf")))).status).toBe(201);
  });
  it("D-12 the browser's MIME type is ignored; the stored type comes from the checked extension", async () => {
    await upload(form({}, new File([bytes.pdf], "exam.pdf", { type: "text/html" })));
    expect(fake.state.files.get("file-1")).toMatchObject({ mimeType: "application/pdf" });
  });
  it("D-13 an uppercase extension is accepted and stored with a lowercase key", async () => {
    await upload(form({}, new File([bytes.pdf], "EXAM.PDF")));
    expect(fake.state.files.get("file-1")).toMatchObject({ originalFileName: "EXAM.PDF", storageKey: expect.stringMatching(/^exams\/[0-9a-f-]{36}\.pdf$/) });
  });
  it.each([
    ["D-14 Unix path traversal in the file name", "../../../etc/evil.pdf"],
    ["D-15 Windows path traversal in the file name", "..\\..\\Windows\\evil.pdf"],
  ])("%s cannot escape the storage folder", async (_name, fileName) => {
    expect((await upload(form({}, new File([bytes.pdf], fileName)))).status).toBe(201);
    const stored = await storedFiles();
    expect(stored).toHaveLength(1);
    expect(path.resolve(stored[0].parentPath, stored[0].name).startsWith(path.resolve(root) + path.sep)).toBe(true);
    expect(fake.state.files.get("file-1")).toMatchObject({ originalFileName: "evil.pdf" });
  });
  it.each([
    ["D-16 a plain ZIP renamed to .docx", "archive-renamed.docx", bytes.zip],
    ["D-17 a DOCX renamed to .pptx", "notes-renamed.pptx", bytes.docx],
  ])("%s is refused as corrupt", async (_name, fileName, content) => {
    const response = await upload(form({}, new File([content], fileName)));
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toBe("content_mismatch");
    expect(await storedFiles()).toEqual([]);
  });
});

describe("E. POST /api/admin/uploads — storage and record failures", () => {
  it("E-01 a storage write failure returns 500, logs once with the error code, and creates no record", async () => {
    const blocker = path.join(root, "not-a-folder");
    await writeFile(blocker, "x");
    process.env.FILE_STORAGE_ROOT = blocker;
    const response = await upload(form());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ reason: "storage_failed", error: "The file could not be stored. Please try again." });
    expect(fake.db.courseFile.create).not.toHaveBeenCalled();
    expect(events()).toEqual(["upload_storage_failed"]);
    expect(logged()[0].errorCode).toMatch(/^E[A-Z]+$/);
  });
  it("E-02 a database record failure returns 500 and deletes the stored file", async () => {
    fake.state.failCreate = true;
    const response = await upload(form());
    expect(response.status).toBe(500);
    expect((await response.json()).reason).toBe("record_failed");
    expect(await storedFiles()).toEqual([]);
    expect(events()).toEqual(["upload_record_failed"]);
  });
  it("E-03 when cleanup also fails, both failures are logged (the orphan file stays)", async () => {
    fake.state.failCreate = true;
    fake.state.failUnlink = true;
    expect((await upload(form())).status).toBe(500);
    expect(events()).toEqual(["upload_cleanup_failed", "upload_record_failed"]);
    expect(await storedFiles()).toHaveLength(1);
  });
  it("E-04 an unexpected database error returns a generic 500 without leaking details", async () => {
    fake.state.failCourseLookup = true;
    const response = await upload(form());
    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("secret");
    expect(body).toContain("upload_failed");
    expect(JSON.stringify(logged())).not.toContain("secret");
    expect(logged()).toContainEqual(expect.objectContaining({ event: "upload_failed", courseId: "course-a", resourceCategory: "EXAM", errorType: "Error" }));
    expect(await storedFiles()).toEqual([]);
  });
  it("E-05 two uploads with the same file name get different storage keys and both survive", async () => {
    await upload(form({}, new File([bytes.pdf], "same.pdf")));
    await upload(form({}, new File([Buffer.concat([bytes.pdf, Buffer.from("v2")])], "same.pdf")));
    expect(await storedFiles()).toHaveLength(2);
    expect(fake.state.files.get("file-1")?.storageKey).not.toBe(fake.state.files.get("file-2")?.storageKey);
  });
  it("E-06 the returned link URL-encodes the file ID", async () => {
    fake.state.idOverride = "file 9/x";
    expect((await (await upload(form())).json()).file.url).toBe("/files/file%209%2Fx");
  });
});

describe("F. Upload then GET /files/:fileId — file retrievable after upload", () => {
  it.each([
    ["F-01 PDF exam", "exam.pdf", "EXAM", bytes.pdf, "application/pdf", "inline"],
    ["F-02 DOCX material", "notes.docx", "MATERIAL", bytes.docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "attachment"],
    ["F-03 PPTX material", "slides.pptx", "MATERIAL", bytes.pptx, "application/vnd.openxmlformats-officedocument.presentationml.presentation", "attachment"],
    ["F-04 PNG exam", "scan.png", "EXAM", bytes.png, "image/png", "attachment"],
    ["F-05 JPG exam", "scan.jpg", "EXAM", bytes.jpg, "image/jpeg", "attachment"],
  ])("%s opens byte-for-byte with the right headers", async (_name, fileName, category, content, mimeType, disposition) => {
    const created = await upload(form({ category }, new File([content], fileName)));
    expect(created.status).toBe(201);
    const { file } = await created.json();
    const opened = await open(file.id);
    expect(opened.status).toBe(200);
    expect(opened.headers.get("content-type")).toBe(mimeType);
    expect(opened.headers.get("content-disposition")).toBe(`${disposition}; filename="${fileName}"`);
    expect(opened.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await opened.arrayBuffer())).toEqual(content);
  });
  it("F-06 a refused upload leaves no file to open", async () => {
    await upload(form({}, new File([Buffer.from("<html>")], "fake.pdf")));
    expect((await open("file-1")).status).toBe(404);
  });
  it("F-07 a file deleted from storage after upload shows the 404 page, not an error", async () => {
    const { file } = await (await upload(form())).json();
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    expect((await open(file.id)).status).toBe(404);
  });
});

describe("G. getUploadOptions — course list for the upload form", () => {
  it("G-01 returns courses ordered by code with their professors flattened", async () => {
    expect(await getUploadOptions()).toEqual([
      { id: "course-a", code: "EECE 350", name: "Computer Networks", professors: [{ id: "prof-a", name: "Dr. A" }] },
      { id: "course-b", code: "EECE 351", name: "Operating Systems", professors: [{ id: "prof-b", name: "Dr. B" }] },
    ]);
    expect(fake.db.course.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { code: "asc" } }));
  });
  it("G-02 a database failure is logged and rethrown for the error page", async () => {
    fake.state.failCourseList = true;
    await expect(getUploadOptions()).rejects.toThrow("db down");
    expect(logged()).toEqual([expect.objectContaining({ event: "upload_options_retrieval_failed", errorType: "Error" })]);
  });
});

describe("H. validateUploadFile and parseUploadForm — direct calls", () => {
  it("H-01 an empty .exe is reported as unsupported (type is checked before size)", () => {
    expect(() => validateUploadFile("x.exe", new Uint8Array())).toThrow(expect.objectContaining({ reason: "unsupported_type", status: 415 }));
  });
  it("H-02 a 2-byte JPEG is reported as corrupt, not crashed on", () => {
    expect(() => validateUploadFile("x.jpg", new Uint8Array([0xff, 0xd8]))).toThrow(expect.objectContaining({ reason: "content_mismatch" }));
  });
  it("H-03 parseUploadForm uses the given clock for the year limit", () => {
    const now = new Date("2030-06-01T00:00:00Z");
    expect(parseUploadForm(form({ year: "2031" }), now)).toMatchObject({ year: 2031 });
    expect(() => parseUploadForm(form({ year: "2032" }), now)).toThrow(expect.objectContaining({ reason: "invalid_year" }));
  });
  it("H-04 parseUploadForm drops blank optional fields", () => {
    const parsed = parseUploadForm(form({ professorId: " ", termId: "", topic: "  ", year: "" }));
    expect(parsed).toMatchObject({ courseId: "course-a", title: "Final Exam", category: "EXAM" });
    expect(parsed.professorId).toBeUndefined();
    expect(parsed.termId).toBeUndefined();
    expect(parsed.topic).toBeUndefined();
    expect(parsed.year).toBeUndefined();
  });
});
