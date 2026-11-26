import { createHash } from "node:crypto";
import { normalizeQuestionText } from "@/lib/question-grouping";

export const GENERATOR_VERSION = "grounded-study-tasks-v1";
export const difficulties = ["EASY", "MEDIUM", "HARD"] as const;
export type Difficulty = typeof difficulties[number];
export const sourceFingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
export const contentHash = (text: string) => sourceFingerprint(normalizeQuestionText(text));
export type GenerationSettings = { count: number; difficulty: Difficulty; topicKey?: string };
export const validGenerationSettings = (settings: GenerationSettings) =>
  Number.isInteger(settings.count) && settings.count >= 1 && settings.count <= 10
  && difficulties.includes(settings.difficulty) && (settings.topicKey?.length ?? 0) <= 100;

export function parseGenerationSettings(form: Pick<FormData, "get">): GenerationSettings | null {
  const count = String(form.get("count") ?? "");
  const difficulty = String(form.get("difficulty") ?? "");
  const topicKey = String(form.get("topicKey") ?? "").trim();
  if (!/^(?:[1-9]|10)$/.test(count) || !difficulties.includes(difficulty as Difficulty) || topicKey.length > 100) return null;
  return { count: Number(count), difficulty: difficulty as Difficulty, topicKey: topicKey || undefined };
}

// Offline, deterministic generation of new reasoning tasks around actual course-paper contexts. No numeric facts,
// model-generated answer keys or unsupported solutions are invented. Difficulty describes the requested reasoning,
// not a calibrated prediction of student success. Three distinct tasks per source/difficulty; refuse when exhausted.
const tasks: Record<Difficulty, string[]> = {
  EASY: [
    "Which concepts and definitions are needed to approach this problem? Explain how each connects to the given context.",
    "Separate the given information from the unknowns in this problem. What would you need to determine first, and why?",
    "What assumptions would you need to check before solving this problem? Explain which details support each assumption.",
  ],
  MEDIUM: [
    "Design a solution plan for this problem without completing the calculation. Explain why each step follows from the previous one.",
    "Propose a way to check a solution to this problem. Explain what an incorrect result would reveal and which checks depend on missing information.",
    "Identify a plausible misconception when approaching this problem. Explain how you would detect and correct it, stating any assumptions.",
  ],
  HARD: [
    "Compare two possible approaches to this problem. State the conditions under which each is valid and justify your preferred approach.",
    "Choose one assumption in this problem and analyze what would change if it no longer held. Distinguish what can be concluded from what needs more evidence.",
    "Generalize the reasoning needed for this problem. State the limits of the generalization and propose a boundary case that would test it.",
  ],
};
export function groundedPrompts(source: string, difficulty: Difficulty) {
  return tasks[difficulty].map(task => `Course-paper context:\n${source.trim()}\n\nPractice task:\n${task}`);
}

export type GenerationError = "invalid_settings" | "not_found" | "no_sources" | "insufficient_novel_questions" | "rate_limited" | "ai_unavailable" | "ai_rate_limited" | "ai_failed" | "source_changed" | "unexpected";
const messages: Record<GenerationError, string> = {
  invalid_settings: "Choose 1 to 10 questions and a difficulty.",
  not_found: "This course is not available.",
  no_sources: "No published, topic-tagged exam questions match these settings yet.",
  insufficient_novel_questions: "There are not enough new questions for these settings. Request fewer, choose another topic or difficulty, or add more course papers.",
  rate_limited: "Too many generation requests. Wait a minute and try again.",
  ai_unavailable: "AI practice is unavailable. You can still use Template practice.",
  ai_rate_limited: "Too many AI practice requests. Try again later or use Template practice.",
  ai_failed: "AI practice could not create a valid batch. Try again or use Template practice.",
  source_changed: "A source changed during generation. Try again or use Template practice.",
  unexpected: "Practice questions could not be generated. Please try again.",
};
export const generationMessage = (reason: string) => messages[reason as GenerationError] ?? messages.unexpected;
