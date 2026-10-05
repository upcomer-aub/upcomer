import { getAdminUser } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/upload-rules";
import { parseUploadForm, saveUpload, UploadError } from "@/lib/uploads";

export const runtime = "nodejs";

// Room for the text fields and multipart boundaries around the file itself.
const FORM_OVERHEAD_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + FORM_OVERHEAD_BYTES;

const failure = (reason: string, error: string, status: number) => Response.json({ reason, error }, { status });
const tooLarge = () => {
  logError("upload_rejected", { reason: "file_too_large" });
  return failure("file_too_large", `The file is larger than ${MAX_UPLOAD_LABEL}.`, 413);
};

// Reads the body itself and stops at the limit, so a request without Content-Length (or with a false one)
// can't make the server hold more than MAX_REQUEST_BYTES. Returns null when the body is too large.
async function readForm(request: Request): Promise<FormData | null> {
  if (!request.body) throw new TypeError("No request body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    total += chunk.value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  return new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
}

export async function POST(request: Request) {
  if (!(await getAdminUser("POST /api/admin/uploads"))) return failure("forbidden", "Only an admin can upload files.", 403);
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) return tooLarge();
  let form: FormData;
  try {
    const parsed = await readForm(request);
    if (!parsed) return tooLarge();
    form = parsed;
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
