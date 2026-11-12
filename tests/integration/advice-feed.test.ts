import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getCourseAdvice } from "@/lib/advice";
import { ADVICE_PAGE_SIZE, ANONYMOUS_AUTHOR } from "@/lib/advice-rules";

// US-38 against a real database: the feed of one course shows only that course's visible advice, newest first, with
// the right scope; an anonymous author's name never leaves the service; a target of another course keeps the advice out
// of the feed; a deleted or unpublished target turns the advice into course advice; and the pages hold every advice once.

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const id = (name: string) => `it-adv-${name}-${stamp}`;
const faculty = { id: id("faculty"), code: `IAF${stamp}`.toUpperCase().slice(0, 20), name: "Advice Faculty" };
const courseA = id("course-a");
const courseB = id("course-b");
const empty = id("course-empty");
const term = { id: id("term"), name: `Fall 2024 ${stamp}` };
const author = { id: id("author"), name: "Named Author", email: `${id("author")}@advice.test` };
const secret = { id: id("secret"), name: "Secret Author", email: `${id("secret")}@advice.test` };
const gone = { id: id("gone"), name: "Leaving Author", email: `${id("gone")}@advice.test` };
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

beforeAll(async () => {
  await db.faculty.create({ data: faculty });
  await db.course.createMany({ data: [courseA, courseB, empty].map((courseId, index) => ({
    id: courseId, code: `IA${index}${stamp}`.toUpperCase().slice(0, 20), name: `Advice ${index}`, facultyId: faculty.id,
  })) });
  await db.term.create({ data: term });
  await db.user.createMany({ data: [author, secret, gone].map(user => ({ ...user, passwordHash: "x" })) });
  const paper = (fileId: string, courseId: string, extra: Record<string, unknown> = {}) => db.courseFile.create({ data: {
    id: fileId, courseId, title: `Final ${fileId.slice(7, 20)}`, category: "EXAM", examType: "FINAL", year: 2024,
    originalFileName: "exam.pdf", storageKey: "exam.pdf", mimeType: "application/pdf", ...extra,
  } });
  await paper(id("paper-a"), courseA);
  await paper(id("paper-b"), courseB);
  await paper(id("paper-pending"), courseA, { status: "PENDING" });
  await paper(id("paper-deleted"), courseA);
  await db.questionGroup.createMany({ data: [
    { id: id("group-a"), courseId: courseA, text: "Explain the TCP three-way handshake.", normalizedText: `tcp ${stamp}`, paperCount: 2, rank: 1 },
    { id: id("group-b"), courseId: courseB, text: "Define a context-free grammar.", normalizedText: `cfg ${stamp}`, paperCount: 1, rank: 1 },
  ] });
  // Course A, newest first: a5 … a1. Course B: b1. Left out of A's feed: removed, and two with course B's targets.
  await db.advice.createMany({ data: [
    { id: id("a1"), courseId: courseA, authorId: author.id, body: "Start with the course notes.", createdAt: minutesAgo(50) },
    { id: id("a2"), courseId: courseA, authorId: author.id, body: "The 2024 final is the best practice.", scope: "EXAM", fileId: id("paper-a"), createdAt: minutesAgo(40) },
    { id: id("a3"), courseId: courseA, authorId: secret.id, anonymous: true, body: "Fall exams were harder.", scope: "SESSION", termId: term.id, createdAt: minutesAgo(30), editedAt: minutesAgo(5) },
    { id: id("a4"), courseId: courseA, authorId: author.id, body: "Know the handshake cold.", scope: "QUESTION", questionGroupId: id("group-a"), resourceUrl: "https://example.com/tcp", createdAt: minutesAgo(20) },
    { id: id("a5"), courseId: courseA, authorId: gone.id, body: "Routing is always on the final.", scope: "TOPIC", topic: "Routing", resourceUrl: "javascript:alert(1)", createdAt: minutesAgo(10) },
    { id: id("a-pending"), courseId: courseA, authorId: author.id, body: "About a pending paper.", scope: "EXAM", fileId: id("paper-pending"), createdAt: minutesAgo(60) },
    { id: id("a-deleted"), courseId: courseA, authorId: author.id, body: "About a deleted paper.", scope: "EXAM", fileId: id("paper-deleted"), createdAt: minutesAgo(70) },
    { id: id("a-removed"), courseId: courseA, authorId: author.id, body: "Removed advice.", status: "REMOVED", removedAt: minutesAgo(1), removedById: author.id, createdAt: minutesAgo(2) },
    { id: id("a-wrong-file"), courseId: courseA, authorId: author.id, body: "Points at course B's paper.", scope: "EXAM", fileId: id("paper-b"), createdAt: minutesAgo(3) },
    { id: id("a-wrong-group"), courseId: courseA, authorId: author.id, body: "Points at course B's question.", scope: "QUESTION", questionGroupId: id("group-b"), createdAt: minutesAgo(4) },
    { id: id("b1"), courseId: courseB, authorId: author.id, body: "Course B advice.", createdAt: minutesAgo(1) },
  ] });
  // A deleted paper leaves its advice with no target; a deleted account leaves its advice with no author.
  await db.courseFile.delete({ where: { id: id("paper-deleted") } });
  await db.user.delete({ where: { id: gone.id } });
});

