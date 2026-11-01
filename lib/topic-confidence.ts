import { FileCategory } from "@prisma/client";
import { db } from "@/lib/db";
import { PUBLISHED_FILES } from "@/lib/file-visibility";
import { NEUTRAL_WEAKNESS, setTopicWeakness, topicKey } from "@/lib/learning-profile";
import { logError } from "@/lib/logger";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";
import { parseRatings, weaknessFromRating, type ConfidenceRefusal } from "@/lib/topic-confidence-rules";

// A student's confidence in each topic of a course (US-24), saved as their learning profile's weakness (US-33) with
// setTopicWeakness, together with the rating itself so the form can show it again. Every read and write is for one
// student in one course; the student's ID comes from the session (requireUser in the action and the page). Topics are
// never logged.

// Saves per student per minute. Far above what a person clicks, so it only stops a script or a stolen session.
export const TOPIC_CONFIDENCE_WINDOW_MS = 60_000;
export const topicConfidenceLimit = () => limitFromEnv("TOPIC_CONFIDENCE_RATE_LIMIT_PER_MINUTE", 30);
// The database is remote and can be slow: room to wait for a connection and to write every topic of a large course.
export const SAVE_TRANSACTION = { maxWait: 10_000, timeout: 20_000 };

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

export type CourseTopic = { topicKey: string; topic: string };

// The course's topics: the distinct topics of its published exam papers (CourseFile.topic), keyed with topicKey like the
// personal order, each shown as its newest paper writes it, in key order.
export async function getCourseTopics(courseId: string): Promise<CourseTopic[]> {
  try {
    const papers = await db.courseFile.findMany({
      where: { courseId, category: FileCategory.EXAM, ...PUBLISHED_FILES, topic: { not: null } },
      select: { topic: true },
      orderBy: [{ year: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    });
    const topics = new Map<string, string>();
    for (const { topic } of papers) {
      const key = topicKey(topic);
      if (key && !topics.has(key)) topics.set(key, topic!.replace(/\s+/g, " ").trim());
    }
    return [...topics].map(([key, topic]) => ({ topicKey: key, topic })).sort((a, b) => a.topicKey.localeCompare(b.topicKey));
  } catch (error) {
    logError("learning_profile_retrieval_failed", { courseId, source: "topic_confidence", errorType: errorType(error) });
    throw error;
  }
}

// The student's saved ratings in one course, by topic key; null for a skipped topic or one written without a rating.
export async function getTopicConfidence(userId: string, courseId: string): Promise<Map<string, number | null>> {
  try {
    const rows = await db.learningTopic.findMany({ where: { userId, courseId }, select: { topicKey: true, confidence: true } });
    return new Map(rows.map(row => [row.topicKey, row.confidence]));
  } catch (error) {
    logError("learning_profile_retrieval_failed", { userId, courseId, source: "topic_confidence", errorType: errorType(error) });
    throw error;
  }
}

export type ConfidenceResult = { ok: true; rated: number; skipped: number; unchanged: number } | { ok: false; error: ConfidenceRefusal };

class WriteFailed extends Error {
  name = "WriteFailed";
}

// Saves the session student's ratings for one course, all or nothing. A rating becomes weakness (5 − rating) / 4. Skip
// writes the neutral default, but only over no row or a rating the student gave before: a weakness written by other code
// (a row without a rating, for example from US-25) is kept. Only this student's rows in this course are written.
export async function saveTopicConfidence(userId: string, courseId: string, entries: Iterable<[string, FormDataEntryValue]>): Promise<ConfidenceResult> {
  const refuse = (error: ConfidenceRefusal): ConfidenceResult => {
    logError("topic_confidence_refused", { userId, courseId, reason: error });
    return { ok: false, error };
  };
  const limit = checkRateLimit(`topic-confidence:${userId}`, topicConfidenceLimit(), TOPIC_CONFIDENCE_WINDOW_MS);
  if (!limit.ok) {
    logError("topic_confidence_rate_limited", { userId, retryAfterSeconds: String(limit.retryAfterSeconds) });
    return { ok: false, error: "rate_limited" };
  }
  try {
    const topics = await getCourseTopics(courseId);
    const parsed = parseRatings(entries, new Set(topics.map(topic => topic.topicKey)));
    if (!parsed.ok) return refuse(parsed.error);
    const names = new Map(topics.map(topic => [topic.topicKey, topic.topic]));
    const counts = await db.$transaction(async tx => {
      const existing = new Map((await tx.learningTopic.findMany({
        where: { userId, courseId, topicKey: { in: parsed.ratings.map(item => item.topicKey) } },
        select: { topicKey: true, confidence: true },
      })).map(row => [row.topicKey, row.confidence]));
      const counts = { rated: 0, skipped: 0, unchanged: 0 };
      for (const { topicKey: key, rating } of parsed.ratings) {
        // A skipped topic whose weakness came from other code keeps it.
        if (rating === null && existing.get(key) === null) {
          counts.unchanged++;
          continue;
        }
        const weakness = rating === null ? NEUTRAL_WEAKNESS : weaknessFromRating(rating);
        const result = await setTopicWeakness(userId, courseId, names.get(key)!, weakness, { confidence: rating, client: tx });
        // setTopicWeakness reports a failure instead of throwing; throwing here rolls every write back.
        if (!result.ok) throw new WriteFailed(result.error);
        if (rating === null) counts.skipped++;
        else counts.rated++;
      }
      return counts;
    }, SAVE_TRANSACTION);
    logError("topic_confidence_saved", { userId, courseId, ratedTopics: String(counts.rated), skippedTopics: String(counts.skipped), unchangedTopics: String(counts.unchanged) });
    return { ok: true, ...counts };
  } catch (error) {
    logError("topic_confidence_save_failed", { userId, courseId, errorType: errorType(error) });
    return { ok: false, error: "unexpected" };
  }
}
