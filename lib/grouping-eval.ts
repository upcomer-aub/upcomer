import { groupQuestions, rankGroups, type GroupedQuestions, type SourceQuestion } from "@/lib/question-grouping";

// US-93: accuracy of question grouping (US-15a) and ranking (US-16) against a hand-checked evaluation set.
// Pure functions, no database: the set's question texts go through the same grouping the app uses, and the result is compared
// with the set's correct ("gold") groups. Used by `npm run eval:grouping` (eval/run-grouping.ts) and its tests.

// One paper of the set. Each question is [gold group ID, question text as extracted]; its number is its position, from 1.
export type EvalPaper = { id: string; course: string; title: string; year: number | null; questions: Array<[string, string]> };
export type EvalDataset = {
  name: string;
  // Raised whenever the papers or their gold groups change, so a baseline is only ever compared with the set it came from.
  version: number;
  description: string;
  // Why a gold decision was made, for the questions a reviewer could read either way. Keyed by gold group ID.
  notes?: Record<string, string>;
  papers: EvalPaper[];
};

// Anything that groups one course's questions: the current rules, or later a model or prompt (US-15b).
export type Grouper = { name: string; version: string; group(questions: SourceQuestion[]): GroupedQuestions[] };
export const RULES_GROUPER: Grouper = { name: "rules", version: "lib/question-grouping.ts", group: groupQuestions };

export const METRICS = ["pairPrecision", "pairRecall", "pairF1", "exactGroups", "countAccuracy", "rankCorrelation", "topPrecision"] as const;
export type MetricName = (typeof METRICS)[number];
export type Metrics = Record<MetricName, number>;

export const METRIC_LABELS: Record<MetricName, string> = {
  pairPrecision: "Pair precision (questions grouped together that really are the same question)",
  pairRecall: "Pair recall (copies of the same question that were grouped together)",
  pairF1: "Pair F1",
  exactGroups: "Gold groups reproduced exactly",
  countAccuracy: "Questions shown with the right paper count",
  rankCorrelation: "Rank correlation with the gold ranking (Kendall tau-b)",
  topPrecision: "Top 5 precision (predicted top 5 that belong in the gold top 5)",
};

export const TOP_K = 5;

type Item = SourceQuestion & { course: string; gold: string };
const pairs = (n: number) => (n * (n - 1)) / 2;
const ratio = (part: number, whole: number) => (whole === 0 ? 1 : part / whole);
const round = (value: number) => Math.round(value * 10_000) / 10_000;

function itemsOf(dataset: EvalDataset): Item[] {
  return dataset.papers.flatMap(paper => paper.questions.map(([gold, text], index) => ({
    id: `${paper.id}#${index + 1}`, fileId: paper.id, number: index + 1, text, year: paper.year, course: paper.course, gold: `${paper.course}/${gold}`,
  })));
}

// The set must be usable before it is scored: unique paper IDs, at least one question each, and no empty text or group ID.
export function validateDataset(dataset: EvalDataset): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(dataset.version) || dataset.version < 1) problems.push("version must be a whole number from 1");
  const ids = new Set<string>();
  for (const paper of dataset.papers) {
    if (ids.has(paper.id)) problems.push(`paper ${paper.id} appears twice`);
    ids.add(paper.id);
    if (!paper.questions.length) problems.push(`paper ${paper.id} has no questions`);
    paper.questions.forEach(([gold, text], index) => {
      if (!gold.trim()) problems.push(`paper ${paper.id} question ${index + 1} has no gold group`);
      if (!text.trim()) problems.push(`paper ${paper.id} question ${index + 1} has no text`);
    });
  }
  for (const id of Object.keys(dataset.notes ?? {})) {
    if (!dataset.papers.some(paper => paper.questions.some(([gold]) => gold === id))) problems.push(`note for unknown group ${id}`);
  }
  return problems;
}

// Kendall tau-b between two rankings given as scores (higher is better), with ties in either. 1 = same order, -1 = reversed.
export function kendallTauB(a: number[], b: number[]) {
  let concordant = 0, discordant = 0, tiesA = 0, tiesB = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const da = Math.sign(a[i] - a[j]);
      const db = Math.sign(b[i] - b[j]);
      if (da === 0 && db === 0) continue;
      if (da === 0) tiesA++;
      else if (db === 0) tiesB++;
      else if (da === db) concordant++;
      else discordant++;
    }
  }
  const denominator = Math.sqrt((concordant + discordant + tiesA) * (concordant + discordant + tiesB));
  // No order to compare: 1 if both rankings tie everything (they agree), 0 if only one does (it says nothing).
  if (denominator === 0) return concordant + discordant + tiesA + tiesB === 0 ? 1 : 0;
  return (concordant - discordant) / denominator;
}

