// Pure grouping (US-15a, US-15b) and ranking (US-16) of a course's extracted questions. No database access, so the same
// input always gives the same groups in the same order.

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

// Reworded equivalents (US-15b). Two questions are compared by their content words: what is left after dropping function
// words and the instruction ("Explain", "Describe", "What is"), folding plurals, and mapping a few exam synonyms
// ("difference between" = "compare"). Plain numbers are ignored, so the same exercise with other values matches.
// Precision comes first, because a wrong merge hides a question from students:
// - One version may only add words to the other (a subset). Swapping one content word for another (TCP/UDP,
//   insertion/selection, graph/tree) always keeps two questions apart, however long they are.
// - The shared words must cover at least REWORDED_THRESHOLD of both versions (Dice coefficient).
// - Math expressions (x^2, a+b, x=3), negations ("not", "except"), and a calculation against an explanation must match.
// - A number that names what is asked about ("layer 3", "RFC 793", "port 80") must match. Other numbers are values and
//   may differ, but only in questions of MIN_WORDS_FOR_OTHER_NUMBERS content words or more.
export const REWORDED_THRESHOLD = 0.75;
// A reworded match below this score is grouped, but logged so an admin can check it (question_grouping_low_confidence).
export const LOW_CONFIDENCE_BELOW = 0.85;
const MIN_WORDS_FOR_OTHER_NUMBERS = 3;

const STOP_WORDS = new Set(`
  a an the of to in on at by for from with into onto over under about as and or but if then than that this these those
  it its is are was were be been being am do does did done doing has have had having can could would should will shall
  may might must what which who whom whose when where why how whether there here please following given your you we our
  us they their them i me my he she his her also each any some all both either neither such so very just only other
  another more most between among within during using use used uses usage purpose role function means meaning mean
  explain describe description define definition discuss state list name give write show prove identify outline mention
  illustrate elaborate tell clarify summarize summarise briefly brief short shortly detail details detailed main concept
  concepts term terms example examples answer question questions part mark marks point points way ways number e g ie eg
`.split(/\s+/).filter(Boolean));
// Words of an explanation task; an explanation never matches a calculation of the same thing.
const EXPLAIN_WORDS = new Set(["explain", "describe", "discuss", "define", "why", "justify", "clarify", "elaborate"]);
// Calculation verbs are folded into one marker instead of being compared as words.
const COMPUTE_WORDS = new Set(["calculate", "compute", "determine", "evaluate", "solve", "derive", "obtain", "estimate", "find"]);
// A number right after one of these names the thing asked about ("layer 3", "chapter 2"); any other number is a value
// ("a 1500-byte packet") and may differ between versions of the same exercise.
const IDENTIFIER_NOUNS = new Set(`
  layer rfc chapter section part question phase stage step level type class case version figure table problem
  exercise lab lecture week unit page line row column node router host port process thread bit topic item option rule
  theorem lemma equation algorithm program task category tier generation
`.split(/\s+/).filter(Boolean));
const NUMBER = /^\p{N}+(?:[.,]\p{N}+)*$/u;
const NEGATIONS = new Set(["not", "no", "never", "none", "without", "except", "false", "incorrect", "invalid", "cannot"]);
const SYNONYMS: Record<string, string> = Object.fromEntries(Object.entries({
  compare: ["difference", "differ", "compare", "comparison", "contrast", "distinguish", "differentiate", "versus", "vs"],
  advantage: ["advantage", "benefit", "merit", "strength", "pro"],
  disadvantage: ["disadvantage", "drawback", "limitation", "weakness", "demerit", "con"],
  step: ["step", "stage", "phase"],
  work: ["work", "operate", "operation", "operating"],
}).flatMap(([canonical, words]) => words.map(word => [word, canonical])));

// Plurals and third-person verbs fold to one form: "queries"/"query", "resolves"/"resolve", "switches"/"switch".
function stem(word: string) {
  if (word.length <= 3 || /(?:ss|us|is)$/.test(word)) return word;
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:sses|shes|ches|xes|zes)$/.test(word)) return word.slice(0, -2);
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

