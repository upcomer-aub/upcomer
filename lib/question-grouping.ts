// Pure grouping (US-15a) and ranking (US-16) of a course's extracted questions. No database access, so the same input
// always gives the same groups in the same order.

// "Q3.", "Question 2)", "3." or "(4)" at the start, and marks such as "(10 points)" or "[5 marks]" anywhere.
const LEADING_NUMBER = /^\s*(?:(?:question|q)\s*\d+[a-z]?\s*[.):-]?|\d+[a-z]?\s*[.)]|\(\d+[a-z]?\))(?:\s+|$)/i;
const MARKS = /[([]\s*\d+(?:\.\d+)?\s*(?:points?|pts?|marks?)\s*[)\]]/gi;
// Sentence punctuation is ignored; math symbols (+ - * / = < > ^ %) are kept, so "a+b" and "a-b" stay different questions.
const PROSE_PUNCTUATION = /[.,;:!?'"`´‘’“”()[\]{}…]/g;
// Spacing next to a symbol is ignored, so "x + y" and "x+y" match.
const SPACE_AROUND_SYMBOL = /\s*([^\p{L}\p{N}\s])\s*/gu;

// Display text: the question as written, without its number or marks.
export const cleanQuestionText = (text: string) => text.replace(LEADING_NUMBER, "").replace(MARKS, " ").replace(/\s+/g, " ").trim();

// Grouping key: case, spacing, punctuation, numbering, and marks do not matter.
export function normalizeQuestionText(text: string) {
  return cleanQuestionText(text).normalize("NFKC").toLowerCase()
    .replace(PROSE_PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .replace(SPACE_AROUND_SYMBOL, "$1")
    .trim();
}

// Optimal string alignment distance (Levenshtein plus swapping two neighbouring letters), stopping early above `max`.
function editDistance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous2: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, previous2[j - 2] + 1);
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    previous2 = previous;
    previous = current;
  }
  return previous[b.length];
}

const MIN_TYPO_WORD_LENGTH = 6;
// Words per allowed typo: one typo in a short question, two from 16 words, and so on.
const WORDS_PER_TYPO = 8;

// Near-identical: the same words in the same order, except a few long words that differ by one typo
// ("recieve"/"receive", "normalise"/"normalize"). A typo keeps the first letter, so real words such as "cable"/"table" or
// "cyclic"/"acyclic" stay different. Numbers, symbols, and short words such as acronyms must match exactly, so "TCP"/"UDP"
// or "x^2"/"x^3" are different questions.
export function isNearIdentical(a: string, b: string) {
  if (a === b) return true;
  const wordsA = a.split(" ");
  const wordsB = b.split(" ");
  if (wordsA.length !== wordsB.length) return false;
  const allowed = Math.max(1, Math.floor(wordsA.length / WORDS_PER_TYPO));
  let typos = 0;
  for (let index = 0; index < wordsA.length; index++) {
    const [wordA, wordB] = [wordsA[index], wordsB[index]];
    if (wordA === wordB) continue;
    const isTypo = wordA.length >= MIN_TYPO_WORD_LENGTH && wordB.length >= MIN_TYPO_WORD_LENGTH
      && wordA[0] === wordB[0] && /^\p{L}+$/u.test(wordA) && /^\p{L}+$/u.test(wordB) && editDistance(wordA, wordB, 1) <= 1;
    if (!isTypo || ++typos > allowed) return false;
  }
  return true;
}

export type SourceQuestion = { id: string; fileId: string; number: number; text: string; year: number | null };
export type GroupedQuestions = { normalizedText: string; text: string; questions: SourceQuestion[] };
export type RankedGroup = GroupedQuestions & { paperCount: number; rank: number; latestYear: number | null };

const byPaperThenPosition = (a: SourceQuestion, b: SourceQuestion) =>
  a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : a.number - b.number || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Each question joins the first group whose key is identical or near-identical to its own; a group is compared by its
