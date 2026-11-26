import { createHash } from "node:crypto";
import { FileCategory } from "@prisma/client";
import { runAiPrompt, isAiConfigured, type AiFailure } from "@/lib/ai-client";
import { fullQuestionText } from "@/lib/consolidated-exam";
import { db } from "@/lib/db";
import { PUBLISHED_FILES } from "@/lib/file-visibility";
import { errorCode, logError } from "@/lib/logger";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";
import {
  WALKTHROUGH_PROMPT_VERSION, WALKTHROUGH_QUESTION_MAX_LENGTH, readStoredSteps, walkthroughPrompt,
  type WalkthroughRefusal, type WalkthroughStep,
} from "@/lib/walkthrough-rules";

// US-51 (Lea Tass): step-by-step walkthroughs of stored past-exam questions. A walkthrough is made once per question text
// and prompt version, stored, and shared by every student; opening it again never calls the AI. Only a question of a
// published exam paper of the course is accepted, so it works from any stored question, however mock exams are made.
// Nothing here checks the session: the action and the page call requireUser() first and pass the session user's ID.
// Logging: IDs, reason codes, error types, HTTP status and step counts only; never question, prompt or answer text.

// Real AI calls per student per hour. A stored walkthrough, a view, a shared call and a refusal before the call never count.
export const WALKTHROUGH_WINDOW_MS = 60 * 60_000;
export const walkthroughLimit = () => limitFromEnv("WALKTHROUGH_RATE_LIMIT_PER_HOUR", 10);

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");
const short = (value: string) => value.slice(0, 100) || undefined;

// A hash of the stored question text, exactly as stored: any change to the text (an admin correction) gives a new hash, so
// a walkthrough of the old text is never shown for the new one.
export const questionTextHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export type WalkthroughQuestion = {
  id: string;
  courseId: string;
  // The question as shown and as sent to the model (number and marks removed, sub-parts on their own lines).
  text: string;
  textHash: string;
  topic: string | null;
  paperTitle: string;
  year: number | null;
  courseLabel: string;
};

// The question, only when it is on a published exam paper of this course and not excluded from the question bank (an
// extraction an admin or the rebuild marked as not a real question); otherwise null (not found), the same for every case.
async function findQuestion(courseId: string, questionId: string): Promise<WalkthroughQuestion | null> {
  if (!courseId || !questionId) return null;
  const row = await db.question.findFirst({
    where: { id: questionId, excludedFromBank: false, file: { courseId, category: FileCategory.EXAM, ...PUBLISHED_FILES } },
    select: { id: true, text: true, file: { select: { courseId: true, title: true, year: true, topic: true, course: { select: { code: true, name: true } } } } },
  });
  if (!row) return null;
  return {
    id: row.id, courseId: row.file.courseId, text: fullQuestionText(row.text), textHash: questionTextHash(row.text),
    topic: row.file.topic, paperTitle: row.file.title, year: row.file.year, courseLabel: `${row.file.course.code} ${row.file.course.name}`,
  };
}

async function findStored(question: WalkthroughQuestion) {
  const row = await db.questionWalkthrough.findUnique({
    where: { questionId_textHash_promptVersion: { questionId: question.id, textHash: question.textHash, promptVersion: WALKTHROUGH_PROMPT_VERSION } },
    select: { id: true, steps: true, createdAt: true },
  });
  if (!row) return null;
  const steps = readStoredSteps(row.steps);
  if (!steps) {
    // A stored row that no longer has the expected shape is not shown; it is reported once per read.
    logError("walkthrough_retrieval_failed", { questionId: question.id, courseId: question.courseId, walkthroughId: row.id, reason: "invalid_stored_steps" });
    return null;
  }
  return { id: row.id, steps, createdAt: row.createdAt };
}

export type StoredWalkthrough = { id: string; steps: WalkthroughStep[]; createdAt: Date };
export type WalkthroughPage = { question: WalkthroughQuestion; walkthrough: StoredWalkthrough | null };