const commonPrefix = (a: string, b: string) => {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length++;
  return length;
};

// Two forms of one word: "forward"/"forwarded", "normalize"/"normalization", or one typo in a long word as in US-15a.
// "connection"/"connectionless" are opposites, so a "-less" form never matches.
function sameWord(a: string, b: string) {
  if (a === b) return true;
  // A numbered name ("layer#3") only ever matches itself.
  if (a.includes("#") || b.includes("#")) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.endsWith("less") && !short.endsWith("less")) return false;
  if (short.length >= 5 && long.startsWith(short)) return true;
  const prefix = commonPrefix(short, long);
  if (prefix >= 6 && prefix >= short.length * 0.75) return true;
  return short.length >= MIN_TYPO_WORD_LENGTH && short[0] === long[0] && editDistance(short, long, 1) <= 1;
}

export type QuestionFeatures = { words: string[]; numbers: string[]; math: string[]; negations: string[]; computes: boolean; explains: boolean };

const sortedUnique = (values: string[]) => [...new Set(values)].sort();

// The comparable parts of a question for reworded matching. Exported for the US-93 accuracy evaluation and for tests.
export function questionFeatures(text: string): QuestionFeatures {
  // "What's" is "What is", "doesn't" is "does not"; other endings such as a possessive "'s" are dropped.
  const expanded = text.normalize("NFKC").replace(/(\p{L})n['’]t\b/gu, "$1 not").replace(/(\p{L})['’](?:s|re|ll|ve|d|m)\b/gu, "$1");
  const words: string[] = [];
  const numbers: string[] = [];
  const math: string[] = [];
  const negations: string[] = [];
  let computes = false;
  let explains = false;
  const parts: string[] = [];
  for (const token of normalizeQuestionText(expanded).split(" ").filter(Boolean)) {
    if (NUMBER.test(token)) {
      parts.push(token);
      continue;
    }
    // "three-way", "TCP/IP", and "1500-byte" are words joined together; "a-b", "x^2", and "i/o" are expressions.
    const joined = token.split(/[-/]/);
    if (/^[\p{L}\p{N}]+(?:[-/][\p{L}\p{N}]+)*$/u.test(token) && joined.every(part => part.length >= 2 || NUMBER.test(part))) parts.push(...joined);
    else if (!/^\p{L}$/u.test(token)) math.push(token); // a lone letter is a sub-part label such as "(a)"
  }
  for (const [index, part] of parts.entries()) {
    if (NUMBER.test(part)) {
      // "layer 3", "RFC 793", "topic number 5": the number says which one is meant, so it has to match. "Number" itself
      // is looked past, so "the binary number 1101" stays a value.
      const before = parts[index - 1] === "number" || parts[index - 1] === "no" ? index - 2 : index - 1;
      const noun = stem(parts[before] ?? "");
      if (IDENTIFIER_NOUNS.has(noun)) words.push(`${noun}#${part}`);
      else numbers.push(part);
      continue;
    }
    if (COMPUTE_WORDS.has(part)) {
      computes = true;
      continue;
    }
    if (EXPLAIN_WORDS.has(part)) explains = true;
    if (NEGATIONS.has(part)) {
      negations.push(part === "cannot" ? "not" : part);
      continue;
    }
    if (STOP_WORDS.has(part) || part.length < 2) continue;
    const stemmed = stem(part);
    words.push(SYNONYMS[stemmed] ?? SYNONYMS[part] ?? stemmed);
  }
  return { words: sortedUnique(words), numbers: [...numbers].sort(), math: sortedUnique(math), negations: sortedUnique(negations), computes, explains };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

// The share of content words two versions have in common (Dice coefficient), or 0 when they cannot be the same question.
export function rewordedScore(a: QuestionFeatures, b: QuestionFeatures) {
  if (!a.words.length || !b.words.length) return 0;
  if (!sameList(a.math, b.math) || !sameList(a.negations, b.negations)) return 0;
  if ((a.computes && b.explains && !b.computes) || (b.computes && a.explains && !a.computes)) return 0;
  if (!sameList(a.numbers, b.numbers) && Math.min(a.words.length, b.words.length) < MIN_WORDS_FOR_OTHER_NUMBERS) return 0;
  // Exact words are paired first, then other forms of a word, each word of b at most once; the lists are sorted, so the
  // pairing never depends on the input order.
  const unused = new Set(b.words);
  let shared = 0;
  const leftover: string[] = [];
  for (const word of a.words) {
    if (unused.delete(word)) shared++;
    else leftover.push(word);
  }
  for (const word of leftover) {
    const match = [...unused].find(candidate => sameWord(word, candidate));
    if (match === undefined) continue;
    unused.delete(match);
    shared++;
  }
  // A content word on each side with no partner is a substitution, so the questions ask about different things.
  if (shared < a.words.length && shared < b.words.length) return 0;
  return (2 * shared) / (a.words.length + b.words.length);
}

export type QuestionMatch = { kind: "identical" | "near_identical" | "reworded"; score: number } | null;

// How two questions match, if at all: the decision groupQuestions makes for one question and a group's first question.
export function matchQuestions(a: string, b: string): QuestionMatch {
  const [keyA, keyB] = [normalizeQuestionText(a), normalizeQuestionText(b)];
  if (!keyA || !keyB) return null;
  if (keyA === keyB) return { kind: "identical", score: 1 };
  if (isNearIdentical(keyA, keyB)) return { kind: "near_identical", score: 1 };
  const score = rewordedScore(questionFeatures(a), questionFeatures(b));
  return score >= REWORDED_THRESHOLD ? { kind: "reworded", score } : null;
}

export type SourceQuestion = { id: string; fileId: string; number: number; text: string; year: number | null };
// A question that joined its group only as a reworded equivalent of the group's first question, with its score (US-15b).
export type RewordedMatch = { questionId: string; matchedQuestionId: string; score: number };
export type GroupedQuestions = { normalizedText: string; text: string; questions: SourceQuestion[]; reworded: RewordedMatch[] };
export type RankedGroup = GroupedQuestions & { paperCount: number; rank: number; latestYear: number | null };

const byPaperThenPosition = (a: SourceQuestion, b: SourceQuestion) =>
  a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : a.number - b.number || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Each question joins the first group whose key is identical or near-identical to its own; failing that, the group whose
// first question it best rewords (US-15b; a tie goes to the earlier group). A group is compared by its first question only,
// so a chain of small typos or rewordings can never pull two different questions together.
export function groupQuestions(questions: SourceQuestion[]): GroupedQuestions[] {
  const groups: GroupedQuestions[] = [];
  const byKey = new Map<string, GroupedQuestions>();
  const featuresOf = new Map<GroupedQuestions, QuestionFeatures>();
  for (const question of [...questions].sort(byPaperThenPosition)) {
    const key = normalizeQuestionText(question.text);
    if (!key) continue;
    let group = byKey.get(key) ?? groups.find(candidate => isNearIdentical(candidate.normalizedText, key));
    if (!group) {
      const features = questionFeatures(question.text);
      let best = REWORDED_THRESHOLD;
      for (const candidate of groups) {
        const score = rewordedScore(features, featuresOf.get(candidate)!);
        if (score >= best && !(group && score === best)) [group, best] = [candidate, score];
      }
      if (group) group.reworded.push({ questionId: question.id, matchedQuestionId: group.questions[0].id, score: Math.round(best * 100) / 100 });
    }
    if (group) {
      group.questions.push(question);
      byKey.set(key, group);
    } else {
      const created: GroupedQuestions = { normalizedText: key, text: cleanQuestionText(question.text), questions: [question], reworded: [] };
      groups.push(created);
      featuresOf.set(created, questionFeatures(question.text));
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
