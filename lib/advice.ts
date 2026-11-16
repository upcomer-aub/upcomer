import { AdviceScopeKind, AdviceStatus, type Prisma } from "@prisma/client";
import {
  ADVICE_BODY_MAX_LENGTH, ADVICE_LINK_TITLE_MAX_LENGTH, ADVICE_QUERY_MAX_LENGTH, ADVICE_TITLE_MAX_LENGTH, ANONYMOUS_AUTHOR_LABEL,
  cleanAdviceBody, collapseSpaces, FORMER_STUDENT_LABEL, isScopeName, parseResourceLink, topicKeyOf, type AdviceError, type AdviceScopeName,
} from "@/lib/advice-rules";
import { db } from "@/lib/db";
import { PUBLISHED_FILES } from "@/lib/file-visibility";
import { errorCode, logError } from "@/lib/logger";
import { courseExams } from "@/lib/question-bank";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";
import { hasReadableText } from "@/lib/readable-text";
import { escapeLike } from "@/lib/search";
import { timed } from "@/lib/timing";

// Advice from previous students (US-34, US-35, US-37, US-39). Nothing here checks the caller: the pages and actions call
// requireUser() first and pass the session user's ID; no function reads a user ID from a URL or a form.
//
// Privacy (US-37): every student-facing read goes through toPublicAdvice, whose result has no author ID. For an anonymous
// post it also has no author name. Other stories (ratings, comments, reports, notifications) must build their student-facing
// output the same way. The author ID stays in the database for admins only.

export const ADVICE_RATE_WINDOW_MS = 60 * 60_000;
export const adviceLimit = () => limitFromEnv("ADVICE_RATE_LIMIT_PER_HOUR", 20);
export const ADVICE_PAGE_SIZE = 20;
const OPTION_QUESTION_LIMIT = 100;
const QUESTION_LABEL_LENGTH = 80;

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

export type PublishInput = {
  courseId: string;
  scopeKind: string;
  // EXAM: paper ID. SESSION: term ID. QUESTION: question group ID. TOPIC: the topic. COURSE: ignored.
  scopeValue: string;
  title: string;
  body: string;
  resourceUrl: string;
  resourceTitle: string;
  isAnonymous: boolean;
};
export type PublishResult = { ok: true; id: string } | { ok: false; error: AdviceError };

type ScopeData = {
  scopeKind: AdviceScopeKind; scopeLabel: string; fileId?: string; termId?: string; groupId?: string; topicKey?: string; topic?: string;
};

// Checks that the scope's target exists, is visible to students, and belongs to this course. Null means invalid.
async function resolveScope(course: { id: string; code: string }, kind: AdviceScopeName, value: string): Promise<ScopeData | null> {
  const target = value.trim();
  if (kind === "COURSE") return { scopeKind: AdviceScopeKind.COURSE, scopeLabel: course.code };
  if (!target) return null;
  if (kind === "EXAM") {
    const file = await db.courseFile.findFirst({ where: { id: target, ...courseExams(course.id) }, select: { id: true, title: true } });
    return file && { scopeKind: AdviceScopeKind.EXAM, scopeLabel: file.title, fileId: file.id };
  }
  if (kind === "SESSION") {
    const file = await db.courseFile.findFirst({ where: { courseId: course.id, termId: target, ...PUBLISHED_FILES }, select: { term: { select: { id: true, name: true } } } });
    return file?.term ? { scopeKind: AdviceScopeKind.SESSION, scopeLabel: file.term.name, termId: file.term.id } : null;
  }
  if (kind === "QUESTION") {
    const group = await db.questionGroup.findFirst({
      where: { id: target, courseId: course.id, questions: { some: { file: PUBLISHED_FILES } } }, select: { id: true, text: true },
    });
    return group && { scopeKind: AdviceScopeKind.QUESTION, scopeLabel: collapseSpaces(group.text).slice(0, QUESTION_LABEL_LENGTH), groupId: group.id };
  }
  const key = topicKeyOf(target);
  if (!key) return null;
  const files = await db.courseFile.findMany({ where: { courseId: course.id, ...PUBLISHED_FILES, topic: { not: null } }, select: { topic: true } });
  const match = files.find(file => file.topic && topicKeyOf(file.topic) === key);
  return match?.topic ? { scopeKind: AdviceScopeKind.TOPIC, scopeLabel: collapseSpaces(match.topic), topicKey: key, topic: collapseSpaces(match.topic) } : null;
}