export type GroupComparison = { gold: string; questions: string[]; goldPapers: number; predictedPapers: number; splitInto: number; mergedWith: string[] };
export type Evaluation = { metrics: Metrics; questionCount: number; goldGroups: number; predictedGroups: number; comparisons: GroupComparison[] };

// Groups and ranks each course of the set with the grouper and scores the result against the gold groups.
// - Pair precision, recall, and F1 count every pair of questions of a course: "grouped together" against "really the same".
// - Exact groups: gold groups whose questions form exactly one predicted group, with nothing else in it.
// - Count accuracy: questions whose predicted group has the same number of distinct papers as their gold group, which is the
//   "Appeared in X of Y papers" a student sees.
// - Rank correlation: Kendall tau-b between the gold groups' paper counts and the counts of the predicted group holding most of
//   each gold group's questions, so it measures whether the most frequent questions come out on top.
// - Top 5 precision: of the predicted top 5 groups (in the app's rank order), how many are, by their main gold group, frequent
//   enough to be in the gold top 5 (ties at the cut-off count as in).
export function evaluateGrouping(dataset: EvalDataset, grouper: Grouper = RULES_GROUPER): Evaluation {
  const items = itemsOf(dataset);
  // Predicted group of each question; a question the grouper drops (no text left) is a group of its own.
  const predicted = new Map<string, string>();
  const ranked: Array<{ key: string; course: string; paperCount: number; rank: number }> = [];
  for (const course of [...new Set(items.map(item => item.course))]) {
    const courseItems = items.filter(item => item.course === course);
    const groups = rankGroups(grouper.group(courseItems.map(({ id, fileId, number, text, year }) => ({ id, fileId, number, text, year }))));
    groups.forEach((group, index) => {
      const key = `${course}/p${index}`;
      for (const question of group.questions) predicted.set(question.id, key);
      ranked.push({ key, course, paperCount: group.paperCount, rank: group.rank });
    });
    for (const item of courseItems) if (!predicted.has(item.id)) predicted.set(item.id, `${course}/dropped/${item.id}`);
  }

  const goldMembers = new Map<string, Item[]>();
  for (const item of items) goldMembers.set(item.gold, [...(goldMembers.get(item.gold) ?? []), item]);
  const predictedMembers = new Map<string, Item[]>();
  for (const item of items) predictedMembers.set(predicted.get(item.id)!, [...(predictedMembers.get(predicted.get(item.id)!) ?? []), item]);
  const papersOf = (members: Item[]) => new Set(members.map(member => member.fileId)).size;

  // Pairs counted from the contingency of gold and predicted groups.
  const both = new Map<string, number>();
  for (const item of items) {
    const key = `${item.gold}\u0000${predicted.get(item.id)}`;
    both.set(key, (both.get(key) ?? 0) + 1);
  }
  const truePairs = [...both.values()].reduce((sum, n) => sum + pairs(n), 0);
  const predictedPairs = [...predictedMembers.values()].reduce((sum, members) => sum + pairs(members.length), 0);
  const goldPairs = [...goldMembers.values()].reduce((sum, members) => sum + pairs(members.length), 0);
  const pairPrecision = ratio(truePairs, predictedPairs);
  const pairRecall = ratio(truePairs, goldPairs);
  const pairF1 = pairPrecision + pairRecall === 0 ? 0 : (2 * pairPrecision * pairRecall) / (pairPrecision + pairRecall);

  const comparisons: GroupComparison[] = [];
  let exact = 0;
  const goldScores: number[] = [];
  const predictedScores: number[] = [];
  for (const [gold, members] of goldMembers) {
    const keys = members.map(member => predicted.get(member.id)!);
    const counts = new Map<string, number>();
    keys.forEach(key => counts.set(key, (counts.get(key) ?? 0) + 1));
    const main = [...counts].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0][0];
    const mergedWith = [...new Set([...counts.keys()].flatMap(key => predictedMembers.get(key)!.map(member => member.gold)).filter(other => other !== gold))].sort();
    if (counts.size === 1 && !mergedWith.length) exact++;
    goldScores.push(papersOf(members));
    predictedScores.push(papersOf(predictedMembers.get(main)!));
    comparisons.push({ gold, questions: members.map(member => member.id), goldPapers: papersOf(members), predictedPapers: papersOf(predictedMembers.get(main)!), splitInto: counts.size, mergedWith });
  }

  const goldPapersOf = new Map([...goldMembers].map(([gold, members]) => [gold, papersOf(members)]));
  const rightCount = items.filter(item => papersOf(predictedMembers.get(predicted.get(item.id)!)!) === goldPapersOf.get(item.gold)).length;

  // Top 5 per course, averaged over courses, so a course with more groups does not weigh more.
  const courses = [...new Set(items.map(item => item.course))];
  const topPrecision = courses.reduce((sum, course) => {
    const goldCounts = [...goldMembers].filter(([gold]) => gold.startsWith(`${course}/`)).map(([, members]) => papersOf(members)).sort((x, y) => y - x);
    const cutOff = goldCounts[Math.min(TOP_K, goldCounts.length) - 1] ?? 0;
    const top = ranked.filter(group => group.course === course).sort((x, y) => x.rank - y.rank).slice(0, TOP_K);
    const mainGold = (key: string) => {
      const counts = new Map<string, number>();
      predictedMembers.get(key)!.forEach(member => counts.set(member.gold, (counts.get(member.gold) ?? 0) + 1));
      return [...counts].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0][0];
    };
    return sum + ratio(top.filter(group => goldPapersOf.get(mainGold(group.key))! >= cutOff).length, top.length);
  }, 0) / Math.max(1, courses.length);

  const metrics: Metrics = {
    pairPrecision: round(pairPrecision), pairRecall: round(pairRecall), pairF1: round(pairF1),
    exactGroups: round(ratio(exact, goldMembers.size)), countAccuracy: round(ratio(rightCount, items.length)),
    rankCorrelation: round(kendallTauB(goldScores, predictedScores)), topPrecision: round(topPrecision),
  };
  return { metrics, questionCount: items.length, goldGroups: goldMembers.size, predictedGroups: predictedMembers.size, comparisons };
}

