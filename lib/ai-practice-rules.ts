import type { AiPrompt } from "@/lib/ai-client";
import { boundedText, delimitedJsonMessages, hasFields } from "@/lib/ai-prompt-data";
import { readGeneratedRubric, type Rubric } from "@/lib/generated-rubric-rules";
import { isWeakness, NEUTRAL_WEAKNESS, type LearningProfile } from "@/lib/learning-profile";
import { ANSWER_KEY_EXPLANATION_MAX_LENGTH, ANSWER_KEY_MAX_POINTS, ANSWER_KEY_POINT_MAX_LENGTH } from "@/lib/mock-marking-rules";
import { contentHash, type Difficulty } from "@/lib/practice-generation-rules";
import { isUsableQuestion } from "@/lib/question-content";
import { normalizeQuestionText } from "@/lib/question-grouping";

export const AI_PRACTICE_VERSION = "practice-v1";
export const MAX_PRACTICE_QUESTION_LENGTH = 1200;
export const MAX_PRACTICE_SOURCE_LENGTH = 1500;
const MAX_SOURCES = 12;

type Topic = { key: string; label: string };
export type PracticeExcerpt = { sourceRef: string; topicKey: string; excerpt: string };
export type PracticePromptInput = {
  course: { code: string; name: string };
  topics: Topic[];
  sources: PracticeExcerpt[];
  difficulty: Difficulty;
  count: number;
};
export type PracticeDraft = { sourceRef: string; topicKey: string; question: string; rubric: Rubric };

export function choosePracticeSources<T extends { topicKey: string }>(sources: T[], explicitTopic?: string, profile?: LearningProfile): T[] {
  if (explicitTopic) return sources.filter(source => source.topicKey === explicitTopic).slice(0, MAX_SOURCES);
  const buckets = new Map<string, T[]>();
  for (const source of sources) {
    const bucket = buckets.get(source.topicKey);
    if (!bucket) buckets.set(source.topicKey, [source]);
    else if (bucket.length < MAX_SOURCES) bucket.push(source);
  }
  const weakness = (key: string) => {
    const value = profile?.get(key)?.weakness;
    return isWeakness(value) && value > NEUTRAL_WEAKNESS ? value : NEUTRAL_WEAKNESS;
  };
  const ordered = [...buckets].sort(([a], [b]) => weakness(b) - weakness(a));
  const weak = ordered.filter(([key]) => weakness(key) > NEUTRAL_WEAKNESS);
  const selected = [];
  // When the profile has weak eligible topics, concentrate on those topics. Otherwise sample topics evenly.
  for (let i = 0; i < MAX_SOURCES && selected.length < MAX_SOURCES; i++) {
    for (const [, bucket] of weak.length ? weak : ordered) {
      if (bucket[i]) selected.push(bucket[i]);
      if (selected.length === MAX_SOURCES) break;
    }
  }
  return selected;
}

export function practiceMessages(input: PracticePromptInput) {
  return delimitedJsonMessages(
    `Create exactly the requested number of distinct, self-contained university practice questions at the requested difficulty in the supplied course and topics. Use only the supplied excerpts for course scope. Each question must use one supplied source reference and its matching topic key. Write a new problem that a student can solve with the information in the question. Give a draft rubric with a worked explanation and concise key points whose important words a full answer should contain. Do not restate the source verbatim or refer to the source inside the new question.
Return {"questions":[{"sourceRef":"...","topicKey":"...","question":"...","rubric":{"keyPoints":["..."],"explanation":"..."}}]}. Questions may use up to ${MAX_PRACTICE_QUESTION_LENGTH} characters. Use 1 to ${ANSWER_KEY_MAX_POINTS} key points of at most ${ANSWER_KEY_POINT_MAX_LENGTH} characters each, and a worked explanation of at most ${ANSWER_KEY_EXPLANATION_MAX_LENGTH} characters.`,
    {
      course: { code: input.course.code, name: input.course.name },
      topics: input.topics.map(({ key, label }) => ({ key, label })),
      sources: input.sources.map(({ sourceRef, topicKey, excerpt }) => ({ sourceRef, topicKey, excerpt })),
      difficulty: input.difficulty,
      count: input.count,
    },
  );
}

function validatePractice(content: string, input: PracticePromptInput) {
  const invalid = { ok: false as const, error: "invalid_practice_batch" };
  if (content.length > 80_000) return invalid;
  let data: unknown;
  try { data = JSON.parse(content); } catch { return invalid; }
  if (!hasFields(data, ["questions"]) || !Array.isArray(data.questions) || data.questions.length !== input.count) return invalid;
  const topics = new Set(input.topics.map(topic => topic.key));
  const sources = new Map(input.sources.map(source => [source.sourceRef, source]));
  const seen = new Set(input.sources.map(source => contentHash(source.excerpt)));
  const value: PracticeDraft[] = [];
  for (const item of data.questions) {
    if (!hasFields(item, ["sourceRef", "topicKey", "question", "rubric"])
      || typeof item.sourceRef !== "string" || typeof item.topicKey !== "string"
      || sources.get(item.sourceRef)?.topicKey !== item.topicKey || !topics.has(item.topicKey)
      || !boundedText(item.question, MAX_PRACTICE_QUESTION_LENGTH, 10) || !isUsableQuestion({ text: item.question })
      || !normalizeQuestionText(item.question)) return invalid;
    const question = item.question.trim();
    const hash = contentHash(question);
    const rubric = readGeneratedRubric(item.rubric);
    if (seen.has(hash) || !rubric) return invalid;
    seen.add(hash);
    value.push({ sourceRef: item.sourceRef, topicKey: item.topicKey, question, rubric });
  }
  return { ok: true as const, value };
}

export const aiPracticePrompt: AiPrompt<PracticePromptInput, PracticeDraft[]> = {
  feature: "practice", version: AI_PRACTICE_VERSION, messages: practiceMessages, validate: validatePractice,
};
