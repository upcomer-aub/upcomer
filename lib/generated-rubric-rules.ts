import { boundedText, hasFields } from "@/lib/ai-prompt-data";
import { ANSWER_KEY_EXPLANATION_MAX_LENGTH, ANSWER_KEY_MAX_POINTS, ANSWER_KEY_POINT_MAX_LENGTH, parseAnswerKey } from "@/lib/mock-marking-rules";

export type Rubric = { keyPoints: string[]; explanation: string };

export function readGeneratedRubric(value: unknown): Rubric | null {
  if (!hasFields(value, ["keyPoints", "explanation"]) || !Array.isArray(value.keyPoints)
    || value.keyPoints.length < 1 || value.keyPoints.length > ANSWER_KEY_MAX_POINTS
    || !value.keyPoints.every(point => boundedText(point, ANSWER_KEY_POINT_MAX_LENGTH) && !/[\r\n]/.test(point))
    || !boundedText(value.explanation, ANSWER_KEY_EXPLANATION_MAX_LENGTH)) return null;
  const parsed = parseAnswerKey({ keyPoints: value.keyPoints.join("\n"), explanation: value.explanation });
  if (!parsed.ok || parsed.keyPoints.length !== value.keyPoints.length) return null;
  return { keyPoints: parsed.keyPoints, explanation: parsed.explanation };
}
