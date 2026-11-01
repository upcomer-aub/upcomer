import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { logError } from "@/lib/logger";

// The learning profile of a student, kept per course (US-33). Each row is one topic of one student in one course, keyed
// by (userId, courseId, topicKey), so a change in one course never changes another course's profile, and two courses that
// share a topic name track it separately. A row holds one number, the student's weakness in the topic.
// How weakness is worked out is not decided here: self-rating is US-24 and performance is US-25. They write it with
// setTopicWeakness. Nothing here checks the caller: actions and pages call requireUser() first and pass the session
// user's ID.

export type ProfileTopic = { topicKey: string; topic: string; weakness: number };
// A course's profile for one student, by topic key.
export type LearningProfile = Map<string, ProfileTopic>;

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

// The topic as written, with spacing tidied; "" when there is none.
const tidyTopic = (topic: string | null | undefined) => (topic ?? "").replace(/\s+/g, " ").trim();

// One key per topic within a course: case and spacing never make two topics. The course is not part of the key itself;
// it is the other half of the row's primary key.
export const topicKey = (topic: string | null | undefined) => tidyTopic(topic).toLowerCase();

// A question's topic is the topic of the exam papers it appeared in (CourseFile.topic, set on upload or at /admin/files).
// When its papers disagree, the most common topic wins, and a tie goes to the paper listed first (newest first). Papers
// without a topic don't count. Null when none of its papers has one.
export function questionTopic(papers: Array<{ topic: string | null }>): { topicKey: string; topic: string } | null {
  const counts = new Map<string, { topic: string; count: number }>();
  for (const paper of papers) {
    const key = topicKey(paper.topic);
    if (!key) continue;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { topic: tidyTopic(paper.topic), count: 1 });
  }
  let best: { topicKey: string; topic: string; count: number } | null = null;
  for (const [key, entry] of counts) if (!best || entry.count > best.count) best = { topicKey: key, ...entry };
  return best && { topicKey: best.topicKey, topic: best.topic };
}

export const isWeakness = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

// The neutral default (US-24): the weakness of a topic the student skipped when rating their confidence, and of a topic
// they never rated (or a question without a topic) in the personal order. One value, so both behave the same.
export const NEUTRAL_WEAKNESS = 0.5;

// The student's profile in one course. Only that course's rows are read.
export async function getLearningProfile(userId: string, courseId: string): Promise<LearningProfile> {
  try {
    const rows = await db.learningTopic.findMany({ where: { userId, courseId }, select: { topicKey: true, topic: true, weakness: true } });
    return new Map(rows.map(row => [row.topicKey, row]));
  } catch (error) {
    logError("learning_profile_retrieval_failed", { userId, courseId, errorType: errorType(error) });
    throw error;
  }
}

export type WeaknessResult = { ok: true } | { ok: false; error: "topic_required" | "invalid_weakness" | "unexpected" };

// Saves a student's weakness in one topic of one course, from 0 (strong) to 1 (weak). The one way the profile is written:
// for US-24 (self-rating) and US-25 (performance) to call once they exist. Only that course's row for that topic changes.
// US-24 also passes the rating it came from (`confidence`, null when skipped) and its transaction (`client`); without a
// `confidence` the stored rating is left as it is.
export async function setTopicWeakness(
  userId: string, courseId: string, topic: string, weakness: number,
  options: { confidence?: number | null; client?: Pick<Prisma.TransactionClient, "learningTopic"> } = {},
): Promise<WeaknessResult> {
  const key = topicKey(topic);
  if (!key) return { ok: false, error: "topic_required" };
  if (!isWeakness(weakness)) return { ok: false, error: "invalid_weakness" };
  const rating = options.confidence === undefined ? {} : { confidence: options.confidence };
  try {
    await (options.client ?? db).learningTopic.upsert({
      where: { userId_courseId_topicKey: { userId, courseId, topicKey: key } },
      create: { userId, courseId, topicKey: key, topic: tidyTopic(topic), weakness, ...rating },
      update: { weakness, ...rating },
    });
    return { ok: true };
  } catch (error) {
    logError("learning_profile_update_failed", { userId, courseId, errorType: errorType(error) });
    return { ok: false, error: "unexpected" };
  }
}
