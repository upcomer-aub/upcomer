import { randomUUID } from "node:crypto";
import { AdviceScopeKind, AdviceStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { searchAdvice } from "@/lib/advice";
import { addAdviceComment, deleteAdviceComment, getAdviceComments, type CommentActor } from "@/lib/advice-comments";
import { db } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";

// US-41 against a real, migrated database: replies in time order under the right post, empty replies refused, a removed
// post's thread hidden, the "(author)" label that keeps an anonymous author anonymous, and who may delete a reply. Everything
// is created here with a unique suffix and deleted in afterAll.

const run = randomUUID().slice(0, 8);
const ids = { faculty: "", courseA: "", courseB: "", author: "", s1: "", s2: "", admin: "", anon: "", named: "", removed: "", other: "" };
const student = (id: string) => ({ id, role: "STUDENT" as const });

beforeEach(() => resetRateLimits());

beforeAll(async () => {
  const faculty = await db.faculty.create({ data: { code: `FC${run}`, name: `Faculty ${run}` } });
  const [courseA, courseB] = await Promise.all(["A", "B"].map(name => db.course.create({ data: { code: `C${name}${run}`, name: `Comments ${name}`, facultyId: faculty.id } })));
  const [author, s1, s2, admin] = await Promise.all([["author", "STUDENT"], ["s1", "STUDENT"], ["s2", "STUDENT"], ["admin", "ADMIN"]].map(([name, role]) =>
    db.user.create({ data: { email: `cmt-${name}-${run}@example.com`, passwordHash: "x", name: `Commenter ${name} ${run}`, role: role as "STUDENT" | "ADMIN" } })));
  const advice = async (courseId: string, isAnonymous: boolean, title: string) => (await db.advice.create({
    data: { courseId, authorId: author.id, isAnonymous, scopeKind: AdviceScopeKind.COURSE, scopeLabel: "course", title: `${title} ${run}`, body: "body" },
  })).id;
  Object.assign(ids, {
    faculty: faculty.id, courseA: courseA.id, courseB: courseB.id, author: author.id, s1: s1.id, s2: s2.id, admin: admin.id,
    anon: await advice(courseA.id, true, "anonymous"), named: await advice(courseA.id, false, "named"),
    removed: await advice(courseA.id, false, "to remove"), other: await advice(courseB.id, false, "other course"),
  });
});

afterAll(async () => {
  await db.course.deleteMany({ where: { id: { in: [ids.courseA, ids.courseB].filter(Boolean) } } });
  await db.user.deleteMany({ where: { id: { in: [ids.author, ids.s1, ids.s2, ids.admin].filter(Boolean) } } });
  if (ids.faculty) await db.faculty.deleteMany({ where: { id: ids.faculty } });
  await db.$disconnect();
});

const add = async (userId: string, adviceId: string, body: string, courseId = ids.courseA) => {
  const result = await addAdviceComment(userId, courseId, adviceId, body);
  if (!result.ok) throw new Error(`add failed: ${result.error}`);
  return result.id;
};
const thread = async (adviceId: string, viewer: CommentActor = student(ids.s1)) => (await getAdviceComments(ids.courseA, [ids.anon, ids.named, ids.removed], viewer)).get(adviceId) ?? [];

describe("replies beneath advice (US-41)", () => {
  it("shows replies beneath their post in time order, and never under another post (acceptance test 1)", async () => {
    const first = await add(ids.s1, ids.anon, `First question ${run}`);
    const second = await add(ids.author, ids.anon, `Author answer ${run}`);
    const third = await add(ids.s2, ids.anon, `Follow-up ${run}`);
    const replies = await thread(ids.anon);
    expect(replies.map(reply => reply.id)).toEqual([first, second, third]);
    expect(replies.map(reply => reply.body)).toEqual([`First question ${run}`, `Author answer ${run}`, `Follow-up ${run}`]);
    expect(replies.every((reply, index) => index === 0 || reply.createdAt >= replies[index - 1].createdAt)).toBe(true);
    expect(await thread(ids.named)).toEqual([]);
  });

  it("keeps an anonymous author anonymous in the thread, and marks a named author", async () => {
    const replies = await thread(ids.anon);
    expect(replies.map(reply => reply.authorLabel)).toEqual([`Commenter s1 ${run}`, "Anonymous student (author)", `Commenter s2 ${run}`]);
    const json = JSON.stringify(replies);
    expect(json).not.toContain(ids.author);
    expect(json).not.toContain(`Commenter author ${run}`);
    await add(ids.author, ids.named, `Named answer ${run}`);
    expect((await thread(ids.named)).map(reply => reply.authorLabel)).toEqual([`Commenter author ${run} (author)`]);
  });

  it("refuses an empty reply and saves nothing (acceptance test 3)", async () => {
    const before = await db.adviceComment.count({ where: { adviceId: ids.named } });
    for (const body of ["", "   ", "\n\n", "​"]) expect(await addAdviceComment(ids.s1, ids.courseA, ids.named, body)).toEqual({ ok: false, error: "body_required" });
    expect(await db.adviceComment.count({ where: { adviceId: ids.named } })).toBe(before);
  });

  it("refuses a reply to another course's advice through this course, and to unknown advice", async () => {
    expect(await addAdviceComment(ids.s1, ids.courseA, ids.other, "Hi")).toEqual({ ok: false, error: "not_found" });
    expect(await addAdviceComment(ids.s1, ids.courseA, "no-such-advice", "Hi")).toEqual({ ok: false, error: "not_found" });
    expect(await db.adviceComment.count({ where: { adviceId: ids.other } })).toBe(0);
  });

  it("hides a removed post's thread and refuses new replies to it (acceptance test 2)", async () => {
    await add(ids.s1, ids.removed, `Before removal ${run}`);
    expect(await thread(ids.removed)).toHaveLength(1);
    await db.advice.update({ where: { id: ids.removed }, data: { status: AdviceStatus.REMOVED, removedAt: new Date(), removedById: ids.admin } });
    expect(await thread(ids.removed)).toEqual([]);
    expect((await searchAdvice(ids.courseA, ids.s1)).items.map(item => item.id)).not.toContain(ids.removed);
    expect(await addAdviceComment(ids.s2, ids.courseA, ids.removed, "Too late")).toEqual({ ok: false, error: "not_found" });
    // Hidden, not destroyed: the reply is still there for moderation (US-77).
    expect(await db.adviceComment.count({ where: { adviceId: ids.removed } })).toBe(1);
  });
});

describe("deleting replies (US-41)", () => {
  it("lets the reply's author delete it, and refuses other students, including the post's author", async () => {
    const reply = await add(ids.s1, ids.named, `Mine to delete ${run}`);
    expect(await deleteAdviceComment(student(ids.s2), ids.courseA, reply)).toEqual({ ok: false, error: "forbidden" });
    expect(await deleteAdviceComment(student(ids.author), ids.courseA, reply)).toEqual({ ok: false, error: "forbidden" });
    expect(await db.adviceComment.count({ where: { id: reply } })).toBe(1);
    expect((await thread(ids.named, student(ids.s2))).find(item => item.id === reply)).toMatchObject({ isMine: false, canDelete: false });
    expect((await thread(ids.named, student(ids.s1))).find(item => item.id === reply)).toMatchObject({ isMine: true, canDelete: true });
    expect(await deleteAdviceComment(student(ids.s1), ids.courseA, reply)).toEqual({ ok: true, adviceId: ids.named });
    expect(await db.adviceComment.count({ where: { id: reply } })).toBe(0);
    expect(await deleteAdviceComment(student(ids.s1), ids.courseA, reply)).toEqual({ ok: false, error: "not_found" });
  });

  it("lets an admin delete any reply, but only through its own course", async () => {
    const reply = await add(ids.s2, ids.named, `Admin removes this ${run}`);
    expect(await deleteAdviceComment({ id: ids.admin, role: "ADMIN" }, ids.courseB, reply)).toEqual({ ok: false, error: "not_found" });
    expect((await thread(ids.named, { id: ids.admin, role: "ADMIN" })).find(item => item.id === reply)?.canDelete).toBe(true);
    expect(await deleteAdviceComment({ id: ids.admin, role: "ADMIN" }, ids.courseA, reply)).toEqual({ ok: true, adviceId: ids.named });
    expect(await db.adviceComment.count({ where: { id: reply } })).toBe(0);
  });

  it("keeps a deleted student's reply as a former student's, and deletes replies with their post", async () => {
    const leaving = await db.user.create({ data: { email: `cmt-leaving-${run}@example.com`, passwordHash: "x", name: `Leaving ${run}` } });
    const reply = await add(leaving.id, ids.named, `From a leaving student ${run}`);
    await db.user.delete({ where: { id: leaving.id } });
    expect((await thread(ids.named)).find(item => item.id === reply)).toMatchObject({ authorLabel: "Former student", byPostAuthor: false, canDelete: false });
    const post = await db.advice.create({ data: { courseId: ids.courseA, authorId: ids.author, scopeKind: AdviceScopeKind.COURSE, scopeLabel: "course", title: "temp", body: "temp" } });
    await add(ids.s1, post.id, "On a post that goes away");
    await db.advice.delete({ where: { id: post.id } });
    expect(await db.adviceComment.count({ where: { adviceId: post.id } })).toBe(0);
  });
});
