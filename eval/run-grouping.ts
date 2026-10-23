import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  compareWithBaseline, evaluateGrouping, METRIC_LABELS, RULES_GROUPER, validateDataset, type Baseline, type Comparison, type EvalDataset, type Evaluation,
} from "@/lib/grouping-eval";

// US-93: grouping and ranking accuracy on a hand-checked evaluation set.
//   npm run eval:grouping                          the committed set, eval/grouping/synthetic
//   npm run eval:grouping -- <set folder>          another set, for example eval/grouping/local/math201-quiz1 (not committed)
//   npm run eval:grouping -- <folder> --details    also list every gold group the grouping got wrong
//   npm run eval:grouping -- <folder> --gold       list the gold groups, for reviewing the set
//   npm run eval:grouping -- <folder> --update-baseline   record this result as the new baseline (after reviewing it)
// A set folder holds dataset.json and baseline.json. The run prints precision, recall, and the other metrics, compares them with
// the baseline, writes reports/eval-grouping-<set>-<date>.md, and exits with 1 if a metric dropped too far or is under its floor.

const args = process.argv.slice(2);
const folder = args.find(arg => !arg.startsWith("--")) ?? "eval/grouping/synthetic";
const flag = (name: string) => args.includes(`--${name}`);
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const signed = (value: number | null) => (value === null ? "-" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)} pts`);

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function goldListing(dataset: EvalDataset) {
  const groups = new Map<string, string[]>();
  for (const paper of dataset.papers) {
    paper.questions.forEach(([gold, text], index) => {
      const key = `${paper.course} / ${gold}`;
      groups.set(key, [...(groups.get(key) ?? []), `${paper.title}, Q${index + 1}: ${text.replace(/\s+/g, " ")}`]);
    });
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, questions]) => [
    `### ${key} (${questions.length} ${questions.length === 1 ? "question" : "questions"})`,
    ...(dataset.notes?.[key.split(" / ")[1]] ? [`> ${dataset.notes[key.split(" / ")[1]]}`, ""] : []),
    ...questions.map(question => `- ${question}`), "",
  ]);
}

function errorListing(evaluation: Evaluation) {
  const wrong = evaluation.comparisons.filter(item => item.splitInto > 1 || item.mergedWith.length);
  if (!wrong.length) return ["Every gold group was reproduced exactly.", ""];
  return [
    "| Gold group | Questions | Papers (gold / shown) | Split into | Merged with |", "| --- | ---: | --- | ---: | --- |",
    ...wrong.map(item => `| ${item.gold} | ${item.questions.length} | ${item.goldPapers} / ${item.predictedPapers} | ${item.splitInto} | ${item.mergedWith.join(", ") || "-"} |`), "",
  ];
}

function report(dataset: EvalDataset, evaluation: Evaluation, comparison: Comparison, baseline: Baseline | null, date: string) {
  return [
    `# Grouping accuracy: ${dataset.name} v${dataset.version} (${date})`, "",
    dataset.description, "",
    `- **Grouper:** ${RULES_GROUPER.name} (${RULES_GROUPER.version})`,
    `- **Set:** ${dataset.papers.length} papers, ${evaluation.questionCount} questions, ${evaluation.goldGroups} gold groups; the grouper made ${evaluation.predictedGroups}.`,
    `- **Baseline:** ${baseline ? `${baseline.grouper}, recorded ${baseline.recordedAt}` : "none"}`,
    `- **Result:** ${comparison.passed ? "passed" : "**failed**"}`, "",
    ...comparison.problems.map(problem => `> ${problem}`), ...(comparison.problems.length ? [""] : []),
    "| Metric | Now | Baseline | Change | Check |", "| --- | ---: | ---: | ---: | --- |",
    ...comparison.checks.map(check => `| ${METRIC_LABELS[check.metric]} | ${percent(check.current)} | ${check.baseline === null ? "-" : percent(check.baseline)} | ${signed(check.change)} | ${check.passed ? "ok" : `**${check.reason}**`} |`),
    "", "## Gold groups the grouping got wrong", "", ...errorListing(evaluation),
  ].join("\n");
}

async function main() {
  const dataset = await readJson<EvalDataset>(path.join(folder, "dataset.json"));
  if (!dataset) throw new Error(`No dataset.json in ${folder}.`);
  const problems = validateDataset(dataset);
  if (problems.length) throw new Error(`The set in ${folder} is not valid:\n- ${problems.join("\n- ")}`);
  if (flag("gold")) {
    console.log([`# Gold groups: ${dataset.name} v${dataset.version}`, "", ...goldListing(dataset)].join("\n"));
    return;
  }
  const evaluation = evaluateGrouping(dataset);
  const baselineFile = path.join(folder, "baseline.json");
  const date = new Date().toISOString().slice(0, 10);
  if (flag("update-baseline")) {
    const baseline: Baseline = { dataset: dataset.name, datasetVersion: dataset.version, grouper: `${RULES_GROUPER.name} (${RULES_GROUPER.version})`, metrics: evaluation.metrics, recordedAt: date };
    await writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Recorded the baseline in ${baselineFile}.`);
  }
  const baseline = await readJson<Baseline>(baselineFile);
  const comparison = compareWithBaseline(dataset, evaluation.metrics, baseline);
  const markdown = report(dataset, evaluation, comparison, baseline, date);
  await mkdir("reports", { recursive: true });
  const reportFile = path.join("reports", `eval-grouping-${dataset.name}-${date}.md`);
  await writeFile(reportFile, `${markdown}\n`);
  console.log(flag("details") ? markdown : markdown.split("\n## Gold groups")[0]);
  console.log(`\nReport: ${reportFile}`);
  if (!comparison.passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
