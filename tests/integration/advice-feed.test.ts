import { randomUUID } from "node:crypto";
import { AdviceScopeKind, AdviceStatus, FileCategory } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invalidateCourseAdvice, publishAdvice, resetAdviceCache, searchAdvice, type PublishInput } from "@/lib/advice";
import { db } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";

// The course feed (US-38) against a real, migrated database: only this course's visible advice, the guard against a
// target of another course, anonymity in the feed, stable pages, and the cache's invalidation. Records are created with a
// unique suffix and deleted in afterAll.

process.env.ADVICE_RATE_LIMIT_PER_HOUR = "1000";

const run = randomUUID().slice(0, 8);
const ids = {} as { faculty: string; courseA: string; courseB: string; examB: string; groupB: string; author: string; reader: string };

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  courseId: ids.courseA, scopeKind: "COURSE", scopeValue: "", title: `Feed ${run}`, body: `Body ${run}`, resourceUrl: "", resourceTitle: "", isAnonymous: false, ...over,
});
const publish = async (over: Partial<PublishInput> = {}) => {
  const result = await publishAdvice(ids.author, input(over));
  if (!result.ok) throw new Error(`publish failed: ${result.error}`);
  return result.id;
};

beforeEach(() => {
  resetRateLimits();
  resetAdviceCache();
});

beforeAll(async () => {
  const faculty = await db.faculty.create({ data: { code: `FF${run}`, name: `Faculty ${run}` } });
  const [courseA, courseB, author, reader] = await Promise.all([
    db.course.create({ data: { code: `FA${run}`, name: "Feed A", facultyId: faculty.id } }),
    db.course.create({ data: { code: `FB${run}`, name: "Feed B", facultyId: faculty.id } }),
    db.user.create({ data: { email: `feed-author-${run}@example.com`, passwordHash: "x", name: `Hidden Author ${run}` } }),
    db.user.create({ data: { email: `feed-reader-${run}@example.com`, passwordHash: "x", name: `Reader ${run}` } }),
  ]);
  const examB = await db.courseFile.create({
    data: { courseId: courseB.id, title: `Final B ${run}`, originalFileName: "b.pdf", storageKey: `test/${run}/b`, category: FileCategory.EXAM, year: 2025 },
  });
  const groupB = await db.questionGroup.create({ data: { courseId: courseB.id, text: `Other ${run}`, normalizedText: `other ${run}`, paperCount: 1, rank: 1 } });
  Object.assign(ids, { faculty: faculty.id, courseA: courseA.id, courseB: courseB.id, examB: examB.id, groupB: groupB.id, author: author.id, reader: reader.id });
});

afterAll(async () => {
  await db.course.deleteMany({ where: { id: { in: [ids.courseA, ids.courseB].filter(Boolean) } } });
  await db.user.deleteMany({ where: { id: { in: [ids.author, ids.reader].filter(Boolean) } } });
  if (ids.faculty) await db.faculty.deleteMany({ where: { id: ids.faculty } });
  await db.$disconnect();
});

describe("US-38: course advice feed", () => {
  it("shows only this course's visible advice, newest first", async () => {
    const older = await publish({ title: `Older ${run}` });
    const newer = await publish({ title: `Newer ${run}` });
    await publishAdvice(ids.author, input({ courseId: ids.courseB, title: `Other course ${run}` }));
    const removed = await publish({ title: `Removed ${run}` });
    await db.advice.update({ where: { id: removed }, data: { status: AdviceStatus.REMOVED, removedAt: new Date() } });
    invalidateCourseAdvice(ids.courseA);

    const feed = await searchAdvice(ids.courseA, ids.reader);
    const titles = feed.items.map(item => item.title);
    expect(titles.indexOf(`Newer ${run}`)).toBeLessThan(titles.indexOf(`Older ${run}`));
    expect(titles).not.toContain(`Other course ${run}`);
    expect(titles).not.toContain(`Removed ${run}`);
    expect(feed.items.every(item => item.courseId === ids.courseA)).toBe(true);
    expect([older, newer].every(id => feed.items.some(item => item.id === id))).toBe(true);
  });

  it("leaves out advice whose exam paper or question belongs to another course (bad data)", async () => {
    const badExam = await db.advice.create({
      data: { courseId: ids.courseA, authorId: ids.author, scopeKind: AdviceScopeKind.EXAM, scopeLabel: "x", fileId: ids.examB, title: `Bad exam ${run}`, body: "b" },
    });
    const badQuestion = await db.advice.create({
      data: { courseId: ids.courseA, authorId: ids.author, scopeKind: AdviceScopeKind.QUESTION, scopeLabel: "x", groupId: ids.groupB, title: `Bad question ${run}`, body: "b" },
    });
    const feed = await searchAdvice(ids.courseA, ids.reader);
    const search = await searchAdvice(ids.courseA, ids.reader, { query: "Bad" });
    for (const page of [feed, search]) {
      expect(page.items.map(item => item.id)).not.toContain(badExam.id);
      expect(page.items.map(item => item.id)).not.toContain(badQuestion.id);
    }
    // Counts agree with the items, so the page count is not inflated by hidden advice.
    expect(search.total).toBe(0);
  });

  it("never sends an anonymous author's name, or any author ID, to the feed", async () => {
    await publish({ title: `Anon ${run}`, isAnonymous: true });
    const feed = await searchAdvice(ids.courseA, ids.reader);
    const text = JSON.stringify(feed);
    expect(text).not.toContain(ids.author);
    const anon = feed.items.find(item => item.title === `Anon ${run}`)!;
    expect(anon.authorLabel).not.toContain("Hidden Author");
    expect(anon.isMine).toBe(false);
    const forAuthor = await searchAdvice(ids.courseA, ids.author);
    expect(forAuthor.items.find(item => item.title === `Anon ${run}`)!.isMine).toBe(true);
  });

  it("shows a newly published post at once, even when the feed was cached", async () => {
    await searchAdvice(ids.courseA, ids.reader);
    await publish({ title: `Fresh ${run}` });
    const feed = await searchAdvice(ids.courseA, ids.reader);
    expect(feed.items[0].title).toBe(`Fresh ${run}`);
  });

  it("gives stable pages of 20 with no item twice, and clamps the page number", async () => {
    // Same createdAt for many posts, so only the ID tie-break keeps the order stable.
    const at = new Date("2026-01-01T00:00:00Z");
    await db.advice.createMany({
      data: Array.from({ length: 45 }, (_, index) => ({
        courseId: ids.courseB, authorId: ids.author, scopeKind: AdviceScopeKind.COURSE, scopeLabel: "x", title: `Bulk ${index} ${run}`, body: "b", createdAt: at,
      })),
    });
    invalidateCourseAdvice(ids.courseB);
    const pages = await Promise.all([1, 2, 3].map(page => searchAdvice(ids.courseB, null, { page })));
    const seen = pages.flatMap(page => page.items.map(item => item.id));
    expect(pages.map(page => page.items.length)).toEqual([20, 20, pages[2].total - 40]);
    expect(new Set(seen).size).toBe(seen.length);
    expect((await searchAdvice(ids.courseB, null, { page: 999 })).page).toBe(pages[0].totalPages);
    expect((await searchAdvice(ids.courseB, null, { page: -1 })).page).toBe(1);
  });
});