// What the page shows: the question and its stored walkthrough, or null when the question is not found. Never calls the AI
// and never counts toward the limit. Throws on a failed read, after logging it.
export async function getWalkthroughPage(userId: string, courseId: string, questionId: string): Promise<WalkthroughPage | null> {
  try {
    const question = await findQuestion(courseId, questionId);
    if (!question) return null;
    return { question, walkthrough: await findStored(question) };
  } catch (error) {
    logError("walkthrough_retrieval_failed", { userId, courseId: short(courseId), questionId: short(questionId), errorType: errorType(error), errorCode: errorCode(error) });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Making a walkthrough.
// ---------------------------------------------------------------------------------------------------------------------

type CallOutcome =
  | { ok: true; steps: number; verified: number }
  | { ok: false; error: WalkthroughRefusal; aiError?: AiFailure; status?: number; parseError?: string };

const AI_REFUSAL: Record<AiFailure, WalkthroughRefusal> = {
  not_configured: "not_configured",
  timeout: "timeout",
  network_error: "unavailable",
  http_error: "unavailable",
  malformed: "invalid_output",
  empty: "invalid_output",
  truncated: "invalid_output",
};

// One AI call per question text in this server process at a time: a second student who asks while the call is running
// waits for the same call instead of making another (and is not counted). As with the rate limits, one process is assumed;
// across processes the unique key still keeps a single stored row.
const inFlight = new Map<string, Promise<CallOutcome>>();

// For tests.
export function resetWalkthroughCalls() {
  inFlight.clear();
}

async function callAndStore(question: WalkthroughQuestion): Promise<CallOutcome> {
  const answer = await runAiPrompt(walkthroughPrompt, { question: question.text, topic: question.topic, course: question.courseLabel });
  if (!answer.ok) {
    if (answer.error === "invalid_output") return { ok: false, error: "invalid_output", parseError: answer.validationError };
    return { ok: false, error: AI_REFUSAL[answer.error], aiError: answer.error, status: answer.status };
  }
  const steps = answer.value;
  await db.questionWalkthrough.createMany({
    data: [{ questionId: question.id, textHash: question.textHash, promptVersion: WALKTHROUGH_PROMPT_VERSION, model: answer.model, steps }],
    // Another process may have stored one for the same text in the meantime; the first one is kept.
    skipDuplicates: true,
  });
  return { ok: true, steps: steps.length, verified: steps.filter(step => step.verified).length };
}

export type GenerateResult = { ok: true; stored: boolean } | { ok: false; error: WalkthroughRefusal };

// Makes (or finds) the walkthrough of one question for the session student. `stored: true` means one already existed and
// the AI was not called.
export async function generateWalkthrough(userId: string, courseId: string, questionId: string): Promise<GenerateResult> {
  const context = { userId, courseId: short(courseId), questionId: short(questionId) };
  const refuse = (error: WalkthroughRefusal): GenerateResult => {
    logError("walkthrough_refused", { ...context, reason: error });
    return { ok: false, error };
  };
  let question: WalkthroughQuestion | null;
  try {
    question = await findQuestion(courseId, questionId);
    if (!question) return refuse("not_found");
    if (await findStored(question)) return { ok: true, stored: true };
  } catch (error) {
    logError("walkthrough_failed", { ...context, step: "read", errorType: errorType(error), errorCode: errorCode(error) });
    return { ok: false, error: "unexpected" };
  }
  if (!question.text.trim()) return refuse("not_found");
  if (question.text.length > WALKTHROUGH_QUESTION_MAX_LENGTH) return refuse("question_too_long");

  const key = `${question.id}:${question.textHash}:${WALKTHROUGH_PROMPT_VERSION}`;
  let call = inFlight.get(key);
  const shared = Boolean(call);
  if (!call) {
    if (!isAiConfigured()) return refuse("not_configured");
    const limit = checkRateLimit(`walkthrough:${userId}`, walkthroughLimit(), WALKTHROUGH_WINDOW_MS);
    if (!limit.ok) {
      logError("walkthrough_rate_limited", { ...context, retryAfterSeconds: String(limit.retryAfterSeconds) });
      return { ok: false, error: "rate_limited" };
    }
    const started = Date.now();
    const current: Promise<CallOutcome> = callAndStore(question)
      .catch((error): CallOutcome => {
        // P2003: the question was deleted while the walkthrough was being made.
        if (errorCode(error) === "P2003") return { ok: false, error: "not_found" };
        logError("walkthrough_failed", { ...context, step: "store", errorType: errorType(error), errorCode: errorCode(error) });
        return { ok: false, error: "unexpected" };
      })
      .then(outcome => {
        const durationMs = String(Date.now() - started);
        if (outcome.ok) {
          logError("walkthrough_generated", { ...context, steps: String(outcome.steps), verifiedSteps: String(outcome.verified), durationMs });
        } else if (outcome.aiError || outcome.parseError) {
          logError("walkthrough_failed", {
            ...context, step: "ai", reason: outcome.error, aiError: outcome.aiError, parseError: outcome.parseError,
            status: outcome.status === undefined ? undefined : String(outcome.status), durationMs,
          });
        } else if (outcome.error === "not_found") {
          logError("walkthrough_refused", { ...context, reason: "not_found" });
        }
        return outcome;
      })
      .finally(() => {
        if (inFlight.get(key) === current) inFlight.delete(key);
      });
    inFlight.set(key, current);
    call = current;
  }
  const outcome = await call;
  return outcome.ok ? { ok: true, stored: shared } : { ok: false, error: outcome.error };
}