// The stored result a later run is compared with. It records which set and which grouper produced it.
export type Baseline = { dataset: string; datasetVersion: number; grouper: string; metrics: Metrics; recordedAt: string };
// A metric may drop by at most this much from the baseline (absolute), and never below its floor.
export type Thresholds = { maxDrop: number; floors: Partial<Metrics> };
export const DEFAULT_THRESHOLDS: Thresholds = { maxDrop: 0.02, floors: { pairPrecision: 0.95, pairF1: 0.6, rankCorrelation: 0.6 } };

export type Check = { metric: MetricName; baseline: number | null; current: number; change: number | null; passed: boolean; reason?: string };
export type Comparison = { passed: boolean; problems: string[]; checks: Check[] };

// Compares a run with the baseline. Fails on a drop larger than maxDrop, on a value under its floor, and on a baseline that was
// recorded for another version of the set (the numbers would not be comparable).
export function compareWithBaseline(dataset: EvalDataset, metrics: Metrics, baseline: Baseline | null, thresholds: Thresholds = DEFAULT_THRESHOLDS): Comparison {
  const problems: string[] = [];
  if (!baseline) problems.push("No baseline for this set. Review the result and record one with --update-baseline.");
  else if (baseline.dataset !== dataset.name || baseline.datasetVersion !== dataset.version) {
    problems.push(`The baseline is for ${baseline.dataset} v${baseline.datasetVersion}, not ${dataset.name} v${dataset.version}. Review the result and record a new one with --update-baseline.`);
  }
  const usable = problems.length === 0 ? baseline : null;
  const checks = METRICS.map((metric): Check => {
    const current = metrics[metric];
    const previous = usable ? usable.metrics[metric] : null;
    const change = previous === null ? null : round(current - previous);
    const floor = thresholds.floors[metric];
    if (floor !== undefined && current < floor) return { metric, baseline: previous, current, change, passed: false, reason: `below the floor of ${floor}` };
    if (change !== null && change < -thresholds.maxDrop) return { metric, baseline: previous, current, change, passed: false, reason: `dropped by more than ${thresholds.maxDrop}` };
    return { metric, baseline: previous, current, change, passed: true };
  });
  return { passed: problems.length === 0 && checks.every(check => check.passed), problems, checks };
}
