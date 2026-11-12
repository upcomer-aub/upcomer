import { AdviceStatus, FileCategory, FileStatus, type Prisma } from "@prisma/client";
import { adviceAbout, clampPage, ADVICE_PAGE_SIZE, authorLabel, safeResourceUrl, type AdviceAbout } from "@/lib/advice-rules";
import { db } from "@/lib/db";
import { logError } from "@/lib/logger";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";
import { timed } from "@/lib/timing";

// Advice from previous students (E3). This file reads advice for students: the course feed (US-38). Nothing here checks
// the caller: the pages call requireUser() first. The advice text and author names are never logged.

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

// The advice students may see in one course: visible, and not pointing at another course's exam paper or question. A
// target of another course can only come from bad data (publishing, US-34, refuses it); such advice is left out
// entirely rather than shown in the wrong course.
export const visibleCourseAdvice = (courseId: string) => ({
  courseId,
  status: AdviceStatus.VISIBLE,
  NOT: [
    { file: { is: { courseId: { not: courseId } } } },
    { questionGroup: { is: { courseId: { not: courseId } } } },
  ],
}) satisfies Prisma.AdviceWhereInput;

const adviceSelect = {
  id: true, body: true, anonymous: true, scope: true, topic: true, resourceUrl: true, editedAt: true, createdAt: true,
  author: { select: { name: true } },
  file: { select: { id: true, title: true, category: true, status: true } },
  term: { select: { name: true } },
  questionGroup: { select: { id: true, text: true } },
} satisfies Prisma.AdviceSelect;

type AdviceRow = Prisma.AdviceGetPayload<{ select: typeof adviceSelect }>;

// One advice as students see it. It never holds the author's ID, and never their name when the advice is anonymous.
export type AdviceItem = {
  id: string;
  body: string;
  author: string;
  anonymous: boolean;
  about: AdviceAbout;
  resourceUrl: string | null;
  createdAt: Date;
  edited: boolean;
};

export function toAdviceItem(row: AdviceRow): AdviceItem {
  // Only a published exam paper is named; a pending, rejected, or material file is treated as gone (US-13).
  const exam = row.file && row.file.category === FileCategory.EXAM && row.file.status === FileStatus.PUBLISHED ? row.file : null;
  return {
    id: row.id,
    body: row.body,
    author: authorLabel({ anonymous: row.anonymous, authorName: row.anonymous ? null : row.author?.name ?? null }),
    anonymous: row.anonymous,
    about: adviceAbout({ scope: row.scope, file: exam, term: row.term, topic: row.topic, questionGroup: row.questionGroup }),
    resourceUrl: safeResourceUrl(row.resourceUrl),
    createdAt: row.createdAt,
    edited: row.editedAt !== null,
  };
}

export type AdviceFeed = { items: AdviceItem[]; total: number; page: number; totalPages: number };

// Caching. A feed page is the same for every viewer (it holds no viewer's data), so one read serves every student who
// opens it within ADVICE_FEED_CACHE_SECONDS (default 30; 0 turns the cache off). Every code path that writes advice
// (publishing, editing, deleting, removing) must call invalidateCourseAdvice(courseId) after its write, so a change shows
// at once and removed advice never lingers; the time limit only bounds a write made outside this process (for example
// by hand in the database). Like the rate limits, the cache lives in this server's memory, which fits one Next.js server.
const MAX_CACHED_COURSES = 500;
const MAX_CACHED_PAGES = 50;
// Page numbers past this are cached as this page; it is past the end of any real course, so it shows the last page.
const MAX_PAGE_KEY = 10_000;
type CachedFeed = { feed: AdviceFeed; expiresAt: number };
const feedCache = new Map<string, Map<number, CachedFeed>>();

export function adviceCacheSeconds() {
  const value = Number(process.env.ADVICE_FEED_CACHE_SECONDS);
  return process.env.ADVICE_FEED_CACHE_SECONDS !== undefined && Number.isFinite(value) && value >= 0 ? value : 30;
}

const pageKey = (requested: unknown) => {
  const number = Number(requested);
  return Number.isInteger(number) && number > 0 ? Math.min(number, MAX_PAGE_KEY) : 1;
};

// Call after every write to a course's advice.
export function invalidateCourseAdvice(courseId: string) {
  feedCache.delete(courseId);
}

// For tests.
export function resetAdviceCache() {
  feedCache.clear();
}

function cachedFeed(courseId: string, key: number, now: number) {
  const entry = feedCache.get(courseId)?.get(key);
  if (!entry) return null;
  if (entry.expiresAt > now) return entry.feed;
  feedCache.get(courseId)!.delete(key);
  return null;
}

function storeFeed(courseId: string, key: number, feed: AdviceFeed, now: number) {
  const seconds = adviceCacheSeconds();
  if (!seconds) return;
  let pages = feedCache.get(courseId);
  if (!pages) {
    // The course cached longest ago is dropped first, so many courses cannot grow the cache without bound.
    if (feedCache.size >= MAX_CACHED_COURSES) feedCache.delete(feedCache.keys().next().value!);
    pages = new Map();
    feedCache.set(courseId, pages);
  }
  // Likewise for pages: a script walking every page number keeps at most MAX_CACHED_PAGES of them.
  if (!pages.has(key) && pages.size >= MAX_CACHED_PAGES) pages.delete(pages.keys().next().value!);
  pages.set(key, { feed, expiresAt: now + seconds * 1000 });
}

// DoS protection: feed reads per student per minute. Far above what a person clicks through, so it only stops a script
// or a stolen session walking every page (each new page is a database read).
export const ADVICE_FEED_WINDOW_MS = 60_000;
export const adviceFeedLimit = () => limitFromEnv("ADVICE_FEED_RATE_LIMIT_PER_MINUTE", 120);

// True when the student may read the feed now. A refusal is logged once with the student's ID only.
export function allowAdviceFeedRead(userId: string) {
  const limit = checkRateLimit(`advice-feed:${userId}`, adviceFeedLimit(), ADVICE_FEED_WINDOW_MS);
  if (limit.ok) return true;
  logError("advice_feed_rate_limited", { userId, retryAfterSeconds: String(limit.retryAfterSeconds) });
  return false;
}

async function readFeed(courseId: string, requestedPage: number): Promise<AdviceFeed> {
  const where = visibleCourseAdvice(courseId);
  const total = await db.advice.count({ where });
  const { page, totalPages } = clampPage(requestedPage, total);
  const rows = total
    ? await db.advice.findMany({
      where, select: adviceSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * ADVICE_PAGE_SIZE, take: ADVICE_PAGE_SIZE,
    })
    : [];
  return { items: rows.map(toAdviceItem), total, page, totalPages };
}

// The course feed (US-38): the course's visible advice, newest first, 20 a page. An invalid or out-of-range page falls
// back to the first or last page. A cached page is timed as "advice_feed_cached", a database read as "advice_feed".
export async function getCourseAdvice(courseId: string, requestedPage: unknown = 1): Promise<AdviceFeed> {
  const key = pageKey(requestedPage);
  const cached = cachedFeed(courseId, key, Date.now());
  if (cached) return timed("advice_feed_cached", { courseId }, async () => cached);
  return timed("advice_feed", { courseId }, async () => {
    try {
      const feed = await readFeed(courseId, key);
      storeFeed(courseId, key, feed, Date.now());
      return feed;
    } catch (error) {
      logError("advice_feed_retrieval_failed", { courseId, errorType: errorType(error) });
      throw error;
    }
  });
}
