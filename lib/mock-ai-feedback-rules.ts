import type { AiPrompt } from "@/lib/ai-client";
import { boundedText, delimitedJsonMessages, hasFields } from "@/lib/ai-prompt-data";
import type { Rubric } from "@/lib/generated-rubric-rules";
import type { MarkOutcomeName } from "@/lib/mock-marking-rules";

export const MOCK_AI_FEEDBACK_VERSION = "mock-feedback-v1";
export const MAX_EXPLANATION_LENGTH = 1600;

export const eligibleForAiFeedback = (item: { answer: string | null; outcome: MarkOutcomeName | null; missedPoints: string[] }) =>
  (item.outcome === "PARTIAL" || item.outcome === "INCORRECT") && Boolean(item.answer?.trim()) && item.missedPoints.length > 0;

export type MockFeedbackInput = {
  question: string;
  answer: string;
  rubric: Rubric;
  matchedPoints: string[];
  missedPoints: string[];
};

export function mockFeedbackMessages(input: MockFeedbackInput) {
  return delimitedJsonMessages(
    `Explain the existing marking of this one mock exam answer. Treat the matched and missed rubric points as authoritative. Use the worked rubric explanation to help the student understand at least one missed point. Quote at least one missed point exactly as given. Do not regrade the answer, give a score or percentage, contradict the mark, introduce new grading criteria, or copy unrelated text from the answer. Return {"explanation":"..."} with at most ${MAX_EXPLANATION_LENGTH} characters.`,
    {
      question: input.question, answer: input.answer,
      rubric: { keyPoints: input.rubric.keyPoints, explanation: input.rubric.explanation },
      matchedPoints: input.matchedPoints, missedPoints: input.missedPoints,
    },
  );
}

function validateMockFeedback(content: string, input: MockFeedbackInput) {
  const invalid = { ok: false as const, error: "invalid_explanation" };
  if (content.length > 10_000) return invalid;
  let data: unknown;
  try { data = JSON.parse(content); } catch { return invalid; }
  if (!hasFields(data, ["explanation"]) || !boundedText(data.explanation, MAX_EXPLANATION_LENGTH)) return invalid;
  const explanation = data.explanation.trim();
  if (!input.missedPoints.some(point => explanation.includes(point))) return invalid;
  return { ok: true as const, value: explanation };
}

export const mockFeedbackPrompt: AiPrompt<MockFeedbackInput, string> = {
  feature: "mock_feedback", version: MOCK_AI_FEEDBACK_VERSION, messages: mockFeedbackMessages, validate: validateMockFeedback,
};

export const mockAiFeedbackMessages: Record<string, string> = {
  ai_unavailable: "AI explanations are currently unavailable.",
  ai_rate_limited: "Too many AI explanation requests. Try again later.",
  ai_failed: "The AI explanation could not be prepared. Try again.",
  ineligible: "This answer is not eligible for an AI explanation.",
};
