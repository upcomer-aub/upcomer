import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { saveUpload, getAdminUser, processExamFile } = vi.hoisted(() => ({ saveUpload: vi.fn(), getAdminUser: vi.fn(), processExamFile: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth", () => ({ getAdminUser }));
vi.mock("@/lib/uploads", async original => ({ ...(await original<typeof import("@/lib/uploads")>()), saveUpload }));
vi.mock("@/lib/exam-processing", () => ({ processExamFile }));
import { POST } from "@/app/api/admin/uploads/route";
import { UploadError } from "@/lib/uploads";

const pdf = Buffer.from("%PDF-1.4\nexample");
function upload(fields: Record<string, string> = {}, file: File | null = new File([pdf], "final.pdf")) {
  const form = new FormData();
  for (const [name, value] of Object.entries({ category: "EXAM", courseId: "course-a", title: "Final Exam", ...fields })) form.set(name, value);
  if (file) form.set("file", file);
  return new Request("http://localhost/api/admin/uploads", { method: "POST", body: form });
}

let errors: ReturnType<typeof vi.spyOn>;
const logged = () => errors.mock.calls.map(call => JSON.parse(String(call[0])));
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  getAdminUser.mockReset().mockResolvedValue({ id: "admin-1", role: "ADMIN" });
  saveUpload.mockReset().mockResolvedValue({ id: "file new", title: "Final Exam", category: "EXAM", courseId: "course-a" });
  processExamFile.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => errors.mockRestore());

describe("admin upload route", () => {
  it("refuses a visitor or a student with 403 before reading the upload", async () => {
    getAdminUser.mockResolvedValue(null);
    const response = await POST(upload());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ reason: "forbidden", error: "Only an admin can upload files." });
    expect(getAdminUser).toHaveBeenCalledWith("POST /api/admin/uploads");
    expect(saveUpload).not.toHaveBeenCalled();
  });
  it("checks the admin before the size limit, so an oversized anonymous request is still 403", async () => {
    getAdminUser.mockResolvedValue(null);
    const request = new Request("http://localhost/api/admin/uploads", { method: "POST", headers: { "content-length": String(50 * 1024 * 1024) }, body: "x" });
    expect((await POST(request)).status).toBe(403);
  });
  it("stores a valid upload and returns the new file", async () => {
    const response = await POST(upload({ year: "2025", termId: "term-fall", examType: "FINAL" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ file: { id: "file new", title: "Final Exam", category: "EXAM", courseId: "course-a", url: "/files/file%20new" } });
    const input = saveUpload.mock.calls[0][0];
    expect(input).toMatchObject({ courseId: "course-a", category: "EXAM", title: "Final Exam", year: 2025, termId: "term-fall", examType: "FINAL", fileName: "final.pdf" });
    expect(Buffer.from(input.bytes)).toEqual(pdf);
    expect(processExamFile).toHaveBeenCalledWith("file new");
    expect(errors).not.toHaveBeenCalled();
  });
  it("keeps an uploaded exam when extraction fails, so an admin can retry it", async () => {
    processExamFile.mockResolvedValue({ ok: false, reason: "no_text" });
    const response = await POST(upload());
    expect(response.status).toBe(201);
    expect((await response.json()).file.id).toBe("file new");
    expect(processExamFile).toHaveBeenCalledWith("file new");
  });
  it("rejects missing fields without saving", async () => {
    const response = await POST(upload({ title: "" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ reason: "invalid_fields", error: "Enter a title." });
    expect((await POST(upload({}, null))).status).toBe(400);
    expect(saveUpload).not.toHaveBeenCalled();
  });
  it("returns the service's status for an invalid file and logs the rejection", async () => {
    saveUpload.mockRejectedValue(new UploadError("unsupported_type", "Unsupported file type."));
    const response = await POST(upload({}, new File(["MZ"], "virus.exe")));
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ reason: "unsupported_type", error: "Unsupported file type." });
    expect(logged()).toEqual([expect.objectContaining({ event: "upload_rejected", reason: "unsupported_type", courseId: "course-a", resourceCategory: "EXAM" })]);
    expect(JSON.stringify(logged())).not.toContain("virus.exe");
  });
  it("returns 404 for an unknown course", async () => {
    saveUpload.mockRejectedValue(new UploadError("course_not_found", "The selected course doesn't exist."));
    expect((await POST(upload())).status).toBe(404);
  });
  it("rejects an oversized request before reading it", async () => {
    const request = new Request("http://localhost/api/admin/uploads", { method: "POST", headers: { "content-length": String(50 * 1024 * 1024) }, body: "x" });
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(saveUpload).not.toHaveBeenCalled();
  });
  it("rejects a body that is not a form", async () => {
    const response = await POST(new Request("http://localhost/api/admin/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toBe("invalid_form");
  });
  it("does not log storage failures twice", async () => {
    saveUpload.mockRejectedValue(new UploadError("storage_failed", "The file could not be stored. Please try again."));
    const response = await POST(upload());
    expect(response.status).toBe(500);
    expect(errors).not.toHaveBeenCalled();
  });
  it("hides unexpected errors and logs them", async () => {
    saveUpload.mockRejectedValue(new Error("connection string postgres://secret"));
    const response = await POST(upload());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
    expect(logged()).toEqual([expect.objectContaining({ event: "upload_failed", courseId: "course-a", errorType: "Error" })]);
    expect(JSON.stringify(logged())).not.toContain("secret");
  });
});
