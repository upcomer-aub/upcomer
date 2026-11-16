import { FileCategory } from "@prisma/client";
import { db } from "@/lib/db";
import { PUBLISHED_FILES } from "@/lib/file-visibility";
import { isLowConfidence, tierFor, type LikelihoodTier } from "@/lib/likelihood-tiers";
import { logError } from "@/lib/logger";
import { sourceQuestionOf } from "@/lib/mock-exam-rules";
import { getQuestionBank, type QuestionBankGroup } from "@/lib/question-bank";
import { cleanQuestionText } from "@/lib/question-grouping";

// The consolidated ordered exam of a course (US-18): every distinct question once, in ranking order, with its repetition
// evidence (US-17) and likelihood tier (US-19). Built on the ranked question bank in lib/question-bank.ts.

export type ExamPaper = QuestionBankGroup["papers"][number];
export type ExamQuestion = {
  // US-29: populated only in the authenticated personal order.
  priorityExplanation?: string;
  id: string;
  // 1..N down the whole exam, in ranking order.
  position: number;
  rank: number;
  // The full question as extracted, sub-parts included, one per line.
  text: string;
  // "Appeared in X of Y papers": X is the distinct papers of the course the question appeared in, Y the course's papers.
  paperCount: number;
  totalPapers: number;
  // Each paper once, newest first.
  papers: ExamPaper[];
  tier: LikelihoodTier;
  // US-51: the stored source question its "Step-by-step walkthrough" link opens (see walkthroughSourceOf); null or
  // missing means no link.
  sourceQuestionId?: string | null;
};
// A run of consecutive questions in one tier. Tiers follow the ranking, so the exam reads top to bottom in rank order.
export type ExamSection = { tier: LikelihoodTier; questions: ExamQuestion[] };
export type ConsolidatedExam = { totalPapers: number; lowConfidence: boolean; questions: ExamQuestion[]; sections: ExamSection[] };

// The question as written, without its number or marks, keeping the line breaks between its sub-parts. Spacing inside a
// line is tidied and empty lines are dropped. A first line that is only a number ("Question 3") is dropped too.
export function fullQuestionText(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!lines.length) return "";
  lines[0] = cleanQuestionText(lines[0]);
  return lines.filter(Boolean).join("\n");
}

// The source question the group's text was taken from, so the exam reads like the question bank. If that paper was deleted
// since the last regroup, the next source question stands in.
function groupText(group: QuestionBankGroup) {
  const source = group.questions.find(question => cleanQuestionText(question.text) === group.text) ?? group.questions[0];
  return (source && fullQuestionText(source.text)) || group.text;
}

// US-51: the group's source question a walkthrough is made of. The one whose text the card shows (as groupText picks it),
// when its paper is one of the course's published papers counted here, so the walkthrough page shows the question the
// student just read; otherwise the group's source question as mock exams choose it (sourceQuestionOf, US-45). Null when the
// group has no question on a counted paper.
export function walkthroughSourceOf(group: Pick<QuestionBankGroup, "text" | "questions">, papers: Array<{ id: string }>): string | null {
  const shown = group.questions.find(question => cleanQuestionText(question.text) === group.text);
  if (shown && papers.some(paper => paper.id === shown.fileId)) return shown.id;
  return sourceQuestionOf(papers, group.questions);
}

function sectionsOf(questions: ExamQuestion[]) {
  const sections: ExamSection[] = [];
  for (const question of questions) {
    const last = sections.at(-1);
    if (last?.tier === question.tier) last.questions.push(question);
    else sections.push({ tier: question.tier, questions: [question] });
  }
  return sections;
}

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

export async function getConsolidatedExam(courseId: string): Promise<ConsolidatedExam> {
  // getQuestionBank logs its own failures; the paper list is logged here.
  const [bank, coursePapers] = await Promise.all([
    getQuestionBank(courseId),
    // Only published papers count (US-13): a pending or rejected submission never changes X or Y.
    db.courseFile.findMany({ where: { courseId, category: FileCategory.EXAM, ...PUBLISHED_FILES, questions: { some: {} } }, select: { id: true } }).catch(error => {
      logError("question_bank_retrieval_failed", { courseId, source: "consolidated_exam", errorType: errorType(error) });
      throw error;
    }),
  ]);
  // Only the course's own exam papers count. A paper moved to another course, or made a material, still sits in its old
  // groups until an admin regroups; it is left out here so X never counts a paper that Y does not.
  const paperIds = new Set(coursePapers.map(paper => paper.id));
  const totalPapers = paperIds.size;
  const questions = bank.groups
    .map(group => ({ group, papers: group.papers.filter(paper => paperIds.has(paper.id)) }))
    .filter(({ papers }) => papers.length > 0)
    .map(({ group, papers }, index): ExamQuestion => ({
      id: group.id, position: index + 1, rank: group.rank, text: groupText(group),
      paperCount: papers.length, totalPapers, papers, tier: tierFor(papers.length, totalPapers),
      sourceQuestionId: walkthroughSourceOf(group, papers),
    }));
  return { totalPapers, lowConfidence: isLowConfidence(totalPapers), questions, sections: sectionsOf(questions) };
}
