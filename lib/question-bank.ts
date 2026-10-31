import { ExamType, FileCategory, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { PUBLISHED_FILES } from "@/lib/file-visibility";
import { logError } from "@/lib/logger";

import { groupCorrectedQuestions, normalizeQuestionText, rankGroups } from "@/lib/question-grouping";

import { groupQuestions, LOW_CONFIDENCE_BELOW, normalizeQuestionText, rankGroups, type RankedGroup } from "@/lib/question-grouping";


const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

// Only questions from published exam papers are grouped (US-13); the course is always the paper's current course.
export const courseExams = (courseId: string): Prisma.CourseFileWhereInput => ({ courseId, category: FileCategory.EXAM, ...PUBLISHED_FILES });

export type RebuildResult = { ok: true; groupCount: number; questionCount: number } | { ok: false; error: "not_found" | "unexpected" };


// Regroups (US-15a) and re-ranks (US-16) every question of a course. Call it after questions are added, changed, or removed,
// or after a paper moves to another course (for both courses). Groups whose key is unchanged keep their ID.
// Admin corrections (pinned and split questions, see lib/question-corrections.ts) are applied on every rebuild, so they survive it.

// At most this many low-confidence matches are logged one by one per rebuild; the summary line always has the full count.
export const MAX_LOGGED_LOW_CONFIDENCE = 20;

// Monitoring of the grouping decisions (US-15b): one summary line per rebuild, and one line per reworded match the
// matcher was unsure about, so an admin can check those groups. Only IDs and scores are logged, never question text.
function logGroupingDecisions(courseId: string, groups: RankedGroup[], questionCount: number) {
  const reworded = groups.flatMap(group => group.reworded);
  const unsure = reworded.filter(match => match.score < LOW_CONFIDENCE_BELOW);
  logError("question_grouping_completed", {
    courseId, questionCount: String(questionCount), groupCount: String(groups.length),
    rewordedMatches: String(reworded.length), lowConfidenceMatches: String(unsure.length),
  });
  for (const match of unsure.slice(0, MAX_LOGGED_LOW_CONFIDENCE)) {
    logError("question_grouping_low_confidence", { courseId, questionId: match.questionId, matchedQuestionId: match.matchedQuestionId, score: match.score.toFixed(2) });
  }
}

// Regroups (US-15a, US-15b) and re-ranks (US-16) every question of a course. Call it after questions are added, changed, or
// removed, or after a paper moves to another course (for both courses). Groups whose key is unchanged keep their ID.

export async function rebuildQuestionBank(courseId: string): Promise<RebuildResult> {
  try {
    const course = await db.course.findUnique({ where: { id: courseId }, select: { id: true } });
    if (!course) {
      logError("question_grouping_rejected", { courseId, reason: "course_not_found" });
      return { ok: false, error: "not_found" };
    }
    let decisions: RankedGroup[] = [];
    const result = await db.$transaction(async tx => {
      // One rebuild per course at a time; a second one waits and then sees the first one's result.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${courseId}))`;
      const questions = await tx.question.findMany({
        where: { file: courseExams(courseId) },
        select: { id: true, fileId: true, number: true, text: true, groupId: true, pinnedToQuestionId: true, splitOut: true, file: { select: { year: true } } },
      });

      const ranked = rankGroups(groupCorrectedQuestions(questions.map(({ id, fileId, number, text, pinnedToQuestionId, splitOut, file }) => ({ id, fileId, number, text, pinnedToQuestionId, splitOut, year: file.year }))));

      const ranked = rankGroups(groupQuestions(questions.map(({ file, ...question }) => ({ ...question, year: file.year }))));
      decisions = ranked;

      await tx.questionGroup.deleteMany({ where: { courseId, normalizedText: { notIn: ranked.map(group => group.normalizedText) } } });
      // Written in a few batched statements rather than one per group, so a large paper regroups quickly (US-14 cross-test).
      const existing = new Map((await tx.questionGroup.findMany({
        where: { courseId }, select: { id: true, normalizedText: true, text: true, paperCount: true, rank: true },
      })).map(group => [group.normalizedText, group]));
      const added = ranked.filter(group => !existing.has(group.normalizedText));
      const groupIds = new Map([...existing].map(([key, group]) => [key, group.id]));
      if (added.length) {
        const created = await tx.questionGroup.createManyAndReturn({
          data: added.map(group => ({ courseId, normalizedText: group.normalizedText, text: group.text, paperCount: group.paperCount, rank: group.rank })),
          select: { id: true, normalizedText: true },
        });
        created.forEach(group => groupIds.set(group.normalizedText, group.id));
      }
      for (const group of ranked) {
        const old = existing.get(group.normalizedText);
        if (old && (old.text !== group.text || old.paperCount !== group.paperCount || old.rank !== group.rank)) {
          await tx.questionGroup.update({ where: { id: old.id }, data: { text: group.text, paperCount: group.paperCount, rank: group.rank } });
        }
      }
      // Questions with no text left after cleaning (for example only a number) belong to no group.
      const target = new Map<string, string | null>(questions.map(question => [question.id, null]));
      for (const group of ranked) for (const question of group.questions) target.set(question.id, groupIds.get(group.normalizedText)!);
      const moved = questions.filter(question => question.groupId !== target.get(question.id));
      const regrouped = moved.filter(question => target.get(question.id) !== null);
      if (regrouped.length) {
        const ids = regrouped.map(question => question.id);
        const newGroupIds = regrouped.map(question => target.get(question.id)!);
        await tx.$executeRaw`UPDATE "Question" SET "groupId" = v.group_id, "updatedAt" = NOW() FROM unnest(${ids}::text[], ${newGroupIds}::text[]) AS v(id, group_id) WHERE "Question"."id" = v.id`;
      }
      const ungrouped = moved.filter(question => target.get(question.id) === null).map(question => question.id);
      if (ungrouped.length) await tx.question.updateMany({ where: { id: { in: ungrouped } }, data: { groupId: null } });
      return { ok: true as const, groupCount: ranked.length, questionCount: questions.length };
    }, { timeout: 30_000 });
    // Logged only once the transaction committed, so the monitoring page never shows decisions that were rolled back.
    logGroupingDecisions(courseId, decisions, result.questionCount);
    return result;
  } catch (error) {
    logError("question_grouping_failed", { courseId, errorType: errorType(error) });
    return { ok: false, error: "unexpected" };
  }
}

export type QuestionBankFilters = { query?: string; year?: string; termId?: string; examType?: string; professorId?: string };

// Unusable values (a year that isn't 4 digits, an unknown type) are dropped, the same as leaving the filter empty.
export function parseQuestionBankFilters(filters: QuestionBankFilters = {}) {
  const year = filters.year?.trim() ?? "";
  const examType = filters.examType?.trim().toUpperCase() ?? "";
  return {
    query: filters.query?.trim() ?? "",
    year: /^\d{4}$/.test(year) ? Number(year) : undefined,
    termId: filters.termId?.trim() || undefined,
    examType: (Object.values(ExamType) as string[]).includes(examType) ? (examType as ExamType) : undefined,
    professorId: filters.professorId?.trim() || undefined,
  };
}

const groupInclude = {
  course: { select: { id: true, code: true, name: true } },
  questions: {
    // Defense in depth: the rebuild never groups an unpublished paper's questions (US-13).
    where: { file: PUBLISHED_FILES },
    select: {
      id: true, number: true, text: true, fileId: true,
      file: { select: { id: true, title: true, year: true, examType: true, term: { select: { id: true, name: true } }, professor: { select: { id: true, name: true } } } },
    },
    orderBy: [{ fileId: "asc" }, { number: "asc" }],
  },
} satisfies Prisma.QuestionGroupInclude;

type GroupRow = Prisma.QuestionGroupGetPayload<{ include: typeof groupInclude }>;
type Paper = GroupRow["questions"][number]["file"];

// One entry per paper, newest first; a question repeated inside one paper lists that paper once.
function papersOf(group: GroupRow): Paper[] {
  const papers = new Map<string, Paper>();
  for (const question of group.questions) papers.set(question.file.id, question.file);
  return [...papers.values()].sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1));
}

