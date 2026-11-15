import { mockExamMessage, type GeneratedCandidate, type PoolQuestion } from "@/lib/mock-exam-rules";
import { normalizeQuestionText } from "@/lib/question-grouping";

// US-46: an alternative version of a mock exam. Pure rules shared by the service, the action, and the page.
//
// A version keeps the original's settings (topics, length, difficulty, generated questions) and shares no question with
// the original or any earlier version (as agreed: version 3 avoids the questions of versions 1 and 2). "The same question"
// is matched two ways: by its question-bank group or generated item, and by its text, normalized as grouping does (case,
// spacing, numbering, marks). The text also catches a question whose stored group ID was nulled by a regroup and that now
// comes back under a new group.

export type UsedQuestion = { groupId: string | null; generatedQuestionId: string | null; text: string };
export type AvoidSet = { ids: ReadonlySet<string>; texts: ReadonlySet<string> };

export function avoidSetOf(used: UsedQuestion[]): AvoidSet {
  const ids = new Set<string>();
  const texts = new Set<string>();
  for (const question of used) {
    if (question.groupId) ids.add(question.groupId);
    if (question.generatedQuestionId) ids.add(question.generatedQuestionId);
    const text = normalizeQuestionText(question.text);
    if (text) texts.add(text);
  }
  return { ids, texts };
}

// The IDs to pass as selectMockQuestions' `exclude` (Mustafa's US-45 contract): every past-paper question and generated
// item already used in the family, by ID or by text.
export function excludedIds(pool: Pick<PoolQuestion, "id" | "text">[], generated: Pick<GeneratedCandidate, "id" | "text">[], avoid: AvoidSet): Set<string> {
  const excluded = new Set(avoid.ids);
  for (const item of [...pool, ...generated]) if (avoid.texts.has(normalizeQuestionText(item.text))) excluded.add(item.id);
  return excluded;
}

export type VersionError = "not_found" | "not_enough_questions" | "topic_invalid" | "no_questions" | "course_not_found" | "rate_limited" | "unexpected";

export function versionMessage(error: string, available?: number, length?: number) {
  switch (error) {
    case "not_found": return "That mock exam doesn't exist.";
    case "not_enough_questions": {
      if (available === undefined || length === undefined) return "There are not enough unused questions left for another version with these settings.";
      const left = available === 0
        ? "Every question matching these settings is already in this exam or one of its versions"
        : `Only ${available} unused ${available === 1 ? "question matches" : "questions match"} these settings (not in this exam or any of its versions)`;
      return `${left}, and a new version needs ${length}. Make a new mock exam with other topics or a shorter length instead.`;
    }
    case "topic_invalid": return "One of this exam's topics is no longer in the course, so a version with the same settings can't be made.";
    case "no_questions": case "course_not_found": case "rate_limited": return mockExamMessage(error);
    default: return "The alternative version could not be made. Please try again.";
  }
}

// Version numbers in the order the exams were made: the original is version 1.
export function numberVersions<T extends { id: string; createdAt: Date }>(family: T[]): Array<T & { version: number }> {
  return [...family].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((exam, index) => ({ ...exam, version: index + 1 }));
}
