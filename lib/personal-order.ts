import { db } from "@/lib/db";
import { PUBLISHED_FILES } from "@/lib/file-visibility";
import type { ExamQuestion } from "@/lib/consolidated-exam";
import { getLearningProfile, isWeakness, NEUTRAL_WEAKNESS, questionTopic, type LearningProfile } from "@/lib/learning-profile";
import { logError } from "@/lib/logger";

// The personal order of the Upcomer Exam (US-28): the same questions, reordered by the student's priorities, so their
// weak, high-frequency questions come first. Each question keeps its number (its place in the frequency order), so marks,
// reports, and links to a question mean the same question in both orders. A student without a learning profile in the
// course (US-33) gets the frequency order unchanged.

// The weakness of a topic the student has no score for: US-24's neutral default, the same as for a skipped topic.
export { NEUTRAL_WEAKNESS };

// US-27: how much more the weakest topic counts than the strongest. The weakness factor runs from 1 (weakness 0, the
// strongest topic) to 1 + WEAKNESS_WEIGHT (weakness 1, the weakest): a strong topic still counts at its full exam share,
// so a frequent question never drops out, and the weakest topic counts at most (1 + WEAKNESS_WEIGHT) times as much.
// 2 keeps the 3:1 ratio of the US-28 placeholder (0.5 + weakness), so its orders are unchanged.
export const WEAKNESS_WEIGHT = 2;

export type PriorityReason = "invalid_paper_count" | "invalid_total_papers" | "paper_count_exceeds_total" | "invalid_weakness";

const isCount = (value: number) => Number.isFinite(value) && value >= 0;

// A question's priority for one student (US-27): its exam importance (the share of the course's papers it appeared in)
// times the student's weakness factor in its topic. Higher comes first. Of two equally weak questions the more frequent
// ranks higher; of two equally frequent ones the weaker. Pure: the same inputs always give the same priority.
// Invalid inputs never throw: each is clamped to a safe value and named in `reasons`, for the caller to log once.
export function checkedPriority(paperCount: number, totalPapers: number, weakness: number): { priority: number; reasons: PriorityReason[] } {
  const reasons: PriorityReason[] = [];
  let total = totalPapers;
  if (!isCount(total)) {
    reasons.push("invalid_total_papers");
    total = 0;
  }
  let count = paperCount;
  if (!isCount(count)) {
    reasons.push("invalid_paper_count");
    count = 0;
  } else if (count > total && isCount(totalPapers)) {
    reasons.push("paper_count_exceeds_total");
    count = total;
  }
  let weak = weakness;
  if (!isWeakness(weak)) {
    reasons.push("invalid_weakness");
    weak = Number.isFinite(weak) ? Math.min(1, Math.max(0, weak)) : NEUTRAL_WEAKNESS;
  }
  const share = total > 0 ? count / total : 0;
  return { priority: share * (1 + WEAKNESS_WEIGHT * weak), reasons };
}

// The priority alone. The personal order calls checkedPriority, so it can log invalid inputs once per ranking.
export function personalPriority(paperCount: number, totalPapers: number, weakness: number): number {
  return checkedPriority(paperCount, totalPapers, weakness).priority;
}

export type PersonalOrder = { questions: ExamQuestion[]; hasProfile: boolean };

// Two priorities this close are equal; the frequency order decides between them.
export const PRIORITY_TIE = 1e-9;

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

// Reorders the exam's questions by personalPriority. paperTopics gives each paper's topic (CourseFile.topic); a question's
// topic is its papers' most common one (questionTopic, US-33). Ties keep the frequency order. Without a profile, the
// questions come back in the frequency order. The questions themselves are not changed. Invalid priority inputs are
// logged once per ranking (US-27), with the IDs in `context`, the number of questions affected, and the reasons.
export function personalizeQuestions(
  questions: ExamQuestion[],
  paperTopics: ReadonlyMap<string, string | null>,
  profile: LearningProfile,
  context?: { userId: string; courseId: string },
): PersonalOrder {
  if (!profile.size) return { questions, hasProfile: false };
  const reasons = new Set<PriorityReason>();
  let affected = 0;
  const ranked = questions.map(question => {
    const topic = questionTopic(question.papers.map(paper => ({ topic: paperTopics.get(paper.id) ?? null })));
    const weakness = (topic && profile.get(topic.topicKey)?.weakness) ?? NEUTRAL_WEAKNESS;
    const checked = checkedPriority(question.paperCount, question.totalPapers, weakness);
    if (checked.reasons.length) affected++;
    checked.reasons.forEach(reason => reasons.add(reason));
    return { question, priority: checked.priority };
  });
  if (affected) {
    logError("priority_calculation_failed", { userId: context?.userId, courseId: context?.courseId, affectedQuestions: String(affected), reasons: [...reasons].sort().join(",") });
  }
  // Priorities closer than PRIORITY_TIE are a tie, so rounding (3/5 × 0.5 against 1/5 × 1.5) never decides the order.
  ranked.sort((a, b) => (Math.abs(b.priority - a.priority) > PRIORITY_TIE ? b.priority - a.priority : a.question.position - b.question.position));
  return { questions: ranked.map(item => item.question), hasProfile: true };
}

// The personal order of a course's exam for one student: their profile in this course only, and the topics of the
// exam's papers. Only the course's published papers are read (US-13).
export async function getPersonalOrder(userId: string, courseId: string, questions: ExamQuestion[]): Promise<PersonalOrder> {
  const paperIds = [...new Set(questions.flatMap(question => question.papers.map(paper => paper.id)))];
  const [profile, papers] = await Promise.all([
    getLearningProfile(userId, courseId),
    db.courseFile.findMany({ where: { id: { in: paperIds }, courseId, ...PUBLISHED_FILES }, select: { id: true, topic: true } }).catch(error => {
      logError("learning_profile_retrieval_failed", { userId, courseId, source: "personal_order", errorType: errorType(error) });
      throw error;
    }),
  ]);
  return personalizeQuestions(questions, new Map(papers.map(paper => [paper.id, paper.topic])), profile, { userId, courseId });
}
