import { creditOf, type MarkOutcomeName } from "@/lib/mock-marking-rules";

// The results report of a marked mock exam (US-50). Pure: built only from the stored marking of each question (US-49), so
// the score and the topic breakdown always match the actual answers and their missed key points.
//
// The score counts only marked questions. A question with no answer key (NO_KEY) is listed apart, as not marked, and never
// counts as right or wrong: the report does not guess. "Credit" is the share of key points covered, averaged over the
// marked questions, so a partly correct answer counts in part.

export type ResultQuestion = {
  id: string; position: number; topic: string | null; text: string;
  outcome: MarkOutcomeName | null; matchedPoints: string[]; missedPoints: string[]; feedback: string | null;
};

export type OutcomeCounts = Record<MarkOutcomeName, number>;
export type TopicResult = { topic: string; questions: number; marked: number; counts: OutcomeCounts; credit: number | null };
export type ResultsReport = {
  questions: number;
  marked: number;
  counts: OutcomeCounts;
  // Share of key points covered over the marked questions (0 to 1); null when nothing could be marked.
  credit: number | null;
  topics: TopicResult[];
  // Marked questions that were not fully right, in exam order, with what was missed.
  missed: ResultQuestion[];
  // Questions with no answer key, in exam order.
  notMarked: ResultQuestion[];
};

export const NO_TOPIC = "No topic";
const emptyCounts = (): OutcomeCounts => ({ CORRECT: 0, PARTIAL: 0, INCORRECT: 0, UNANSWERED: 0, NO_KEY: 0 });

function summarize(questions: ResultQuestion[]) {
  const counts = emptyCounts();
  let creditSum = 0;
  let marked = 0;
  for (const question of questions) {
    // An exam marked before a question had an outcome cannot happen (marking writes them all), but a missing outcome is
    // treated as not marked rather than as wrong.
    const outcome = question.outcome ?? "NO_KEY";
    counts[outcome]++;
    const credit = creditOf({ outcome, matchedPoints: question.matchedPoints, missedPoints: question.missedPoints });
    if (credit !== null) {
      marked++;
      creditSum += credit;
    }
  }
  return { counts, marked, credit: marked ? creditSum / marked : null };
}

export function buildResultsReport(questions: ResultQuestion[]): ResultsReport {
  const ordered = [...questions].sort((a, b) => a.position - b.position);
  const overall = summarize(ordered);
  const byTopic = new Map<string, ResultQuestion[]>();
  for (const question of ordered) {
    const topic = question.topic?.trim() || NO_TOPIC;
    byTopic.set(topic, [...(byTopic.get(topic) ?? []), question]);
  }
  // Weakest topics first (lowest credit), so the report starts with what to work on; topics that could not be marked go
  // last; ties by name.
  const topics = [...byTopic.entries()].map(([topic, items]): TopicResult => ({ topic, questions: items.length, ...summarize(items) }))
    .sort((a, b) => (a.credit ?? 2) - (b.credit ?? 2) || a.topic.localeCompare(b.topic));
  return {
    questions: ordered.length,
    marked: overall.marked,
    counts: overall.counts,
    credit: overall.credit,
    topics,
    missed: ordered.filter(question => question.outcome === "PARTIAL" || question.outcome === "INCORRECT" || question.outcome === "UNANSWERED"),
    notMarked: ordered.filter(question => !question.outcome || question.outcome === "NO_KEY"),
  };
}

export const percent = (share: number | null) => (share === null ? "–" : `${Math.round(share * 100)}%`);
