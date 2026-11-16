import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The course feed (US-38) on top of searchAdvice: the cross-course guard, the cache and its invalidation, and the read limit.

const db = vi.hoisted(() => ({
  course: { findUnique: vi.fn() },
  courseFile: { findFirst: vi.fn(), findMany: vi.fn() },
  questionGroup: { findFirst: vi.fn() },
  advice: { create: vi.fn(), count: vi.fn(), findMany: vi.fn() },
}));
const logError = vi.hoisted(() => vi.fn());
const checkRateLimit = vi.hoisted(() => vi.fn((key: string, limit: number, windowMs: number) => ({ ok: Boolean(key && limit && windowMs), retryAfterSeconds: 0 })));
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/logger", () => ({ logError, errorCode: (error: unknown) => (error as { code?: string } | null)?.code, sanitizeContext: (c: unknown) => c }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit, limitFromEnv: (_name: string, fallback: number) => fallback }));

import {
  adviceCacheSeconds, allowAdviceFeedRead, invalidateCourseAdvice, publishAdvice, resetAdviceCache, searchAdvice, visibleCourseAdvice, type AdviceRow,
} from "@/lib/advice";

const row = (id: string, over: Partial<AdviceRow> = {}): AdviceRow => ({
  id, courseId: "course-1", authorId: "author-1", isAnonymous: false, scopeKind: "COURSE", scopeLabel: "CS101",
  fileId: null, termId: null, groupId: null, topic: null, title: `Title ${id}`, body: "Body", resourceUrl: null, resourceTitle: null, editedAt: null,
  createdAt: new Date("2026-11-02T10:00:00Z"), author: { name: "Named Author" }, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetAdviceCache();
  delete process.env.ADVICE_FEED_CACHE_SECONDS;
  db.course.findUnique.mockResolvedValue({ id: "course-1", code: "CS101" });
  db.advice.create.mockResolvedValue({ id: "new-advice" });
  db.advice.count.mockResolvedValue(1);
  db.advice.findMany.mockResolvedValue([row("a1")]);
});
afterEach(() => vi.useRealTimers());

describe("visibleCourseAdvice", () => {
  it("keeps the course and visible status, and leaves out targets of another course", () => {
    expect(visibleCourseAdvice("course-1")).toEqual({
      courseId: "course-1",
      status: "VISIBLE",
      NOT: [{ file: { is: { courseId: { not: "course-1" } } } }, { group: { is: { courseId: { not: "course-1" } } } }],
    });
  });

  it("is part of every feed and search query", async () => {
    await searchAdvice("course-1", null);
    await searchAdvice("course-1", null, { query: "labs" });
    for (const call of db.advice.findMany.mock.calls) expect(call[0].where).toMatchObject(visibleCourseAdvice("course-1"));
    for (const call of db.advice.count.mock.calls) expect(call[0].where).toMatchObject(visibleCourseAdvice("course-1"));
  });
});

describe("feed cache", () => {
  it("serves the same unfiltered page from memory within the cache time", async () => {
    await searchAdvice("course-1", null);
    await searchAdvice("course-1", "someone");
    expect(db.advice.findMany).toHaveBeenCalledTimes(1);
  });

  it("works out isMine for each viewer from the cached rows", async () => {
    const forAuthor = await searchAdvice("course-1", "author-1");
    const forOther = await searchAdvice("course-1", "other");
    expect(forAuthor.items[0].isMine).toBe(true);
    expect(forOther.items[0].isMine).toBe(false);
    expect(JSON.stringify(forOther)).not.toContain("author-1");
  });

  it("caches each page separately and never caches a search or filter", async () => {
    await searchAdvice("course-1", null, { page: 1 });
    await searchAdvice("course-1", null, { page: 2 });
    await searchAdvice("course-1", null, { query: "labs" });
    await searchAdvice("course-1", null, { query: "labs" });
    await searchAdvice("course-1", null, { topic: "Loops" });
    expect(db.advice.findMany).toHaveBeenCalledTimes(5);
  });

  it("treats invalid page numbers as page 1 for the cache", async () => {
    await searchAdvice("course-1", null, { page: Number.NaN });
    await searchAdvice("course-1", null, { page: -3 });
    await searchAdvice("course-1", null, { page: 1 });
    expect(db.advice.findMany).toHaveBeenCalledTimes(1);
  });

  it("reads again once the cache time has passed", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-15T10:00:00Z") });
    await searchAdvice("course-1", null);
    vi.setSystemTime(new Date("2026-11-15T10:00:31Z"));
    await searchAdvice("course-1", null);
    expect(db.advice.findMany).toHaveBeenCalledTimes(2);
  });

  it("is turned off by ADVICE_FEED_CACHE_SECONDS=0", async () => {
    process.env.ADVICE_FEED_CACHE_SECONDS = "0";
    await searchAdvice("course-1", null);
    await searchAdvice("course-1", null);
    expect(db.advice.findMany).toHaveBeenCalledTimes(2);
  });

  it("falls back to 30 seconds for an invalid cache time", () => {
    for (const value of ["", "abc", "-1"]) {
      process.env.ADVICE_FEED_CACHE_SECONDS = value;
      expect(adviceCacheSeconds()).toBe(30);
    }
  });

  it("invalidateCourseAdvice drops only that course", async () => {
    await searchAdvice("course-1", null);
    await searchAdvice("course-2", null);
    invalidateCourseAdvice("course-1");
    await searchAdvice("course-1", null);
    await searchAdvice("course-2", null);
    expect(db.advice.findMany).toHaveBeenCalledTimes(3);
  });

  it("publishing advice invalidates the course, so the new post shows at once", async () => {
    await searchAdvice("course-1", null);
    const result = await publishAdvice("user-1", {
      courseId: "course-1", scopeKind: "COURSE", scopeValue: "", title: "Start early", body: "Labs take time.", resourceUrl: "", resourceTitle: "", isAnonymous: false,
    });
    expect(result.ok).toBe(true);
    db.advice.findMany.mockResolvedValue([row("new-advice"), row("a1")]);
    db.advice.count.mockResolvedValue(2);
    const feed = await searchAdvice("course-1", null);
    expect(feed.items.map(item => item.id)).toEqual(["new-advice", "a1"]);
  });

  it("does not cache a failed read, and logs it without text", async () => {
    db.advice.count.mockRejectedValueOnce(Object.assign(new Error("down"), { code: "P1001" }));
    await expect(searchAdvice("course-1", null)).rejects.toThrow("down");
    expect(logError).toHaveBeenCalledWith("advice_retrieval_failed", { courseId: "course-1", errorType: "Error", errorCode: "P1001" });
    await searchAdvice("course-1", null);
    expect(db.advice.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("allowAdviceFeedRead", () => {
  it("counts reads per student", () => {
    expect(allowAdviceFeedRead("student-1")).toBe(true);
    expect(checkRateLimit).toHaveBeenCalledWith("advice-feed:student-1", 120, 60_000);
  });

  it("refuses over the limit and logs only the student's ID", () => {
    checkRateLimit.mockReturnValueOnce({ ok: false, retryAfterSeconds: 42 });
    expect(allowAdviceFeedRead("student-1")).toBe(false);
    expect(logError).toHaveBeenCalledWith("advice_feed_rate_limited", { userId: "student-1", retryAfterSeconds: "42" });
  });
});
