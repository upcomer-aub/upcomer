import { FileCategory } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { checkFileMetadata, parseFileMetadata, type FileMetadata } from "@/lib/file-metadata";
import { fileMetadataMessage } from "@/lib/file-metadata-rules";
import { resolveStoragePath } from "@/lib/files";
import { logError } from "@/lib/logger";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, UPLOAD_FILE_TYPES, UPLOAD_TYPES_LABEL } from "@/lib/upload-rules";

const STATUS = {
  invalid_fields: 400, empty_file: 400, content_mismatch: 400,
  // The file metadata reasons shared with the admin edit page (US-72).
  course_required: 400, invalid_year: 400, topic_too_long: 400, term_not_found: 400, invalid_type: 400, type_not_allowed: 400,
  // Sprint 1 plan: an unknown course or professor returns 404. A professor outside the course is unknown to it.
  course_not_found: 404, professor_not_assigned: 404, file_too_large: 413, unsupported_type: 415,
  storage_failed: 500, record_failed: 500,
} as const;

export type UploadFailure = keyof typeof STATUS;

export class UploadError extends Error {
  status: number;
  constructor(public reason: UploadFailure, message: string) {
    super(message);
    this.status = STATUS[reason];
  }
}

export type UploadInput = FileMetadata & { category: FileCategory; title: string; fileName: string; bytes: Uint8Array };

export function validateUploadFile(fileName: string, bytes: Uint8Array) {
  const extension = path.extname(fileName).slice(1).toLowerCase();
  const type = UPLOAD_FILE_TYPES[extension];
  if (!type) throw new UploadError("unsupported_type", `Unsupported file type. Upload a ${UPLOAD_TYPES_LABEL} file.`);
  if (bytes.length === 0) throw new UploadError("empty_file", "The selected file is empty.");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new UploadError("file_too_large", `The file is larger than ${MAX_UPLOAD_LABEL}.`);
  if (!type.signature.every((byte, index) => bytes[index] === byte) || !hasOfficeParts(extension, bytes)) {
    throw new UploadError("content_mismatch", `The file is corrupt or is not a real .${extension} file.`);
  }
  return { extension, mimeType: type.mimeType };
}

// DOCX and PPTX are ZIP files, so the ZIP signature alone also accepts any renamed archive. ZIP stores entry
// names uncompressed, so a real document always contains these names as plain bytes.
const OFFICE_PARTS: Record<string, string[]> = { docx: ["[Content_Types].xml", "word/"], pptx: ["[Content_Types].xml", "ppt/"] };

function hasOfficeParts(extension: string, bytes: Uint8Array) {
  const parts = OFFICE_PARTS[extension];
  if (!parts) return true;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return parts.every(part => buffer.includes(part, 0, "latin1"));
}

function text(form: FormData, name: string, label: string, maxLength: number) {
  const value = form.get(name);
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length > maxLength) throw new UploadError("invalid_fields", `${label} must be ${maxLength} characters or fewer.`);
  return trimmed;
}

export function parseUploadForm(form: FormData, now = new Date()) {
  const category = text(form, "category", "Category", 20);
  if (category !== FileCategory.EXAM && category !== FileCategory.MATERIAL) throw new UploadError("invalid_fields", "Choose whether this is an exam or a material.");
  const metadata = parseFileMetadata(form, category as FileCategory, now);
  if (!metadata.ok) throw new UploadError(metadata.error, fileMetadataMessage(metadata.error, now));
  const title = text(form, "title", "Title", 150);
  if (!title) throw new UploadError("invalid_fields", "Enter a title.");
  const file = form.get("file");
  if (!file || typeof file === "string") throw new UploadError("invalid_fields", "Choose a file to upload.");
  return { ...metadata.metadata, category: category as FileCategory, title, file };
}

export async function saveUpload(input: UploadInput) {
  const { extension, mimeType } = validateUploadFile(input.fileName, input.bytes);
  const invalid = await checkFileMetadata(input);
  if (invalid) throw new UploadError(invalid, fileMetadataMessage(invalid));
  const course = { id: input.courseId };

  const storageKey = `${input.category === FileCategory.EXAM ? "exams" : "materials"}/${randomUUID()}.${extension}`;
  const filePath = resolveStoragePath(storageKey);
  const context = { courseId: course.id, resourceCategory: input.category };
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, input.bytes, { flag: "wx" });
  } catch (error) {
    logError("upload_storage_failed", { ...context, errorType: error instanceof Error ? error.name : "Unknown", errorCode: errorCode(error) });
    throw new UploadError("storage_failed", "The file could not be stored. Please try again.");
  }
  try {
    return await db.courseFile.create({
      data: {
        courseId: course.id, professorId: input.professorId, title: input.title, category: input.category,
        originalFileName: path.basename(input.fileName.replaceAll("\\", "/")).slice(0, 255), storageKey,
        year: input.year, termId: input.termId, examType: input.examType, topic: input.topic, mimeType, sizeBytes: input.bytes.length,
      },
    });
  } catch (error) {
    // Do not leave a stored file that no record points to.
    await unlink(filePath).catch(() => logError("upload_cleanup_failed", context));
    logError("upload_record_failed", { ...context, errorType: error instanceof Error ? error.name : "Unknown" });
    throw new UploadError("record_failed", "The file could not be saved. Please try again.");
  }
}

function errorCode(error: unknown) {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

export async function getUploadOptions() {
  try {
    const courses = await db.course.findMany({
      select: { id: true, code: true, name: true, professors: { select: { professor: { select: { id: true, name: true } } } } },
      orderBy: { code: "asc" },
    });
    return courses.map(({ professors, ...course }) => ({ ...course, professors: professors.map(item => item.professor) }));
  } catch (error) {
    logError("upload_options_retrieval_failed", { errorType: error instanceof Error ? error.name : "Unknown" });
    throw error;
  }
}

export type UploadCourseOption = Awaited<ReturnType<typeof getUploadOptions>>[number];
