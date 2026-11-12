import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getCourseAdvice, resetAdviceCache } from "@/lib/advice";
import { deleteAdvice, editAdvice, getOwnAdvice } from "@/lib/advice-changes";
import { resetRateLimits } from "@/lib/rate-limit";

// US-36 against a real database: only the author edits or deletes their advice, the change shows in the course feed at
// once (the feed's cache is invalidated), another student's attempt changes nothing, and removed advice stays removed.

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const id = (name: string) => `it-advch-${name}-${stamp}`;
const faculty = { id: id("faculty"), code: `IACF${stamp}`.toUpperCase().slice(0, 20), name: "Advice Changes Faculty" };
const courseA = id("course-a");
const courseB = id("course-b");
const author = { id: id("author"), name: "Advice Author", email: `${id("author")}@advice.test` };
const other = { id: id("other"), name: "Other Student", email: `${id("other")}@advice.test` };
const admin = { id: id("admin"), name: "Advice Admin", email: `${id("admin")}@advice.test`, role: "ADMIN" as const };

beforeAll(async () => {
  await db.faculty.create({ data: faculty });
  await db.course.createMany({ data: [courseA, courseB].map((courseId, index) => ({
    id: courseId, code: `IC${index}${stamp}`.toUpperCase().slice(0, 20), name: `Advice Changes ${index}`, facultyId: faculty.id,
  })) });
  await db.user.createMany({ data: [author, other, admin].map(user => ({ ...user, passwordHash: "x" })) });
});

// Fresh advice for every test, so each one starts from the same state.
beforeEach(async () => {
  resetAdviceCache();
  resetRateLimits();
  await db.advice.deleteMany({ where: { courseId: { in: [courseA, courseB] } } });
  await db.advice.createMany({ data: [
    { id: id("mine"), courseId: courseA, authorId: author.id, body: "Start with the notes.", createdAt: new Date(Date.now() - 60_000) },
    { id: id("anon"), courseId: courseA, authorId: author.id, anonymous: true, body: "Fall finals were long." },
    { id: id("theirs"), courseId: courseA, authorId: other.id, body: "Their advice." },
    { id: id("removed"), courseId: courseA, authorId: author.id, body: "Removed by an admin.", status: "REMOVED", removedAt: new Date(), removedById: admin.id },
    { id: id("elsewhere"), courseId: courseB, authorId: author.id, body: "Course B advice." },
  ] });
});

afterAll(async () => {
  try {
    await db.course.deleteMany({ where: { id: { in: [courseA, courseB] } } });
    await db.user.deleteMany({ where: { id: { in: [author.id, other.id, admin.id] } } });
    await db.faculty.deleteMany({ where: { id: faculty.id } });
    expect(await db.advice.count({ where: { courseId: { in: [courseA, courseB] } } })).toBe(0);
  } finally {
    await db.$disconnect();
  }
});

const feedBodies = async (courseId = courseA) => (await getCourseAdvice(courseId)).items.map(item => item.body);
const stored = (adviceId: string) => db.advice.findUniqueOrThrow({ where: { id: adviceId } });