// Publishes advice for the given student. Never logs the title, text, or link.
export async function publishAdvice(userId: string, input: PublishInput): Promise<PublishResult> {
  const context = { userId, courseId: input.courseId.slice(0, 100) || undefined, scopeKind: input.scopeKind.slice(0, 20) };
  const refuse = (error: AdviceError): PublishResult => {
    logError("advice_publish_refused", { ...context, reason: error });
    return { ok: false, error };
  };
  const title = collapseSpaces(input.title);
  const body = cleanAdviceBody(input.body);
  const resourceTitle = collapseSpaces(input.resourceTitle);
  if (!hasReadableText(title)) return refuse("title_required");
  if (title.length > ADVICE_TITLE_MAX_LENGTH) return refuse("title_too_long");
  if (!hasReadableText(body)) return refuse("body_required");
  if (body.length > ADVICE_BODY_MAX_LENGTH) return refuse("body_too_long");
  if (resourceTitle.length > ADVICE_LINK_TITLE_MAX_LENGTH) return refuse("link_title_too_long");
  const link = parseResourceLink(input.resourceUrl);
  if (!link.ok) return refuse("link_invalid");
  if (!isScopeName(input.scopeKind)) return refuse("scope_invalid");
  const limit = checkRateLimit(`advice:${userId}`, adviceLimit(), ADVICE_RATE_WINDOW_MS);
  if (!limit.ok) {
    logError("advice_publish_rate_limited", { ...context, retryAfterSeconds: String(limit.retryAfterSeconds) });
    return { ok: false, error: "rate_limited" };
  }
  try {
    const course = await db.course.findUnique({ where: { id: input.courseId }, select: { id: true, code: true } });
    if (!course) return refuse("course_not_found");
    const scope = await resolveScope(course, input.scopeKind, input.scopeValue);
    if (!scope) return refuse("scope_invalid");
    const created = await db.advice.create({
      data: {
        courseId: course.id, authorId: userId, isAnonymous: input.isAnonymous, ...scope, title, body,
        resourceUrl: link.url, resourceTitle: link.url && resourceTitle ? resourceTitle : null,
      },
      select: { id: true },
    });
    invalidateCourseAdvice(course.id);
    logError("advice_published", { ...context, adviceId: created.id, anonymous: String(input.isAnonymous), hasLink: String(Boolean(link.url)) });
    return { ok: true, id: created.id };
  } catch (error) {
    // P2003: the exam, session, or question was deleted between the check and the save. P2025/P2003 on the user: no account.
    if (errorCode(error) === "P2003") return refuse("scope_invalid");
    logError("advice_publish_failed", { ...context, errorType: errorType(error), errorCode: errorCode(error) });
    return { ok: false, error: "unexpected" };
  }
}

const adviceSelect = {
  id: true, courseId: true, authorId: true, isAnonymous: true, scopeKind: true, scopeLabel: true, fileId: true, termId: true, groupId: true,
  topic: true, title: true, body: true, resourceUrl: true, resourceTitle: true, createdAt: true,
  author: { select: { name: true } },
} satisfies Prisma.AdviceSelect;
export type AdviceRow = Prisma.AdviceGetPayload<{ select: typeof adviceSelect }>;

// What students see. There is no author ID here, and the name of an anonymous post's author is never copied in. isMine tells
// only the viewer that a post is theirs, so the page can offer edit and delete (US-36).
export type PublicAdvice = {
  id: string;
  courseId: string;
  title: string;
  body: string;
  resourceUrl: string | null;
  resourceTitle: string | null;
  scope: { kind: AdviceScopeKind; label: string; fileId: string | null; termId: string | null; groupId: string | null; topic: string | null };
  authorLabel: string;
  isAnonymous: boolean;
  isMine: boolean;
  createdAt: Date;
};

export function toPublicAdvice(row: AdviceRow, viewerId: string | null): PublicAdvice {
  return {
    id: row.id, courseId: row.courseId, title: row.title, body: row.body, resourceUrl: row.resourceUrl, resourceTitle: row.resourceTitle,
    scope: { kind: row.scopeKind, label: row.scopeLabel, fileId: row.fileId, termId: row.termId, groupId: row.groupId, topic: row.topic },
    authorLabel: row.isAnonymous ? ANONYMOUS_AUTHOR_LABEL : (row.author?.name ?? FORMER_STUDENT_LABEL),
    isAnonymous: row.isAnonymous,
    isMine: viewerId !== null && row.authorId === viewerId,
    createdAt: row.createdAt,
  };
}

