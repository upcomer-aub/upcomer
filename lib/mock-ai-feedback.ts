import { aiConfig, runAiPrompt } from "@/lib/ai-client";
import { hasFields } from "@/lib/ai-prompt-data";
import { db } from "@/lib/db";
import { readGeneratedRubric } from "@/lib/generated-rubric-rules";
import { errorCode, logError } from "@/lib/logger";
import { eligibleForAiFeedback, MOCK_AI_FEEDBACK_VERSION, mockFeedbackPrompt } from "@/lib/mock-ai-feedback-rules";
import { historicalMarkingRubric } from "@/lib/mock-marking-rules";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";

export const mockAiFeedbackAvailable = () => process.env.AI_MOCK_FEEDBACK_ENABLED === "true" && Boolean(aiConfig());

type ErrorCode = "ineligible" | "ai_unavailable" | "ai_rate_limited" | "ai_failed";
type FeedbackResult = { ok: true } | { ok: false; error: ErrorCode };
const refuse = (error: ErrorCode): FeedbackResult => ({ ok: false, error });
const inFlight = new Map<string, Promise<FeedbackResult>>();

export async function generateMockAiFeedback(userId: string, courseId: string, mockExamId: string, itemId: string, consent: boolean): Promise<FeedbackResult> {
  if (!consent) return refuse("ineligible");
  if (!mockAiFeedbackAvailable()) return refuse("ai_unavailable");

  try {
    const item = await db.mockExamQuestion.findFirst({
      where: { id: itemId, mockExamId, markedAt: { not: null }, mockExam: { userId, courseId, status: "SUBMITTED", markedAt: { not: null } } },
      select: {
        text: true, outcome: true, answer: true, matchedPoints: true, missedPoints: true, feedback: true,
        markingRubric: true, generatedRubricSnapshot: true,
        aiExplanations: { where: { promptVersion: MOCK_AI_FEEDBACK_VERSION }, select: { promptVersion: true } },
      },
    });
    if (!item || !eligibleForAiFeedback(item)) return refuse("ineligible");
    if (item.aiExplanations.length) return { ok: true };
    const generated = readGeneratedRubric(item.generatedRubricSnapshot);
    const stored = item.markingRubric;
    const past = hasFields(stored, ["keyPoints", "explanation"]) && Array.isArray(stored.keyPoints)
      && stored.keyPoints.every((point): point is string => typeof point === "string") && typeof stored.explanation === "string"
      ? { keyPoints: stored.keyPoints, explanation: stored.explanation } : null;
    const rubric = generated ?? past ?? historicalMarkingRubric(item);
    if (!rubric) return refuse("ineligible");

    const existing = inFlight.get(itemId);
    if (existing) return await existing;
    const pending = (async (): Promise<FeedbackResult> => {
      const saved = await db.mockAiExplanation.findUnique({
        where: { mockExamQuestionId_promptVersion: { mockExamQuestionId: itemId, promptVersion: MOCK_AI_FEEDBACK_VERSION } },
        select: { mockExamQuestionId: true },
      });
      if (saved) return { ok: true };
      if (!checkRateLimit(`mock-ai-feedback:${userId}`, limitFromEnv("AI_MOCK_FEEDBACK_RATE_LIMIT_PER_HOUR", 10), 3_600_000).ok) return refuse("ai_rate_limited");
      const result = await runAiPrompt(mockFeedbackPrompt, {
        question: item.text, answer: item.answer!, rubric, matchedPoints: item.matchedPoints, missedPoints: item.missedPoints,
      });
      if (!result.ok) return refuse(result.error === "not_configured" ? "ai_unavailable" : "ai_failed");

      await db.mockAiExplanation.createMany({
        data: [{ mockExamQuestionId: itemId, promptVersion: MOCK_AI_FEEDBACK_VERSION, model: result.model, explanation: result.value }],
        skipDuplicates: true,
      });
      return { ok: true };
    })();
    inFlight.set(itemId, pending);
    try { return await pending; } finally { inFlight.delete(itemId); }
  } catch (error) {
    logError("mock_ai_feedback_failed", { userId, mockExamId, errorCode: errorCode(error) });
    return refuse("ai_failed");
  }
}
