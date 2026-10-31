import { FileCategory, FileStatus } from "@prisma/client";
import path from "node:path";
import { db } from "@/lib/db";
import { fileMetadataMessage } from "@/lib/file-metadata-rules";
import { logError } from "@/lib/logger";
import { processExamFile } from "@/lib/exam-processing";
import { MAX_UPLOAD_LABEL } from "@/lib/upload-rules";
import { saveUpload, UploadError, validateUploadFile, type UploadInput } from "@/lib/uploads";

// Student submissions (US-13) and the review functions for the admin review page (US-74).
// A submission is a CourseFile with status PENDING and submittedById set. An admin publishes it (PUBLISHED) or rejects it
// with a reason (REJECTED); both are final. Only PUBLISHED files are shown to other students or processed.
// Nothing here checks who is calling: pages, actions, and routes call requireUser() or requireAdmin() from lib/auth.ts first.

export { canViewFile, PUBLISHED_FILES, type FileViewer } from "@/lib/file-visibility";

export const MAX_REJECTION_REASON_LENGTH = 500;

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

// Students may submit PDFs only; the empty, size, and content checks are the admin upload's.
export function validateSubmissionFile(fileName: string, bytes: Uint8Array) {
  if (path.extname(fileName).toLowerCase() !== ".pdf") throw new UploadError("unsupported_type", "Only PDF files can be submitted.");
  return validateUploadFile(fileName, bytes);
}

// The message for a reason from POST /api/submissions, shown on the submit page.
export function submissionMessage(reason: string) {
  switch (reason) {
    case "unsupported_type": return "Only PDF files can be submitted.";
    case "empty_file": return "The selected file is empty.";
    case "file_too_large": return `The file is larger than ${MAX_UPLOAD_LABEL}.`;
    case "content_mismatch": return "The file is corrupt or is not a real PDF.";
    case "invalid_fields": return "Choose exam or material, enter a title of up to 150 characters, and choose a file.";
    case "invalid_form": return "The submission could not be read. Please try again.";
    case "storage_failed": case "record_failed": case "submission_failed": return "The file could not be saved. Please try again.";
    default: return fileMetadataMessage(reason);
  }
}

// Stores the file and creates its CourseFile as PENDING. Throws UploadError with the same reasons as an admin upload.
export async function saveSubmission(userId: string, input: UploadInput) {
  validateSubmissionFile(input.fileName, input.bytes);
  return saveUpload(input, { status: FileStatus.PENDING, submittedById: userId });
}

const reviewInclude = {
  course: { select: { id: true, code: true, name: true } },
  professor: { select: { id: true, name: true } },
  term: { select: { id: true, name: true } },
} as const;

// The student's own submissions, newest first, with their status and the reason if rejected.
export async function getMySubmissions(userId: string) {
  try {
    return await db.courseFile.findMany({
      where: { submittedById: userId },
      include: reviewInclude,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
  } catch (error) {
    logError("submission_retrieval_failed", { entity: "my_submissions", userId, errorType: errorType(error) });
    throw error;
  }
}

export type MySubmission = Awaited<ReturnType<typeof getMySubmissions>>[number];

// The review queue (US-74): every pending submission, oldest first, with its submitter.
// An optional range returns one page of it; the review page shows 20 at a time (lib/submission-review.ts).
export async function listPendingSubmissions(range?: { skip: number; take: number }) {
  try {
    return await db.courseFile.findMany({
      where: { status: FileStatus.PENDING },
      include: { ...reviewInclude, submittedBy: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      ...range,
    });
  } catch (error) {
    logError("submission_retrieval_failed", { entity: "pending_submissions", errorType: errorType(error) });
    throw error;
  }
}

export type PendingSubmission = Awaited<ReturnType<typeof listPendingSubmissions>>[number];

// How many submissions are waiting for review.
export async function countPendingSubmissions() {
  try {
    return await db.courseFile.count({ where: { status: FileStatus.PENDING } });
  } catch (error) {
    logError("submission_retrieval_failed", { entity: "pending_count", errorType: errorType(error) });
    throw error;
  }
}
export type ReviewError = "not_found" | "not_pending" | "reason_required" | "reason_too_long";
export type ReviewResult = { ok: true; id: string; courseId: string } | { ok: false; error: ReviewError };

// Moves a PENDING file to its final status in one statement, so two admins can never both review it.
async function review(fileId: string, operation: "publish" | "reject", data: { status: FileStatus; rejectionReason?: string }): Promise<ReviewResult> {
  try {
    const { count } = await db.courseFile.updateMany({ where: { id: fileId, status: FileStatus.PENDING }, data: { ...data, reviewedAt: new Date() } });
    const file = await db.courseFile.findUnique({ where: { id: fileId }, select: { id: true, courseId: true, category: true } });
    if (!file) return { ok: false, error: "not_found" };
    if (count === 0) return { ok: false, error: "not_pending" };
    if (operation === "publish" && file.category === FileCategory.EXAM) await processExamFile(file.id);
    return { ok: true, id: file.id, courseId: file.courseId };
  } catch (error) {
    logError("submission_review_failed", { fileId, operation, errorType: errorType(error) });
    throw error;
  }
}

// Makes a pending submission visible to everyone, on its course pages and in the question pipeline.
export const publishSubmission = (fileId: string) => review(fileId, "publish", { status: FileStatus.PUBLISHED });

// Rejects a pending submission. The reason (1 to 500 characters) is shown to the submitter and never logged.
export async function rejectSubmission(fileId: string, reason: string): Promise<ReviewResult> {
  const rejectionReason = reason.trim();
  if (!rejectionReason) return { ok: false, error: "reason_required" };
  if (rejectionReason.length > MAX_REJECTION_REASON_LENGTH) return { ok: false, error: "reason_too_long" };
  const result = await review(fileId, "reject", { status: FileStatus.REJECTED, rejectionReason });
  if (result.ok) logError("submission_rejected", { fileId });
  return result;
}
