import { isWeakness, NEUTRAL_WEAKNESS, type LearningProfile } from "@/lib/learning-profile";
import { complexityOf, type GeneratedCandidate, type MockConfig, type PoolQuestion } from "@/lib/mock-exam-rules";
import { checkedPriority, PRIORITY_TIE, type PriorityReason } from "@/lib/personal-order";

// Which questions a mock exam gets (US-45), and how its topics are balanced between the student's weak topics and the
// course's high-frequency topics (US-47). Pure: nothing here reads the database or the clock, and the same pool, settings,
// profile and options always give the same exam, whatever order the inputs arrive in.
//
// One formula at two levels, the personal order's own (US-27, checkedPriority): exam share × (1 + WEAKNESS_WEIGHT × weakness).
//  - A topic's weight uses the number of distinct past papers its questions come from. It is what "Study next" (US-30)
//    ranks topics by. A topic without a profile row uses the neutral weakness.
//  - A question's priority uses the question's own paper count. It orders the generated questions inside a topic.
// Topics the student marked as covered (US-32) are not an input: covered only steers "Study next".

export type SelectOptions = {
  // Alternative versions must retain the original length instead of returning a shorter exam.
  requireFullLength?: boolean;
  // The student's generated practice questions, newest first (US-44). Used only when the settings ask for them.
  generated?: GeneratedCandidate[];
  // IDs (question-bank groups or generated items) to leave out, for an alternative version of an exam (US-46).
  exclude?: ReadonlySet<string>;
  // The student's profile in this course (getLearningProfile). Without it, or with an empty one, every topic has the
  // neutral weakness, so the mix follows exam frequency only.
  profile?: LearningProfile;
};

export type Selection =
  | {
    ok: true;
    // The past-paper picks in the Upcomer Exam's order; `generated` follow them in the exam.
    questions: PoolQuestion[];
    generated: GeneratedCandidate[];
    // The length asked for, and the exam's length: smaller when the chosen topics could not fill the request.
    requested: number;
    length: number;
    // False when every matching past-paper question was needed, so the difficulty could not choose between them.
    narrowed: boolean;
    // Whether the student has a profile row for a topic of this course's questions.
    hasProfile: boolean;
    // The names of the exam's topics the student is weaker in than neutral, weakest first, three at most.
    weakTopics: string[];
    // How many questions each topic got, by topic key ("" for questions without a topic).
    topicCounts: Record<string, number>;
    // Topics whose weight inputs were invalid and replaced by safe values, and why (for one log line).
    invalidTopics: number;
    reasons: PriorityReason[];
  }
  | { ok: false; error: "topic_invalid" | "not_enough_questions"; available: number };

// At most this many weak topics are named on the exam page.
export const MAX_WEAK_TOPICS_NAMED = 3;

type Topic = {
  key: string; label: string | null; past: PoolQuestion[]; candidates: GeneratedCandidate[];
  // Distinct past papers the topic's questions come from.
  papers: number; weakness: number;
  // The student has a stored weakness above neutral for the topic.
  weak: boolean; weight: number;
  // The most questions the topic can give: its past-paper questions, and as many generated ones again at most.
  capacity: number; slots: number;
};

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
// A fixed order for equal claims: the higher weight, then the topic in more papers, then the topic key.
const byStanding = (a: Topic, b: Topic) => (Math.abs(b.weight - a.weight) > PRIORITY_TIE ? b.weight - a.weight : 0) || b.papers - a.papers || byText(a.key, b.key);

// `count` of a topic's questions by difficulty. The questions are sorted by complexity (ties: more frequent first, then
// the Upcomer Exam's order, then ID); EASY takes the first, HARD the last, MEDIUM the middle, and MIXED a spread over the
// whole range.
function byDifficulty(questions: PoolQuestion[], count: number, difficulty: MockConfig["difficulty"]): PoolQuestion[] {
  const ranked = questions.map(question => ({ question, complexity: complexityOf(question.text) })).sort((a, b) =>
    a.complexity - b.complexity || b.question.paperCount - a.question.paperCount || a.question.position - b.question.position || byText(a.question.id, b.question.id));
  const total = ranked.length;
  const window = (start: number) => Array.from({ length: count }, (_, index) => start + index);
  const indexes = difficulty === "EASY" ? window(0)
    : difficulty === "HARD" ? window(total - count)
    : difficulty === "MEDIUM" ? window(Math.floor((total - count) / 2))
    : count === 1 ? [Math.floor((total - 1) / 2)]
    : Array.from({ length: count }, (_, index) => Math.round((index * (total - 1)) / (count - 1)));
  return indexes.map(index => ranked[index].question);
}

