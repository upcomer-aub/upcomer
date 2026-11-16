// Marking a mock exam answer against an admin's answer key (US-49). Pure: no database access, so it is unit tested on its
// own and the same rules run everywhere.
//
// Past papers come with no answer keys, so nothing is marked against a guess. An admin writes an answer key for a question
// group: the key points a full answer must cover, and an explanation. An answer is marked by which key points it covers:
// a key point counts as covered when every one of its important words appears in the answer (in any order, ignoring case,
// accents, punctuation and simple word endings). A question with no key is not marked; the student is told so (NO_KEY),
// and it records no learning event. This is a transparent check of the key points, not a judgement of the whole answer,
// and the result page says so.

export const ANSWER_KEY_MAX_POINTS = 10;
export const ANSWER_KEY_POINT_MAX_LENGTH = 200;
export const ANSWER_KEY_EXPLANATION_MAX_LENGTH = 2000;

export type MarkOutcomeName = "CORRECT" | "PARTIAL" | "INCORRECT" | "UNANSWERED" | "NO_KEY";

export const OUTCOME_LABELS: Record<MarkOutcomeName, string> = {
  CORRECT: "Correct",
  PARTIAL: "Partly correct",
  INCORRECT: "Incorrect",
  UNANSWERED: "Not answered",
  NO_KEY: "Not marked: no answer key",
};

// Words that carry no meaning on their own, so a key point is not "missed" because the answer worded it differently.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "for", "by", "with", "from", "as", "is", "are", "was", "were", "be", "been",
  "it", "its", "this", "that", "these", "those", "which", "who", "what", "when", "where", "how", "why", "than", "then", "so", "such",
  "into", "over", "under", "about", "can", "could", "should", "would", "will", "may", "might", "must", "do", "does", "did", "has", "have",
  "had", "not", "no", "if", "but", "also", "each", "any", "all", "both", "their", "there", "they", "them", "we", "you", "your", "our",
]);

// Lower case, accents removed, anything that is not a letter or a digit becomes a space.
export function normalizeText(value: string) {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// A crude stem, enough for plurals and simple verb forms: "packets" and "packet", "routing", "routes" and "route" (all
// "rout"), "processes" and "process", "queries" and "query".
export function stem(word: string) {
  if (/^\d+$/.test(word) || word.length <= 3) return word;
  let base = word;
  for (const ending of ["ing", "ies", "ied", "es", "ed", "s"]) {
    if (ending === "s" && word.endsWith("ss")) continue;
    if (word.endsWith(ending) && word.length - ending.length >= 3) {
      base = ending === "ies" || ending === "ied" ? `${word.slice(0, -3)}y` : word.slice(0, -ending.length);
      break;
    }
  }
  return base.length > 3 && base.endsWith("e") ? base.slice(0, -1) : base;
}

const stems = (text: string) => normalizeText(text).split(" ").filter(Boolean).map(stem);

// The words of a key point that must appear: every word but the stopwords. A point made only of stopwords (for example
// "it is") keeps all its words, so it can still be matched.
export function importantStems(point: string) {
  const words = normalizeText(point).split(" ").filter(Boolean);
  const kept = words.filter(word => !STOPWORDS.has(word));
  return (kept.length ? kept : words).map(stem);
}

export type Marking = { outcome: MarkOutcomeName; matchedPoints: string[]; missedPoints: string[]; feedback: string | null };
export type AnswerKeyInput = { keyPoints: string[]; explanation: string } | null;

// Marks one answer. answer null or blank = not answered. key null = no key (never guessed).
export function markAnswer(answer: string | null, key: AnswerKeyInput): Marking {
  if (!key || !key.keyPoints.length) {
    return { outcome: "NO_KEY", matchedPoints: [], missedPoints: [], feedback: "This question has no answer key yet, so your answer was not marked." };
  }
  const given = new Set(stems(answer ?? ""));
  if (!given.size) {
    return { outcome: "UNANSWERED", matchedPoints: [], missedPoints: [...key.keyPoints], feedback: explain([...key.keyPoints], key.explanation, true) };
  }
  const matchedPoints: string[] = [];
  const missedPoints: string[] = [];
  for (const point of key.keyPoints) (importantStems(point).every(word => given.has(word)) ? matchedPoints : missedPoints).push(point);
  const outcome: MarkOutcomeName = !missedPoints.length ? "CORRECT" : matchedPoints.length ? "PARTIAL" : "INCORRECT";
  return { outcome, matchedPoints, missedPoints, feedback: outcome === "CORRECT" ? (key.explanation || null) : explain(missedPoints, key.explanation, false) };
}

// The explanation of a mistake: which key points the answer did not cover, then the admin's explanation.
function explain(missed: string[], explanation: string, unanswered: boolean) {
  const lead = unanswered ? "You did not answer. A full answer covers:" : "Your answer does not cover:";
  return [`${lead} ${missed.map(point => `"${point}"`).join("; ")}.`, explanation].filter(Boolean).join("\n\n");
}

// Credit for one question: the share of key points covered (null when it is not marked).
export const creditOf = (marking: { outcome: MarkOutcomeName; matchedPoints: string[]; missedPoints: string[] }) =>
  marking.outcome === "NO_KEY" ? null : marking.matchedPoints.length / Math.max(1, marking.matchedPoints.length + marking.missedPoints.length);

// The learning event a marked question records: correct only when every key point is covered. NO_KEY records nothing.
export const eventCorrect = (outcome: MarkOutcomeName) => (outcome === "NO_KEY" ? null : outcome === "CORRECT");

export type AnswerKeyError = "points_required" | "too_many_points" | "point_too_long" | "explanation_too_long" | "not_found" | "rate_limited" | "unexpected";

const KEY_MESSAGES: Record<AnswerKeyError, string> = {
  points_required: "Write at least one key point, one per line.",
  too_many_points: `Keep the answer key to ${ANSWER_KEY_MAX_POINTS} key points or fewer.`,
  point_too_long: `Keep each key point to ${ANSWER_KEY_POINT_MAX_LENGTH} characters or fewer.`,
  explanation_too_long: `Keep the explanation to ${ANSWER_KEY_EXPLANATION_MAX_LENGTH} characters or fewer.`,
  not_found: "That question is no longer in this course's question bank.",
  rate_limited: "Too many answer keys saved in a minute. Wait a moment and try again.",
  unexpected: "The answer key could not be saved. Please try again.",
};

export const answerKeyMessage = (error: string) => (Object.hasOwn(KEY_MESSAGES, error) ? KEY_MESSAGES[error as AnswerKeyError] : KEY_MESSAGES.unexpected);

// Checks an admin's answer key: one key point per line (blank lines dropped, spacing collapsed, repeats dropped).
export function parseAnswerKey(input: { keyPoints: string; explanation: string }):
  { ok: true; keyPoints: string[]; explanation: string } | { ok: false; error: AnswerKeyError } {
  const seen = new Set<string>();
  const keyPoints = input.keyPoints.split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim()).filter(line => {
    const key = normalizeText(line);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const explanation = input.explanation.replace(/\r\n?/g, "\n").trim();
  if (!keyPoints.length) return { ok: false, error: "points_required" };
  if (keyPoints.length > ANSWER_KEY_MAX_POINTS) return { ok: false, error: "too_many_points" };
  if (keyPoints.some(point => point.length > ANSWER_KEY_POINT_MAX_LENGTH)) return { ok: false, error: "point_too_long" };
  if (explanation.length > ANSWER_KEY_EXPLANATION_MAX_LENGTH) return { ok: false, error: "explanation_too_long" };
  return { ok: true, keyPoints, explanation };
}
