import { getAdminUser } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { processExamFile } from "@/lib/exam-processing";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/upload-rules";
import { parseUploadForm, saveUpload, UploadError } from "@/lib/uploads";

export const runtime = "nodejs";

// Room for the text fields and multipart boundaries around the file itself.
const FORM_OVERHEAD_BYTES = 1024 * 1024;

const failure = (reason: string, error: string, status: number) => Response.json({ reason, error }, { status });

export async function POST(request: Request) {
  if (!(await getAdminUser("POST /api/admin/uploads"))) return failure("forbidden", "Only an admin can upload files.", 403);
  if (Number(request.headers.get("content-length")) > MAX_UPLOAD_BYTES + FORM_OVERHEAD_BYTES) {
    logError("upload_rejected", { reason: "file_too_large" });
    return failure("file_too_large", `The file is larger than ${MAX_UPLOAD_LABEL}.`, 413);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    logError("upload_rejected", { reason: "invalid_form" });
    return failure("invalid_form", "The upload could not be read. Please try again.", 400);
  }
  const courseId = form.get("courseId");
  const category = form.get("category");
  const context = { courseId: typeof courseId === "string" ? courseId.slice(0, 100) : undefined, resourceCategory: category === "EXAM" || category === "MATERIAL" ? category : undefined };
  try {
    const { file, ...fields } = parseUploadForm(form);
    const record = await saveUpload({ ...fields, fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    if (record.category === "EXAM") await processExamFile(record.id);
    return Response.json({ file: { id: record.id, title: record.title, category: record.category, courseId: record.courseId, url: `/files/${encodeURIComponent(record.id)}` } }, { status: 201 });
  } catch (error) {
    if (error instanceof UploadError) {
      // Storage and record failures are already logged with their cause by the upload service.
      if (error.status < 500) logError("upload_rejected", { ...context, reason: error.reason });
      return failure(error.reason, error.message, error.status);
    }
    logError("upload_failed", { ...context, errorType: error instanceof Error ? error.name : "Unknown" });
    return failure("upload_failed", "The upload failed. Please try again.", 500);
  }
}