describe("editing and deleting one's own advice (US-36)", () => {
  it("lets the author edit their advice, and the feed shows the new text at once, marked edited", async () => {
    expect(await feedBodies()).toContain("Start with the notes.");
    expect(await editAdvice(author.id, { adviceId: id("mine"), body: "Start with the 2024 final.", resourceUrl: "https://example.com/final" }))
      .toEqual({ ok: true, courseId: courseA, changed: true });
    const item = (await getCourseAdvice(courseA)).items.find(entry => entry.id === id("mine"))!;
    expect(item).toMatchObject({ body: "Start with the 2024 final.", resourceUrl: "https://example.com/final", edited: true });
    expect(await feedBodies()).not.toContain("Start with the notes.");
    expect((await stored(id("mine"))).editedAt).not.toBeNull();
  });

  it("lets the author delete their advice, and it leaves the feed at once but is kept for moderation", async () => {
    expect((await getCourseAdvice(courseA)).total).toBe(3);
    expect(await deleteAdvice(author.id, id("mine"))).toEqual({ ok: true, courseId: courseA, changed: true });
    const feed = await getCourseAdvice(courseA);
    expect(feed.total).toBe(2);
    expect(feed.items.map(item => item.id)).not.toContain(id("mine"));
    expect(await stored(id("mine"))).toMatchObject({ status: "REMOVED", removedById: author.id, body: "Start with the notes." });
    expect(await getOwnAdvice(author.id, courseA, id("mine"))).toBeNull();
    // Deleting again, or editing it back, is refused.
    expect(await deleteAdvice(author.id, id("mine"))).toEqual({ ok: false, error: "not_found" });
    expect(await editAdvice(author.id, { adviceId: id("mine"), body: "Back again." })).toEqual({ ok: false, error: "not_found" });
    expect((await stored(id("mine"))).status).toBe("REMOVED");
  });

  it("refuses another student's edit and delete, and changes nothing", async () => {
    const before = await stored(id("mine"));
    expect(await editAdvice(other.id, { adviceId: id("mine"), body: "Hijacked." })).toEqual({ ok: false, error: "not_found" });
    expect(await deleteAdvice(other.id, id("mine"))).toEqual({ ok: false, error: "not_found" });
    expect(await getOwnAdvice(other.id, courseA, id("mine"))).toBeNull();
    expect(await stored(id("mine"))).toEqual(before);
    // An admin is not the author either: removing advice is US-77's job, not an edit.
    expect(await editAdvice(admin.id, { adviceId: id("mine"), body: "Admin edit." })).toEqual({ ok: false, error: "not_found" });
    expect(await stored(id("mine"))).toEqual(before);
  });

  it("lets an anonymous author edit their advice, which stays anonymous, and marks only their own advice as theirs", async () => {
    expect((await editAdvice(author.id, { adviceId: id("anon"), body: "Fall finals were long, bring water." })).ok).toBe(true);
    const mine = (await getCourseAdvice(courseA, 1, author.id)).items;
    const anonymous = mine.find(item => item.id === id("anon"))!;
    expect(anonymous).toMatchObject({ author: "Anonymous student", mine: true, body: "Fall finals were long, bring water." });
    expect(mine.find(item => item.id === id("theirs"))!.mine).toBe(false);
    const seenByOther = await getCourseAdvice(courseA, 1, other.id);
    const anonymousForOther = seenByOther.items.find(item => item.id === id("anon"))!;
    expect(anonymousForOther).toMatchObject({ author: "Anonymous student", mine: false });
    // The same author also has named advice in this course, so only the anonymous item is checked for the name.
    expect(JSON.stringify(anonymousForOther)).not.toContain(author.name);
    expect(JSON.stringify([mine, seenByOther])).not.toMatch(new RegExp(`${author.id}|${other.id}`));
  });

  it("never lets an author edit advice an admin removed back into the feed", async () => {
    expect(await editAdvice(author.id, { adviceId: id("removed"), body: "Unremoved?" })).toEqual({ ok: false, error: "not_found" });
    expect(await deleteAdvice(author.id, id("removed"))).toEqual({ ok: false, error: "not_found" });
    expect(await stored(id("removed"))).toMatchObject({ status: "REMOVED", removedById: admin.id, body: "Removed by an admin." });
    expect(await feedBodies()).not.toContain("Unremoved?");
  });

  it("finds the edit page's advice only in its own course", async () => {
    expect(await getOwnAdvice(author.id, courseA, id("mine"))).toMatchObject({ id: id("mine"), courseId: courseA });
    expect(await getOwnAdvice(author.id, courseB, id("mine"))).toBeNull();
  });

  it("changes only the one course's feed", async () => {
    expect(await feedBodies(courseB)).toEqual(["Course B advice."]);
    await deleteAdvice(author.id, id("mine"));
    expect(await feedBodies(courseB)).toEqual(["Course B advice."]);
  });

  it("keeps one outcome when the author edits and deletes at the same time: deleted advice never comes back", async () => {
    const results = await Promise.all([
      editAdvice(author.id, { adviceId: id("mine"), body: "Edited in a race." }),
      deleteAdvice(author.id, id("mine")),
      editAdvice(author.id, { adviceId: id("mine"), body: "Edited in a race again." }),
    ]);
    expect(results[1]).toMatchObject({ ok: true });
    expect((await stored(id("mine"))).status).toBe("REMOVED");
    expect((await getCourseAdvice(courseA)).items.map(item => item.id)).not.toContain(id("mine"));
  });
});
