import { FileCategory, FileStatus, ProcessingStage, ProcessingStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { ExtractionError, extractExamQuestions } from "@/lib/exam-extraction";
import { FileUnavailableError, getOriginalFile } from "@/lib/files";
import { logError } from "@/lib/logger";
import { rebuildQuestionBank } from "@/lib/question-bank";

const REASONS: Record<string, string> = {
  no_text: "No extractable text was found in this PDF.",
  no_questions: "No numbered questions were found in this PDF.",
  unreadable_pdf: "The PDF could not be read.",
  unsupported_type: "Question extraction supports PDF exams only.",
  missing_file: "The stored file is missing or unavailable.",
  grouping_failed: "The questions could not be grouped and ranked.",
  unexpected: "Processing failed unexpectedly.",
};
export const processingReason = (reason: string | null) => REASONS[reason ?? ""] ?? REASONS.unexpected;
const STALE_RUN_MS = 15 * 60 * 1000;
const errorType = (error: unknown) => error instanceof Error ? error.name : "Unknown";

export const canRetryRun = (run: { status: ProcessingStatus; createdAt: Date }, now = new Date()) =>
  run.status === ProcessingStatus.FAILED || (run.status === ProcessingStatus.RUNNING && now.getTime() - run.createdAt.getTime() > STALE_RUN_MS);

// Starts a run for the file. Under a per-file lock, so simultaneous retries (a double click, two admins) start one run:
// the others see a different or RUNNING attempt and are refused. Only a failed or stale latest run may be replaced.
async function startRun(fileId: string, retry: boolean, expectedRunId?: string) {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`exam-processing:${fileId}`}))`;
    if (retry) {
      const latest = await tx.fileProcessingRun.findFirst({ where: { fileId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      // A queued click must not retry a different attempt, even if that newer attempt has already failed.
      if (!latest || !canRetryRun(latest) || (expectedRunId !== undefined && latest.id !== expectedRunId)) return null;
    }
    return tx.fileProcessingRun.create({ data: { fileId } });
  });
}

export async function processExamFile(fileId: string, { retry = false, expectedRunId }: { retry?: boolean; expectedRunId?: string } = {}) {
  let file;
  try {
    file = await db.courseFile.findUnique({ where: { id: fileId }, select: { id: true, courseId: true, category: true, status: true, mimeType: true } });
  } catch (error) {
    logError("exam_processing_failed", { fileId, stage: ProcessingStage.EXTRACTION, reason: "unexpected", errorType: error instanceof Error ? error.name : "Unknown" });
    return { ok: false as const, reason: "unexpected" };
  }
  if (!file || file.category !== FileCategory.EXAM || file.status !== FileStatus.PUBLISHED) {
    if (retry) logError("exam_retry_refused", { fileId, reason: "not_eligible" });
    return { ok: false as const, reason: "not_eligible" };
  }
  let run;
  try {
    run = await startRun(fileId, retry, expectedRunId);
  } catch (error) {
    logError("exam_processing_failed", { fileId, stage: ProcessingStage.EXTRACTION, reason: "unexpected", errorType: error instanceof Error ? error.name : "Unknown" });
    return { ok: false as const, reason: "unexpected" };
  }
  if (!run) {
    logError("exam_retry_refused", { fileId, reason: "not_failed" });
    return { ok: false as const, reason: "not_failed" };
  }
  const started = performance.now();
  const context = { fileId, courseId: file.courseId, runId: run.id, retry: String(retry) };
  logError("exam_processing_started", context);
  let stage: ProcessingStage = ProcessingStage.EXTRACTION;
  try {
    // Older files may already have questions. Keep those rows and just rank them.
    let questionCount = await db.question.count({ where: { fileId } });
    if (!questionCount) {
      if (file.mimeType !== "application/pdf") throw new ExtractionError("unsupported_type");
      const { bytes } = await getOriginalFile(fileId, { id: "", role: "ADMIN" });
      const questions = await extractExamQuestions(bytes);
      await db.$transaction(async tx => {
        await tx.question.deleteMany({ where: { fileId } });
        await tx.question.createMany({ data: questions.map((text, index) => ({ fileId, number: index + 1, text })) });
      });
      questionCount = questions.length;
    }
    stage = ProcessingStage.GROUPING;
    await db.fileProcessingRun.update({ where: { id: run.id }, data: { stage } });
    const grouped = await rebuildQuestionBank(file.courseId);
    if (!grouped.ok) throw new Error("grouping_failed");
    await db.fileProcessingRun.update({ where: { id: run.id }, data: { status: ProcessingStatus.SUCCEEDED } });
    logError("exam_processing_completed", { ...context, questionCount: String(questionCount), durationMs: String(Math.round(performance.now() - started)) });
    return { ok: true as const, runId: run.id, questionCount };
  } catch (error) {
    const reason = error instanceof ExtractionError ? error.reason
      : error instanceof FileUnavailableError ? "missing_file"
      : stage === ProcessingStage.GROUPING ? "grouping_failed" : "unexpected";
    await db.fileProcessingRun.update({ where: { id: run.id }, data: { status: ProcessingStatus.FAILED, stage, reason } }).catch(recordError => {
      logError("exam_processing_record_failed", { ...context, stage, reason, errorType: errorType(recordError) });
    });
    logError("exam_processing_failed", { ...context, stage, reason, errorType: errorType(error), durationMs: String(Math.round(performance.now() - started)) });
    return { ok: false as const, runId: run.id, reason };
  }
}

export async function getExamProcessingRuns() {
  try {
    return await db.courseFile.findMany({
      where: { category: FileCategory.EXAM, processingRuns: { some: {} } },
      select: {
        id: true, title: true, course: { select: { code: true } },
        processingRuns: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 },
      },
      orderBy: { createdAt: "desc" },
    });
  } catch (error) {
    logError("exam_processing_retrieval_failed", { errorType: errorType(error) });
    throw error;
  }
}

export async function retryFailedExam(fileId: string, expectedRunId?: string) {
  let retryRunId: string;
  try {
    const latest = await db.fileProcessingRun.findFirst({ where: { fileId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (!latest || !canRetryRun(latest) || (expectedRunId !== undefined && latest.id !== expectedRunId)) {
      logError("exam_retry_refused", { fileId, reason: "not_failed" });
      return { ok: false as const, reason: "not_failed" };
    }
    retryRunId = latest.id;
  } catch (error) {
    logError("exam_processing_failed", { fileId, retry: "true", reason: "unexpected", errorType: errorType(error) });
    return { ok: false as const, reason: "unexpected" };
  }
  // Checked again under the lock when the run starts.
  return processExamFile(fileId, { retry: true, expectedRunId: retryRunId });
}