export type QuestionBankGroup = {
  id: string;
  rank: number;
  text: string;
  paperCount: number;
  course: GroupRow["course"];
  questions: Array<{ id: string; number: number; text: string; fileId: string }>;
  papers: Paper[];
};
export type QuestionBank = { totalPapers: number; groups: QuestionBankGroup[] };

// The ranked question bank of a course, most frequent first (rank 1). Shared with Member 3's evidence, consolidated exam,
// and likelihood tiers: each group has its text, course, rank, paper count, every source question, and the papers.
// totalPapers is the number of the course's exam papers with at least one extracted question ("X of Y papers").
// The keyword and the paper filters (US-20) combine, and the ranking order is kept.
export async function getQuestionBank(courseId: string, filters: QuestionBankFilters = {}): Promise<QuestionBank> {
  const { query, ...paper } = parseQuestionBankFilters(filters);
  const paperFilter: Prisma.CourseFileWhereInput = Object.fromEntries(Object.entries(paper).filter(([, value]) => value !== undefined));
  const filtered = Boolean(query) || Object.keys(paperFilter).length > 0;
  try {
    const [totalPapers, rows] = await Promise.all([
      db.courseFile.count({ where: { ...courseExams(courseId), questions: { some: {} } } }),
      db.questionGroup.findMany({
        // A group left with no questions (its papers were deleted) is skipped until the next rebuild.
        // One paper has to match every filter, so "2024" and "Final" means a 2024 final, not a 2024 midterm plus a final.
        where: { courseId, questions: { some: { file: { ...paperFilter, ...PUBLISHED_FILES } } } },
        include: groupInclude,
        orderBy: { rank: "asc" },
      }),
    ]);
    // The keyword is matched the way questions are grouped, so case, spacing, and punctuation do not matter.
    const keyword = normalizeQuestionText(query);
    const matches = (group: GroupRow) => !keyword || group.normalizedText.includes(keyword)
      || group.questions.some(question => normalizeQuestionText(question.text).includes(keyword));
    const groups = rows.filter(matches).map((group): QuestionBankGroup => ({
      id: group.id, rank: group.rank, text: group.text, paperCount: group.paperCount, course: group.course,
      questions: group.questions.map(({ id, number, text, fileId }) => ({ id, number, text, fileId })),
      papers: papersOf(group),
    }));
    return { totalPapers, groups };
  } catch (error) {
    logError(filtered ? "question_search_failed" : "question_bank_retrieval_failed", {
      courseId, year: paper.year === undefined ? undefined : String(paper.year), termId: paper.termId, examType: paper.examType,
      professorId: paper.professorId, errorType: errorType(error),
    });
    throw error;
  }
}

