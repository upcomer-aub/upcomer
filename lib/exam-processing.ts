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

export const canRetryRun = (run: { status: ProcessingStatus; createdAt: Date }, now = new Date()) =>
  run.status === ProcessingStatus.FAILED || (run.status === ProcessingStatus.RUNNING && now.getTime() - run.createdAt.getTime() > STALE_RUN_MS);

export async function processExamFile(fileId: string) {
  let file;
  try {
    file = await db.courseFile.findUnique({ where: { id: fileId }, select: { id: true, courseId: true, category: true, status: true, mimeType: true } });
  } catch (error) {
    logError("exam_processing_failed", { fileId, stage: ProcessingStage.EXTRACTION, reason: "unexpected", errorType: error instanceof Error ? error.name : "Unknown" });
    return { ok: false as const, reason: "unexpected" };
  }
  if (!file || file.category !== FileCategory.EXAM || file.status !== FileStatus.PUBLISHED) return { ok: false as const, reason: "not_eligible" };
  let run;
  try {
    run = await db.fileProcessingRun.create({ data: { fileId } });
  } catch (error) {
    logError("exam_processing_failed", { fileId, stage: ProcessingStage.EXTRACTION, reason: "unexpected", errorType: error instanceof Error ? error.name : "Unknown" });
    return { ok: false as const, reason: "unexpected" };
  }
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
    return { ok: true as const, runId: run.id, questionCount };
  } catch (error) {
    const reason = error instanceof ExtractionError ? error.reason
      : error instanceof FileUnavailableError ? "missing_file"
      : stage === ProcessingStage.GROUPING ? "grouping_failed" : "unexpected";
    await db.fileProcessingRun.update({ where: { id: run.id }, data: { status: ProcessingStatus.FAILED, stage, reason } }).catch(() => undefined);
    logError("exam_processing_failed", { fileId, runId: run.id, stage, reason });
    return { ok: false as const, runId: run.id, reason };
  }
}

export async function getExamProcessingRuns() {
  return db.courseFile.findMany({
    where: { category: FileCategory.EXAM, processingRuns: { some: {} } },
    select: {
      id: true, title: true, course: { select: { code: true } },
      processingRuns: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function retryFailedExam(fileId: string) {
  const latest = await db.fileProcessingRun.findFirst({ where: { fileId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!latest || !canRetryRun(latest)) return { ok: false as const, reason: "not_failed" };
  return processExamFile(fileId);
}