// first question only, so a chain of small typos can never pull two different questions together.
export function groupQuestions(questions: SourceQuestion[]): GroupedQuestions[] {
  const groups: GroupedQuestions[] = [];
  const byKey = new Map<string, GroupedQuestions>();
  for (const question of [...questions].sort(byPaperThenPosition)) {
    const key = normalizeQuestionText(question.text);
    if (!key) continue;
    const group = byKey.get(key) ?? groups.find(candidate => isNearIdentical(candidate.normalizedText, key));
    if (group) {
      group.questions.push(question);
      byKey.set(key, group);
    } else {
      const created = { normalizedText: key, text: cleanQuestionText(question.text), questions: [question] };
      groups.push(created);
      byKey.set(key, created);
    }
  }
  return groups;
}

// Admin corrections (question corrections) on top of the automatic grouping. A question pinned to another one joins the group
// that question ends up in, wherever its text would put it; a split question gets a group of its own that nothing else joins.
// A pin to a question that is gone (deleted, or its paper moved to another course) or a loop of pins counts as no pin.
export type CorrectedQuestion = SourceQuestion & { pinnedToQuestionId?: string | null; splitOut?: boolean };

// The group key of a split question. Grouping keys never contain ":" (it is removed as punctuation), so this one is unique.
export const splitGroupKey = (normalizedText: string, questionId: string) => `${normalizedText} #split:${questionId}`;

export function groupCorrectedQuestions(questions: CorrectedQuestion[]): GroupedQuestions[] {
  const byId = new Map(questions.map(question => [question.id, question]));
  const keyOf = (question: CorrectedQuestion) => normalizeQuestionText(question.text);
  // The question a pin chain ends at: a split question, an unpinned one, or the last one before a missing anchor or a loop.
  const rootOf = (question: CorrectedQuestion) => {
    const seen = new Set<string>();
    let current = question;
    while (!current.splitOut && current.pinnedToQuestionId) {
      seen.add(current.id);
      const next = byId.get(current.pinnedToQuestionId);
      if (!next) break;
      if (seen.has(next.id)) return question;
      current = next;
    }
    return current;
  };
  const roots = new Map(questions.map(question => [question.id, rootOf(question)]));
  // A pin whose root has no group (no text left after cleaning) is ignored, so the question is grouped by its own text.
  const followsPin = (question: CorrectedQuestion) => !question.splitOut && roots.get(question.id) !== question && Boolean(keyOf(roots.get(question.id)!));
  const split = questions.filter(question => question.splitOut);
  const pinned = questions.filter(followsPin);
  const groups = groupQuestions(questions.filter(question => !question.splitOut && !followsPin(question)));
  for (const question of [...split].sort(byPaperThenPosition)) {
    const key = keyOf(question);
    if (key) groups.push({ normalizedText: splitGroupKey(key, question.id), text: cleanQuestionText(question.text), questions: [question] });
  }
  const groupOf = new Map(groups.flatMap(group => group.questions.map(question => [question.id, group] as const)));
  for (const question of [...pinned].sort(byPaperThenPosition)) groupOf.get(roots.get(question.id)!.id)?.questions.push(question);
  return groups;
}

// Most papers first; ties go to the question seen most recently, then to the text, so the order never depends on input order.
export function rankGroups(groups: GroupedQuestions[]): RankedGroup[] {
  return groups
    .map(group => {
      const years = group.questions.map(question => question.year).filter((year): year is number => year !== null);
      return { ...group, paperCount: new Set(group.questions.map(question => question.fileId)).size, latestYear: years.length ? Math.max(...years) : null };
    })
    .sort((a, b) => b.paperCount - a.paperCount || (b.latestYear ?? 0) - (a.latestYear ?? 0)
      || (a.normalizedText < b.normalizedText ? -1 : a.normalizedText > b.normalizedText ? 1 : 0))
    .map((group, index) => ({ ...group, rank: index + 1 }));
}
