import { beforeEach, describe, expect, it, vi } from "vitest";

// US-41: replies beneath advice, with the database mocked: the author label (anonymity), empty and long replies, visible
// advice of the course only, who may delete, the limit, and failures. The real database is in
// tests/integration/advice-comments.test.ts.

const db = vi.hoisted(() => ({
  advice: { findFirst: vi.fn() },
  adviceComment: { create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
}));
const logError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/logger", () => ({ logError, errorCode: (error: unknown) => (error as { code?: string } | null)?.code }));

import { addAdviceComment, deleteAdviceComment, getAdviceComments } from "@/lib/advice-comments";
import { commentAuthorLabel, commentMessage } from "@/lib/advice-comment-rules";
import { resetRateLimits } from "@/lib/rate-limit";

const student = { id: "student-1", role: "STUDENT" as const };
const other = { id: "student-2", role: "STUDENT" as const };
const admin = { id: "admin-1", role: "ADMIN" as const };
const events = () => logError.mock.calls.map(([event, context]) => ({ event, ...context }));

beforeEach(() => {
  resetRateLimits();
  delete process.env.ADVICE_COMMENT_RATE_LIMIT_PER_MINUTE;
  logError.mockReset();
  db.advice.findFirst.mockReset().mockResolvedValue({ id: "advice-1" });
  db.adviceComment.create.mockReset().mockResolvedValue({ id: "comment-1" });
  db.adviceComment.findFirst.mockReset().mockResolvedValue({ authorId: "student-1", adviceId: "advice-1" });
  db.adviceComment.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  db.adviceComment.findMany.mockReset().mockResolvedValue([]);
});

describe("commentAuthorLabel (US-41)", () => {
  const label = (over: Partial<Parameters<typeof commentAuthorLabel>[0]>) =>
    commentAuthorLabel({ commentAuthorId: "u1", authorName: "Rana", postAuthorId: "author", postAnonymous: false, ...over });
  it("shows another student's reply under their name", () => {
    expect(label({})).toEqual({ label: "Rana", byPostAuthor: false });
    // No anonymous replies for other students, even on an anonymous post.
    expect(label({ postAnonymous: true })).toEqual({ label: "Rana", byPostAuthor: false });
  });
  it("marks the post's author, keeping an anonymous author anonymous", () => {
    expect(label({ commentAuthorId: "author", authorName: "Karim" })).toEqual({ label: "Karim (author)", byPostAuthor: true });
    expect(label({ commentAuthorId: "author", authorName: "Karim", postAnonymous: true })).toEqual({ label: "Anonymous student (author)", byPostAuthor: true });
  });
  it("shows a deleted account as a former student, never as the post's author", () => {
    expect(label({ commentAuthorId: null, authorName: null })).toEqual({ label: "Former student", byPostAuthor: false });
    expect(label({ commentAuthorId: null, authorName: null, postAuthorId: null, postAnonymous: true })).toEqual({ label: "Former student", byPostAuthor: false });
  });
  it("has a message for each refusal and a safe default", () => {
    expect(commentMessage("forbidden")).toBe("You can only delete your own replies.");
    expect(commentMessage("<b>")).toBe(commentMessage("unexpected"));
    expect(commentMessage("constructor")).toBe(commentMessage("unexpected"));
  });
});

describe("addAdviceComment (US-41)", () => {
  it("saves a trimmed reply beneath visible advice of the course", async () => {
    expect(await addAdviceComment("student-1", "course-1", "advice-1", "  Thanks!\r\nWhich week?  ")).toEqual({ ok: true, id: "comment-1" });
    expect(db.advice.findFirst).toHaveBeenCalledWith({ where: { id: "advice-1", courseId: "course-1", status: "VISIBLE" }, select: { id: true } });
    expect(db.adviceComment.create).toHaveBeenCalledWith({ data: { adviceId: "advice-1", authorId: "student-1", body: "Thanks!\nWhich week?" }, select: { id: true } });
    expect(events()).toEqual([{ event: "advice_comment_saved", userId: "student-1", courseId: "course-1", adviceId: "advice-1", commentId: "comment-1" }]);
  });
  it("refuses an empty or invisible reply without touching the database (acceptance test 3)", async () => {
    for (const body of ["", "   ", "\n\t", "​​"]) expect(await addAdviceComment("student-1", "course-1", "advice-1", body)).toEqual({ ok: false, error: "body_required" });
    expect(db.advice.findFirst).not.toHaveBeenCalled();
    expect(events()[0]).toMatchObject({ event: "advice_comment_refused", reason: "body_required" });
  });
  it("refuses a reply over the limit", async () => {
    expect(await addAdviceComment("student-1", "course-1", "advice-1", "a".repeat(1001))).toEqual({ ok: false, error: "body_too_long" });
    expect((await addAdviceComment("student-1", "course-1", "advice-1", "a".repeat(1000))).ok).toBe(true);
  });
  it("refuses removed, unknown, or another course's advice", async () => {
    db.advice.findFirst.mockResolvedValue(null);
    expect(await addAdviceComment("student-1", "course-1", "advice-x", "Hi")).toEqual({ ok: false, error: "not_found" });
    db.adviceComment.create.mockRejectedValue(Object.assign(new Error("fk"), { code: "P2003" }));
    db.advice.findFirst.mockResolvedValue({ id: "advice-1" });
    expect(await addAdviceComment("student-1", "course-1", "advice-1", "Hi")).toEqual({ ok: false, error: "not_found" });
  });
  it("never logs the reply text", async () => {
    await addAdviceComment("student-1", "course-1", "advice-1", "my secret question");
    db.adviceComment.create.mockRejectedValue(new TypeError("db down"));
    await addAdviceComment("student-1", "course-1", "advice-1", "my secret question");
    expect(JSON.stringify(events())).not.toContain("secret");
    expect(events().at(-1)).toMatchObject({ event: "advice_comment_failed", operation: "add", errorType: "TypeError" });
  });
  it("limits replies per student per minute", async () => {
    process.env.ADVICE_COMMENT_RATE_LIMIT_PER_MINUTE = "1";
    await addAdviceComment("student-1", "course-1", "advice-1", "One");
    expect(await addAdviceComment("student-1", "course-1", "advice-1", "Two")).toEqual({ ok: false, error: "rate_limited" });
    expect((await addAdviceComment("student-2", "course-1", "advice-1", "Mine")).ok).toBe(true);
  });
});

describe("deleteAdviceComment (US-41)", () => {
  it("lets the reply's author delete it, limited to their own rows", async () => {
    expect(await deleteAdviceComment(student, "course-1", "comment-1")).toEqual({ ok: true, adviceId: "advice-1" });
    expect(db.adviceComment.findFirst).toHaveBeenCalledWith({ where: { id: "comment-1", advice: { courseId: "course-1" } }, select: { authorId: true, adviceId: true } });
    expect(db.adviceComment.deleteMany).toHaveBeenCalledWith({ where: { id: "comment-1", authorId: "student-1" } });
  });
  it("refuses another student, deleting nothing", async () => {
    expect(await deleteAdviceComment(other, "course-1", "comment-1")).toEqual({ ok: false, error: "forbidden" });
    expect(db.adviceComment.deleteMany).not.toHaveBeenCalled();
    expect(events()).toEqual([expect.objectContaining({ event: "advice_comment_delete_refused", userId: "student-2", reason: "forbidden", byAdmin: "false" })]);
  });
  it("lets an admin delete any reply of the course", async () => {
    expect(await deleteAdviceComment(admin, "course-1", "comment-1")).toEqual({ ok: true, adviceId: "advice-1" });
    expect(db.adviceComment.deleteMany).toHaveBeenCalledWith({ where: { id: "comment-1" } });
    expect(events()).toEqual([expect.objectContaining({ event: "advice_comment_deleted", userId: "admin-1", byAdmin: "true" })]);
  });
  it("treats an unknown reply, another course's, or one already gone as not found", async () => {
    db.adviceComment.findFirst.mockResolvedValue(null);
    expect(await deleteAdviceComment(student, "course-1", "comment-x")).toEqual({ ok: false, error: "not_found" });
    db.adviceComment.findFirst.mockResolvedValue({ authorId: "student-1", adviceId: "advice-1" });
    db.adviceComment.deleteMany.mockResolvedValue({ count: 0 });
    expect(await deleteAdviceComment(student, "course-1", "comment-1")).toEqual({ ok: false, error: "not_found" });
  });
});

describe("getAdviceComments (US-41)", () => {
  const row = (id: string, authorId: string | null, name: string | null, post: { authorId: string | null; isAnonymous: boolean }, adviceId = "a1") =>
    ({ id, adviceId, authorId, body: `Body ${id}`, createdAt: new Date("2026-11-15T10:00:00Z"), author: name ? { name } : null, advice: post });

  it("reads visible advice of the course only, oldest first, and never returns an author ID", async () => {
    db.adviceComment.findMany.mockResolvedValue([
      row("c1", "student-2", "Rana", { authorId: "author-9", isAnonymous: true }),
      row("c2", "author-9", "Secret Author", { authorId: "author-9", isAnonymous: true }),
      row("c3", "student-1", "Me", { authorId: "author-9", isAnonymous: true }),
    ]);
    const threads = await getAdviceComments("course-1", ["a1", "a2"], student);
    expect(db.adviceComment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { adviceId: { in: ["a1", "a2"] }, advice: { courseId: "course-1", status: "VISIBLE" } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }));
    expect(threads.get("a2")).toEqual([]);
    expect(threads.get("a1")!.map(comment => [comment.id, comment.authorLabel, comment.byPostAuthor, comment.isMine, comment.canDelete])).toEqual([
      ["c1", "Rana", false, false, false], ["c2", "Anonymous student (author)", true, false, false], ["c3", "Me", false, true, true],
    ]);
    const json = JSON.stringify([...threads]);
    for (const secret of ["author-9", "student-2", "Secret Author"]) expect(json).not.toContain(secret);
  });
  it("lets an admin delete every reply, and a visitor none", async () => {
    db.adviceComment.findMany.mockResolvedValue([row("c1", "student-2", "Rana", { authorId: "x", isAnonymous: false })]);
    expect((await getAdviceComments("course-1", ["a1"], admin)).get("a1")![0].canDelete).toBe(true);
    expect((await getAdviceComments("course-1", ["a1"], null)).get("a1")![0]).toMatchObject({ canDelete: false, isMine: false });
  });
  it("skips the read for an empty page, and logs and rethrows a failed read", async () => {
    expect((await getAdviceComments("course-1", [], student)).size).toBe(0);
    expect(db.adviceComment.findMany).not.toHaveBeenCalled();
    db.adviceComment.findMany.mockRejectedValue(new RangeError("x"));
    await expect(getAdviceComments("course-1", ["a1"], student)).rejects.toThrow(RangeError);
    expect(events()).toEqual([expect.objectContaining({ event: "advice_comment_retrieval_failed", userId: "student-1", errorType: "RangeError" })]);
  });
});