afterAll(async () => {
  try {
    // Deleting the courses deletes their advice, papers, and groups.
    await db.course.deleteMany({ where: { id: { in: [courseA, courseB, empty] } } });
    await db.user.deleteMany({ where: { id: { in: [author.id, secret.id, gone.id] } } });
    await db.term.deleteMany({ where: { id: term.id } });
    await db.faculty.deleteMany({ where: { id: faculty.id } });
    expect(await db.advice.count({ where: { courseId: { in: [courseA, courseB, empty] } } })).toBe(0);
  } finally {
    await db.$disconnect();
  }
});

describe("the course advice feed (US-38)", () => {
  it("shows only the course's visible advice, newest first, and never another course's", async () => {
    const feed = await getCourseAdvice(courseA);
    expect(feed.items.map(item => item.id)).toEqual(["a5", "a4", "a3", "a2", "a1", "a-pending", "a-deleted"].map(id));
    expect(feed).toMatchObject({ total: 7, page: 1, totalPages: 1 });
    expect((await getCourseAdvice(courseB)).items.map(item => item.id)).toEqual([id("b1")]);
    expect(await getCourseAdvice(empty)).toEqual({ items: [], total: 0, page: 1, totalPages: 1 });
  });

  it("shows each scope with its target", async () => {
    const about = Object.fromEntries((await getCourseAdvice(courseA)).items.map(item => [item.id, item.about]));
    expect(about[id("a1")]).toEqual({ scope: "COURSE", targetGone: false });
    expect(about[id("a2")]).toEqual({ scope: "EXAM", label: expect.stringContaining("Final"), fileId: id("paper-a") });
    expect(about[id("a3")]).toEqual({ scope: "SESSION", label: term.name });
    expect(about[id("a4")]).toEqual({ scope: "QUESTION", label: "Explain the TCP three-way handshake.", groupId: id("group-a") });
    expect(about[id("a5")]).toEqual({ scope: "TOPIC", label: "Routing" });
  });

  it("shows advice about a pending or deleted paper as course advice, without naming the paper", async () => {
    const items = (await getCourseAdvice(courseA)).items.filter(item => [id("a-pending"), id("a-deleted")].includes(item.id));
    expect(items.map(item => item.about)).toEqual([{ scope: "COURSE", targetGone: true }, { scope: "COURSE", targetGone: true }]);
    expect(JSON.stringify(items)).not.toContain(id("paper-pending"));
  });

  it("never hands out an anonymous author's name or any author's ID", async () => {
    const feed = await getCourseAdvice(courseA);
    const anonymous = feed.items.find(item => item.id === id("a3"))!;
    expect(anonymous).toMatchObject({ author: ANONYMOUS_AUTHOR, anonymous: true, edited: true });
    const text = JSON.stringify(feed);
    expect(text).not.toContain(secret.name);
    for (const user of [author, secret, gone]) expect(text).not.toContain(user.id);
    expect(feed.items.find(item => item.id === id("a1"))!.author).toBe(author.name);
    expect(feed.items.find(item => item.id === id("a5"))!.author).toBe("Former student");
  });

  it("shows only an https resource", async () => {
    const items = (await getCourseAdvice(courseA)).items;
    expect(items.find(item => item.id === id("a4"))!.resourceUrl).toBe("https://example.com/tcp");
    expect(items.find(item => item.id === id("a5"))!.resourceUrl).toBeNull();
  });

  it("drops advice from the feed once it is removed", async () => {
    await db.advice.update({ where: { id: id("a1") }, data: { status: "REMOVED", removedAt: new Date(), removedById: author.id } });
    try {
      expect((await getCourseAdvice(courseA)).items.map(item => item.id)).not.toContain(id("a1"));
    } finally {
      await db.advice.update({ where: { id: id("a1") }, data: { status: "VISIBLE", removedAt: null, removedById: null } });
    }
  });

  it("splits a long feed into pages that hold every advice exactly once", async () => {
    const extra = Array.from({ length: ADVICE_PAGE_SIZE * 2 }, (_, index) => ({
      id: id(`many-${String(index).padStart(2, "0")}`), courseId: empty, authorId: author.id, body: `Advice ${index}`,
      // Two at each time, so the ID decides their order.
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, Math.floor(index / 2))),
    }));
    await db.advice.createMany({ data: [...extra, { id: id("many-last"), courseId: empty, authorId: author.id, body: "Oldest", createdAt: new Date(Date.UTC(2025, 0, 1)) }] });
    const pages = await Promise.all([1, 2, 3].map(page => getCourseAdvice(empty, page)));
    expect(pages.map(page => [page.page, page.totalPages, page.items.length])).toEqual([[1, 3, 20], [2, 3, 20], [3, 3, 1]]);
    const seen = pages.flatMap(page => page.items.map(item => item.id));
    expect(new Set(seen).size).toBe(ADVICE_PAGE_SIZE * 2 + 1);
    expect(seen.at(-1)).toBe(id("many-last"));
    expect((await getCourseAdvice(empty, 99)).page).toBe(3);
    expect((await getCourseAdvice(empty, "abc")).page).toBe(1);
  });
});