export type AdviceFilters = { query?: string; topic?: string; examId?: string; termId?: string; page?: number };
export type AdvicePage = { items: PublicAdvice[]; total: number; page: number; totalPages: number };

// The advice students may see in one course: visible, and not pointing at another course's exam paper or question
// (US-38). Publishing refuses such a target (resolveScope), so this only guards against bad data: such advice is left out
// rather than shown in the wrong course. Every student-facing advice query starts from this.
export const visibleCourseAdvice = (courseId: string) => ({
  courseId,
  status: AdviceStatus.VISIBLE,
  NOT: [{ file: { is: { courseId: { not: courseId } } } }, { group: { is: { courseId: { not: courseId } } } }],
}) satisfies Prisma.AdviceWhereInput;

// Caching the course feed (US-38). The unfiltered feed is the page most students open, and it is the same for every
// viewer apart from isMine, so the rows of a page are cached and turned into PublicAdvice for each viewer. A page is kept
// for ADVICE_FEED_CACHE_SECONDS (default 30; 0 turns the cache off). EVERY code path that writes advice (publishing,
// editing, deleting, removing) must call invalidateCourseAdvice(courseId) after its write, so a change shows at once and
// removed advice never lingers; the time limit only bounds a write made outside this process. Searches and filters
// (US-39) are not cached. Like the rate limits, the cache lives in this server process's memory, bounded in size.
const MAX_CACHED_COURSES = 500;
const MAX_CACHED_PAGES = 50;
// Page numbers past this are cached as this page; it is past the end of any real course, so it shows the last page.
const MAX_PAGE_KEY = 10_000;
type CachedPage = { rows: AdviceRow[]; total: number; page: number; totalPages: number; expiresAt: number };
// Kept on globalThis: Next.js bundles server actions (which publish and so invalidate) apart from the pages (which read),
// and a plain module-level Map would give each bundle its own cache, so an invalidation would never reach the page.
const cacheHolder = globalThis as typeof globalThis & { upcomerAdviceFeedCache?: Map<string, Map<number, CachedPage>> };
const feedCache = (cacheHolder.upcomerAdviceFeedCache ??= new Map<string, Map<number, CachedPage>>());

export function adviceCacheSeconds() {
  const raw = process.env.ADVICE_FEED_CACHE_SECONDS;
  const value = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(value) && value >= 0 ? value : 30;
}

// Call after every write to a course's advice.
export function invalidateCourseAdvice(courseId: string) {
  feedCache.delete(courseId);
}

// For tests.
export function resetAdviceCache() {
  feedCache.clear();
}

function cachedPage(courseId: string, key: number, now: number) {
  const entry = feedCache.get(courseId)?.get(key);
  if (!entry) return null;
  if (entry.expiresAt > now) return entry;
  feedCache.get(courseId)!.delete(key);
  return null;
}

function storePage(courseId: string, key: number, entry: Omit<CachedPage, "expiresAt">, now: number) {
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
  pages.set(key, { ...entry, expiresAt: now + seconds * 1000 });
}

// DoS protection (US-38): advice reads per logged-in student per minute. Far above what a person clicks through, so it
// only stops a script or a stolen session walking every page or search. Visitors are served from the cache.
export const ADVICE_FEED_WINDOW_MS = 60_000;
export const adviceFeedLimit = () => limitFromEnv("ADVICE_FEED_RATE_LIMIT_PER_MINUTE", 120);

// True when the student may read advice now. A refusal is logged with the student's ID only.
export function allowAdviceFeedRead(userId: string) {
  const limit = checkRateLimit(`advice-feed:${userId}`, adviceFeedLimit(), ADVICE_FEED_WINDOW_MS);
  if (limit.ok) return true;
  logError("advice_feed_rate_limited", { userId, retryAfterSeconds: String(limit.retryAfterSeconds) });
  return false;
}