// Builds the exam.
//
// 1. Eligible questions are those of the chosen topics (every topic when none is chosen), minus `options.exclude`.
// 2. The exam has the length asked for, or, when the topics cannot fill it, the largest length they can (US-45). It is
//    refused only when nothing matches.
// 3. Each topic gets questions in proportion to its weight: slots are given one at a time to the topic with the highest
//    weight / (2 × slots it already has + 1), never more than it can give. Ties go by byStanding.
// 4. So that both show in the exam, one slot is first reserved for the student's weakest topic (the highest stored
//    weakness above neutral; none without one) and one for the most frequent topic (the most papers). With one slot for
//    two topics, the higher weight gets it.
// 5. Inside a topic the difficulty chooses the questions (byDifficulty).
// 6. Generated questions (US-44), only when the settings ask: of the chosen topics and difficulty (any, for MIXED). They
//    appeared in no paper, so they add nothing to a topic's weight. A topic gives at most half of its slots to them,
//    rounded down, ordered by the question priority of their source question's group (`sourcePaperCount`; 1 when
//    unknown), then in the order given.
export function selectMockQuestions(pool: PoolQuestion[], { topicKeys, length: requested, difficulty, includeGenerated }: MockConfig, options: SelectOptions = {}): Selection {
  const known = new Set(pool.flatMap(question => (question.topicKey ? [question.topicKey] : [])));
  if (topicKeys.some(key => !known.has(key))) return { ok: false, error: "topic_invalid", available: 0 };
  const chosen = new Set(topicKeys);
  const left = (id: string) => !options.exclude?.has(id);
  const profile = options.profile ?? new Map();
  const totalPapers = pool.reduce((most, question) => Math.max(most, question.totalPapers), 0);
  const reasons = new Set<PriorityReason>();
  let invalidTopics = 0;

  const topics = new Map<string, Topic>();
  for (const question of pool) {
    if (!left(question.id) || (chosen.size && (question.topicKey === null || !chosen.has(question.topicKey)))) continue;
    const key = question.topicKey ?? "";
    const topic = topics.get(key) ?? { key, label: question.topic, past: [], candidates: [], papers: 0, weakness: NEUTRAL_WEAKNESS, weak: false, weight: 0, capacity: 0, slots: 0 };
    topic.past.push(question);
    topics.set(key, topic);
  }
  if (includeGenerated) {
    for (const item of options.generated ?? []) {
      if (left(item.id) && (difficulty === "MIXED" || item.difficulty === difficulty)) topics.get(item.topicKey)?.candidates.push(item);
    }
  }
  for (const topic of topics.values()) {
    const papers = new Set(topic.past.flatMap(question => question.papers.map(paper => paper.id ?? `${paper.title}\n${paper.year ?? ""}`)));
    // A pool built without paper lists still knows each question's paper count.
    topic.papers = papers.size || topic.past.reduce((most, question) => Math.max(most, question.paperCount), 0);
    const stored = topic.key ? profile.get(topic.key)?.weakness : undefined;
    const checked = checkedPriority(topic.papers, totalPapers, stored ?? NEUTRAL_WEAKNESS);
    if (checked.reasons.length) invalidTopics++;
    checked.reasons.forEach(reason => reasons.add(reason));
    // An invalid stored weakness counts as it is clamped: out-of-range to the nearest end, not a number to neutral.
    topic.weakness = stored === undefined ? NEUTRAL_WEAKNESS : isWeakness(stored) ? stored : Number.isFinite(stored) ? Math.min(1, Math.max(0, stored)) : NEUTRAL_WEAKNESS;
    topic.weak = stored !== undefined && topic.weakness > NEUTRAL_WEAKNESS;
    topic.weight = checked.priority;
    topic.capacity = topic.past.length + Math.min(topic.candidates.length, topic.past.length);
    const priority = (item: GeneratedCandidate) => checkedPriority(Math.min(item.sourcePaperCount ?? 1, totalPapers), totalPapers, topic.weakness).priority;
    topic.candidates = topic.candidates.map((item, index) => ({ item, index, priority: priority(item) }))
      .sort((a, b) => (Math.abs(b.priority - a.priority) > PRIORITY_TIE ? b.priority - a.priority : 0) || a.index - b.index).map(entry => entry.item);
  }

  const all = [...topics.values()];
  const available = all.reduce((sum, topic) => sum + topic.capacity, 0);
  if (!available || (options.requireFullLength && available < requested)) return { ok: false, error: "not_enough_questions", available };
  const length = Math.min(requested, available);

  // The reserved slots.
  const weakest = all.filter(topic => topic.weak).sort((a, b) => b.weakness - a.weakness || byStanding(a, b))[0];
  const mostFrequent = [...all].sort((a, b) => b.papers - a.papers || byStanding(a, b))[0];
  const reserved = [...new Set([weakest, mostFrequent].filter((topic): topic is Topic => topic !== undefined))].sort(byStanding).slice(0, length);
  for (const topic of reserved) topic.slots = 1;
  // The rest, one slot at a time.
  for (let given = reserved.length; given < length; given++) {
    const quotient = (topic: Topic) => topic.weight / (2 * topic.slots + 1);
    const next = all.filter(topic => topic.slots < topic.capacity)
      .sort((a, b) => (Math.abs(quotient(b) - quotient(a)) > PRIORITY_TIE ? quotient(b) - quotient(a) : 0) || byStanding(a, b))[0];
    next.slots++;
  }

  const questions: PoolQuestion[] = [];
  const generated: GeneratedCandidate[] = [];
  let narrowed = false;
  for (const topic of all) {
    const fromGenerated = Math.min(topic.candidates.length, Math.floor(topic.slots / 2));
    const fromPapers = topic.slots - fromGenerated;
    if (topic.past.length > fromPapers) narrowed = true;
    questions.push(...byDifficulty(topic.past, fromPapers, difficulty));
    generated.push(...topic.candidates.slice(0, fromGenerated));
  }
  // Generated questions keep the order they were given in (newest first).
  const order = new Map((options.generated ?? []).map((item, index) => [item.id, index]));
  return {
    ok: true,
    questions: questions.sort((a, b) => a.position - b.position || byText(a.id, b.id)),
    generated: generated.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
    requested, length, narrowed,
    hasProfile: pool.some(question => question.topicKey !== null && profile.has(question.topicKey)),
    weakTopics: all.filter(topic => topic.weak && topic.slots > 0).sort((a, b) => b.weakness - a.weakness || byStanding(a, b))
      .slice(0, MAX_WEAK_TOPICS_NAMED).map(topic => topic.label ?? topic.key),
    topicCounts: Object.fromEntries(all.filter(topic => topic.slots > 0).sort((a, b) => byText(a.key, b.key)).map(topic => [topic.key, topic.slots])),
    invalidTopics, reasons: [...reasons].sort(),
  };
}
