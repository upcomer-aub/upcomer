import { db } from "@/lib/db";
import { getConsolidatedExam, type ExamQuestion } from "@/lib/consolidated-exam";
import { PUBLISHED_FILES } from "@/lib/file-visibility";
import { getLearningProfile, isWeakness, NEUTRAL_WEAKNESS, questionTopic, type LearningProfile } from "@/lib/learning-profile";
import { logError } from "@/lib/logger";
import { WEAKNESS_WEIGHT } from "@/lib/personal-order";

// A practice set that emphasizes the student's weak topics (US-31): N questions from the course's Upcomer Exam, with
// more of them from the topics the student is weaker in. Topics share the N places in proportion to the US-27 weakness
// factor, 1 + WEAKNESS_WEIGHT × weakness, so the weakest topic gets up to 3 times the places of the strongest, and a
// strong topic still gets some. Within a topic the most frequent questions come first. A student with no topic weaker
// than neutral (no profile, or only neutral and strong ratings) gets the N most frequent questions instead.
// Only reads the learning profile; practising never changes it. The same inputs always give the same set.

export const PRACTICE_SIZES = [5, 10, 20] as const;
export const DEFAULT_PRACTICE_SIZE = 10;

// The requested size if it is one of PRACTICE_SIZES, else the default.
export function practiceSize(value: unknown): number {
  const size = Number(value);
  return (PRACTICE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PRACTICE_SIZE;
}

export type PracticeMode = "weak_topics" | "frequency";
// The topic as shown, null for questions whose papers have no topic.
export type PracticeQuestion = ExamQuestion & { topic: string | null };
// How many of the set's questions came from one topic, and the student's weakness in it.
export type PracticeTopic = { topicKey: string; topic: string | null; weakness: number; count: number };
// `available` is how many questions the course has to choose from; the set is smaller than asked when it has fewer.
export type PracticeSet = { mode: PracticeMode; questions: PracticeQuestion[]; topics: PracticeTopic[]; available: number };

type Bucket = { topicKey: string; topic: string | null; weakness: number; weight: number; questions: PracticeQuestion[]; taken: number };

// The questions of each topic, in the frequency order. Questions without a topic share one bucket with the neutral weakness.
function bucketsOf(questions: ExamQuestion[], paperTopics: ReadonlyMap<string, string | null>, profile: LearningProfile) {
  const buckets = new Map<string, Bucket>();
  for (const question of questions) {
    const topic = questionTopic(question.papers.map(paper => ({ topic: paperTopics.get(paper.id) ?? null })));
    const key = topic?.topicKey ?? "";
    let bucket = buckets.get(key);
    if (!bucket) {
      const saved = topic ? profile.get(topic.topicKey)?.weakness : undefined;
      // A broken stored value counts as neutral rather than skewing the set.
      const weakness = isWeakness(saved) ? saved : NEUTRAL_WEAKNESS;
      bucket = { topicKey: key, topic: topic?.topic ?? null, weakness, weight: 1 + WEAKNESS_WEIGHT * weakness, questions: [], taken: 0 };
      buckets.set(key, bucket);
    }
    bucket.questions.push({ ...question, topic: bucket.topic });
  }
  return [...buckets.values()];
}

// Hands out the places one at a time (D'Hondt): each goes to the topic with the highest weight / (places so far + 1)
// that still has questions left. Ties go to the higher weight, then to the topic whose next question is more frequent.
// A topic that runs out of questions passes its share on to the others.
function allocate(buckets: Bucket[], size: number) {
  for (let place = 0; place < size; place++) {
    let best: Bucket | null = null;
    for (const bucket of buckets) {
      if (bucket.taken >= bucket.questions.length) continue;
      if (!best) { best = bucket; continue; }
      const score = bucket.weight / (bucket.taken + 1);
      const bestScore = best.weight / (best.taken + 1);
      if (score !== bestScore ? score > bestScore
        : bucket.weight !== best.weight ? bucket.weight > best.weight
          : bucket.questions[bucket.taken].position < best.questions[best.taken].position) best = bucket;
    }
    if (!best) return;
    best.taken++;
  }
}

const summary = (buckets: Bucket[]): PracticeTopic[] => buckets
  .filter(bucket => bucket.taken > 0)
  .map(({ topicKey, topic, weakness, taken }) => ({ topicKey, topic, weakness, count: taken }));

// Picks the practice set. `questions` is the course's exam in the frequency order; `paperTopics` gives each paper's topic.
export function selectPracticeSet(
  questions: ExamQuestion[], paperTopics: ReadonlyMap<string, string | null>, profile: LearningProfile, size: number,
): PracticeSet {
  const buckets = bucketsOf(questions, paperTopics, profile);
  const places = Math.max(0, Math.floor(size));
  if (!buckets.some(bucket => bucket.weakness > NEUTRAL_WEAKNESS)) {
    const picked = new Set(questions.slice(0, places).map(question => question.id));
    for (const bucket of buckets) bucket.taken = bucket.questions.filter(question => picked.has(question.id)).length;
    const chosen = buckets.flatMap(bucket => bucket.questions.filter(question => picked.has(question.id))).sort((a, b) => a.position - b.position);
    return { mode: "frequency", questions: chosen, topics: summary(buckets), available: questions.length };
  }
  allocate(buckets, places);
  // Weakest topics first; within a topic, and between equally weak ones, the most frequent question first.
  const chosen = buckets.flatMap(bucket => bucket.questions.slice(0, bucket.taken).map(question => ({ question, weakness: bucket.weakness })))
    .sort((a, b) => b.weakness - a.weakness || a.question.position - b.question.position)
    .map(item => item.question);
  const topics = summary(buckets).sort((a, b) => b.weakness - a.weakness || b.count - a.count);
  return { mode: "weak_topics", questions: chosen, topics, available: questions.length };
}

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

// The session student's practice set in one course: the course's Upcomer Exam, their profile in this course only (US-33),
// and the topics of the exam's published papers. A failure is logged once, with IDs and the error type, and rethrown.
export async function getPracticeSet(userId: string, courseId: string, size: number): Promise<PracticeSet> {
  try {
    const exam = await getConsolidatedExam(courseId);
    const paperIds = [...new Set(exam.questions.flatMap(question => question.papers.map(paper => paper.id)))];
    const [profile, papers] = await Promise.all([
      getLearningProfile(userId, courseId),
      paperIds.length ? db.courseFile.findMany({ where: { id: { in: paperIds }, courseId, ...PUBLISHED_FILES }, select: { id: true, topic: true } }) : [],
    ]);
    return selectPracticeSet(exam.questions, new Map(papers.map(paper => [paper.id, paper.topic])), profile, size);
  } catch (error) {
    logError("practice_set_failed", { userId, courseId, size: String(size), errorType: errorType(error) });
    throw error;
  }
}