const pageKey = (requested: unknown) => {
  const number = Number(requested ?? 1);
  return Number.isInteger(number) && number > 0 ? Math.min(number, MAX_PAGE_KEY) : 1;
};

async function readPage(where: Prisma.AdviceWhereInput, requested: number) {
  const total = await db.advice.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / ADVICE_PAGE_SIZE));
  const page = Math.min(requested, totalPages);
  const rows = await db.advice.findMany({
    where, select: adviceSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * ADVICE_PAGE_SIZE, take: ADVICE_PAGE_SIZE,
  });
  return { rows, total, page, totalPages };
}

// The visible advice of ONE course, newest first (US-39). With no filters it is the course's whole feed (US-38), which is
// cached (see above) and timed as "advice_feed" (a database read) or "advice_feed_cached". Text matches the title, text,
// and topic, never the author. Filters combine. The course is always part of the query, so an exam, session, or topic of
// another course returns nothing. REMOVED advice is never returned. An invalid page gives the first page, and a page past
// the end gives the last one.
export async function searchAdvice(courseId: string, viewerId: string | null, filters: AdviceFilters = {}): Promise<AdvicePage> {
  const query = filters.query?.trim().slice(0, ADVICE_QUERY_MAX_LENGTH) ?? "";
  const topicKey = filters.topic ? topicKeyOf(filters.topic) : "";
  const examId = filters.examId?.trim() || undefined;
  const termId = filters.termId?.trim() || undefined;
  const where: Prisma.AdviceWhereInput = {
    ...visibleCourseAdvice(courseId),
    ...(query ? { OR: ["title", "body", "topic"].map(field => ({ [field]: { contains: escapeLike(query), mode: "insensitive" as const } })) } : {}),
    ...(topicKey ? { topicKey } : {}),
    ...(examId ? { fileId: examId } : {}),
    ...(termId ? { termId } : {}),
  };
  const filtered = Boolean(query || topicKey || examId || termId);
  const key = pageKey(filters.page);
  const toPage = (entry: Omit<CachedPage, "expiresAt">): AdvicePage =>
    ({ items: entry.rows.map(row => toPublicAdvice(row, viewerId)), total: entry.total, page: entry.page, totalPages: entry.totalPages });
  try {
    if (filtered) return toPage(await readPage(where, key));
    const cached = cachedPage(courseId, key, Date.now());
    if (cached) return await timed("advice_feed_cached", { courseId }, async () => toPage(cached));
    return await timed("advice_feed", { courseId }, async () => {
      const entry = await readPage(where, key);
      storePage(courseId, key, entry, Date.now());
      return toPage(entry);
    });
  } catch (error) {
    logError(filtered ? "advice_search_failed" : "advice_retrieval_failed", { courseId, errorType: errorType(error), errorCode: errorCode(error) });
    throw error;
  }
}

// The choices of the publish form and the search filters: only things students can see in this course.
export async function getAdviceOptions(courseId: string) {
  try {
    const [files, questions] = await Promise.all([
      db.courseFile.findMany({
        where: { courseId, ...PUBLISHED_FILES },
        select: { id: true, title: true, category: true, year: true, topic: true, term: { select: { id: true, name: true } } },
      }),
      db.questionGroup.findMany({
        where: { courseId, questions: { some: { file: PUBLISHED_FILES } } },
        orderBy: { rank: "asc" }, take: OPTION_QUESTION_LIMIT, select: { id: true, rank: true, text: true },
      }),
    ]);
    const exams = files.filter(file => file.category === "EXAM").sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title))
      .map(({ id, title, year }) => ({ id, title, year }));
    const terms = [...new Map(files.flatMap(file => (file.term ? [[file.term.id, file.term] as const] : []))).values()].sort((a, b) => a.name.localeCompare(b.name));
    const topics = [...new Map(files.flatMap(file => (file.topic && topicKeyOf(file.topic) ? [[topicKeyOf(file.topic), collapseSpaces(file.topic)] as const] : []))).values()].sort((a, b) => a.localeCompare(b));
    return { exams, terms, topics, questions: questions.map(question => ({ id: question.id, rank: question.rank, label: collapseSpaces(question.text).slice(0, QUESTION_LABEL_LENGTH) })) };
  } catch (error) {
    logError("advice_retrieval_failed", { courseId, entity: "options", errorType: errorType(error), errorCode: errorCode(error) });
    throw error;
  }
}