// The years, terms, types, and professors of the course's papers that have questions, for the US-20 dropdowns.
export async function getQuestionBankFilterOptions(courseId: string) {
  try {
    const papers = await db.courseFile.findMany({
      where: { ...courseExams(courseId), questions: { some: {} } },
      select: { year: true, examType: true, term: { select: { id: true, name: true } }, professor: { select: { id: true, name: true } } },
    });
    const unique = <T extends { id: string; name: string }>(items: Array<T | null>) =>
      [...new Map(items.filter((item): item is T => item !== null).map(item => [item.id, item])).values()].sort((a, b) => a.name.localeCompare(b.name));
    return {
      years: [...new Set(papers.map(paper => paper.year).filter((year): year is number => year !== null))].sort((a, b) => b - a),
      examTypes: Object.values(ExamType).filter(type => papers.some(paper => paper.examType === type)),
      terms: unique(papers.map(paper => paper.term)),
      professors: unique(papers.map(paper => paper.professor)),
    };
  } catch (error) {
    logError("question_bank_retrieval_failed", { courseId, errorType: errorType(error) });
    throw error;
  }
}

// Admin overview: every course with extracted questions, how many, and how many groups they form.
export async function getQuestionBankOverview() {
  try {
    const [papers, courses] = await Promise.all([
      db.courseFile.findMany({ where: { category: FileCategory.EXAM, ...PUBLISHED_FILES, questions: { some: {} } }, select: { courseId: true, _count: { select: { questions: true } } } }),
      db.course.findMany({ select: { id: true, code: true, name: true, _count: { select: { questionGroups: true } } }, orderBy: { code: "asc" } }),
    ]);
    const questionCounts = new Map<string, { papers: number; questions: number }>();
    for (const paper of papers) {
      const counts = questionCounts.get(paper.courseId) ?? { papers: 0, questions: 0 };
      questionCounts.set(paper.courseId, { papers: counts.papers + 1, questions: counts.questions + paper._count.questions });
    }
    return courses
      .filter(course => questionCounts.has(course.id) || course._count.questionGroups > 0)
      .map(({ _count, ...course }) => ({ ...course, groupCount: _count.questionGroups, ...(questionCounts.get(course.id) ?? { papers: 0, questions: 0 }) }));
  } catch (error) {
    logError("question_bank_retrieval_failed", { errorType: errorType(error) });
    throw error;
  }
}
