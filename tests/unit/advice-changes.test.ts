import { beforeEach, describe, expect, it, vi } from "vitest";

// Editing and deleting one's own advice (US-36) with the database mocked: the rules for a draft, the service (only the
// author, only advice still shown, the cache invalidated, nothing typed logged), and the actions' redirects.

const { advice, invalidateCourseAdvice } = vi.hoisted(() => ({
  advice: { findFirst: vi.fn(), updateMany: vi.fn() }, invalidateCourseAdvice: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { advice } }));
vi.mock("@/lib/advice", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/advice")>(), invalidateCourseAdvice }));
import { adviceChangeLimit, deleteAdvice, editAdvice, getOwnAdvice } from "@/lib/advice-changes";
import { adviceChangeMessage, checkAdviceDraft, MAX_ADVICE_LENGTH, MAX_RESOURCE_URL_LENGTH } from "@/lib/advice-rules";
import { resetRateLimits } from "@/lib/rate-limit";

let errors: ReturnType<typeof vi.spyOn>;
const logged = () => errors.mock.calls.map(call => JSON.parse(String(call[0])));
const ownWhere = { id: "advice-1", authorId: "student-1", status: "VISIBLE" };

beforeEach(() => {
  resetRateLimits();
  delete process.env.ADVICE_CHANGE_RATE_LIMIT_PER_MINUTE;
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  advice.findFirst.mockReset().mockResolvedValue({ courseId: "course-a", body: "Old advice.", resourceUrl: null });
  advice.updateMany.mockReset().mockResolvedValue({ count: 1 });
  invalidateCourseAdvice.mockReset();
});

describe("checkAdviceDraft", () => {
  it("keeps the text's line breaks, trims it, and turns Windows line breaks into one", () => {
    expect(checkAdviceDraft({ body: "  First line\r\nSecond line  " })).toEqual({ ok: true, draft: { body: "First line\nSecond line", resourceUrl: null } });
  });
  it("refuses empty text, including text made only of invisible characters", () => {
    for (const body of ["", "   ", "​​", "\n\t"]) expect(checkAdviceDraft({ body })).toEqual({ ok: false, error: "empty" });
  });
  it(`allows ${MAX_ADVICE_LENGTH} characters, not one more`, () => {
    expect(checkAdviceDraft({ body: "a".repeat(MAX_ADVICE_LENGTH) }).ok).toBe(true);
    expect(checkAdviceDraft({ body: "a".repeat(MAX_ADVICE_LENGTH + 1) })).toEqual({ ok: false, error: "too_long" });
    // A Windows line break counts once, as the browser counts it.
    expect(checkAdviceDraft({ body: `${"a".repeat(MAX_ADVICE_LENGTH - 2)}\r\nb` }).ok).toBe(true);
  });
  it("removes the link when it is left empty, and keeps a safe https link normalized", () => {
    expect(checkAdviceDraft({ body: "x", resourceUrl: "  " })).toEqual({ ok: true, draft: { body: "x", resourceUrl: null } });
    expect(checkAdviceDraft({ body: "x", resourceUrl: " https://Example.com/notes " })).toEqual({ ok: true, draft: { body: "x", resourceUrl: "https://example.com/notes" } });
  });
  it("refuses any other link", () => {
    for (const resourceUrl of ["javascript:alert(1)", "http://example.com", "data:text/html,x", "/files/1", "https://user:pw@example.com", "example.com",
      `https://example.com/${"a".repeat(MAX_RESOURCE_URL_LENGTH)}`]) {
      expect(checkAdviceDraft({ body: "x", resourceUrl })).toEqual({ ok: false, error: "invalid_resource" });
    }
  });
  it("gives each refusal its message, and the general one for anything else", () => {
    expect(adviceChangeMessage("rate_limited")).toBe("Too many changes in a minute. Wait a moment and try again.");
    expect(adviceChangeMessage("<b>x</b>")).toBe("Your change could not be saved. Please try again.");
    expect(adviceChangeMessage("toString")).toBe("Your change could not be saved. Please try again.");
  });
});

describe("getOwnAdvice", () => {
  it("finds the advice only by its ID, its author, and the course, among the advice still shown", async () => {
    advice.findFirst.mockResolvedValue(null);
    expect(await getOwnAdvice("student-1", "course-a", "advice-1")).toBeNull();
    expect(advice.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "advice-1", authorId: "student-1", courseId: "course-a", status: "VISIBLE" }),
    }));
  });
  it("hands the page the advice as students see it, without any author ID", async () => {
    advice.findFirst.mockResolvedValue({
      id: "advice-1", authorId: "student-1", courseId: "course-a", body: "Mine.", anonymous: true, scope: "COURSE", topic: null, resourceUrl: null,
      editedAt: null, createdAt: new Date(), author: { name: "Lea Tass" }, file: null, term: null, questionGroup: null,
    });
    const own = await getOwnAdvice("student-1", "course-a", "advice-1");
    expect(own).toMatchObject({ id: "advice-1", courseId: "course-a", body: "Mine.", author: "Anonymous student" });
    expect(JSON.stringify(own)).not.toMatch(/student-1|Lea Tass/);
  });
  it("asks nothing for an empty ID", async () => {
    expect(await getOwnAdvice("student-1", "course-a", "")).toBeNull();
    expect(advice.findFirst).not.toHaveBeenCalled();
  });
});

describe("editAdvice", () => {
  it("saves the author's new text and link, marks it edited, invalidates the course's feed, and logs IDs only", async () => {
    const result = await editAdvice("student-1", { adviceId: "advice-1", body: "New advice.", resourceUrl: "https://example.com/n" });
    expect(result).toEqual({ ok: true, courseId: "course-a", changed: true });
    expect(advice.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: ownWhere }));
    expect(advice.updateMany).toHaveBeenCalledWith({ where: ownWhere, data: { body: "New advice.", resourceUrl: "https://example.com/n", editedAt: expect.any(Date) } });
    expect(invalidateCourseAdvice).toHaveBeenCalledWith("course-a");
    expect(logged()).toEqual([expect.objectContaining({ event: "advice_edited", level: "info", adviceId: "advice-1", courseId: "course-a", userId: "student-1" })]);
    expect(JSON.stringify(logged())).not.toMatch(/New advice|Old advice|example\.com/);
  });
  it("writes nothing when nothing changed, and does not mark the advice edited", async () => {
    advice.findFirst.mockResolvedValue({ courseId: "course-a", body: "Same.", resourceUrl: "https://example.com/n" });
    expect(await editAdvice("student-1", { adviceId: "advice-1", body: " Same. ", resourceUrl: "https://example.com/n" })).toEqual({ ok: true, courseId: "course-a", changed: false });
    expect(advice.updateMany).not.toHaveBeenCalled();
    expect(invalidateCourseAdvice).not.toHaveBeenCalled();
  });
  it("refuses another student's advice, or advice no longer shown, as not found, and changes nothing", async () => {
    advice.findFirst.mockResolvedValue(null);
    expect(await editAdvice("student-2", { adviceId: "advice-1", body: "Hijack." })).toEqual({ ok: false, error: "not_found" });
    expect(advice.updateMany).not.toHaveBeenCalled();
    expect(invalidateCourseAdvice).not.toHaveBeenCalled();
    expect(logged()).toEqual([expect.objectContaining({ event: "advice_change_refused", level: "warn", operation: "edit", reason: "not_found", userId: "student-2" })]);
  });
  it("does not undo an admin removal or a delete that happened between the read and the write", async () => {
    advice.updateMany.mockResolvedValue({ count: 0 });
    expect(await editAdvice("student-1", { adviceId: "advice-1", body: "Back again." })).toEqual({ ok: false, error: "not_found" });
    expect(invalidateCourseAdvice).not.toHaveBeenCalled();
  });
  it("refuses an invalid draft before reading the database", async () => {
    expect(await editAdvice("student-1", { adviceId: "advice-1", body: " " })).toEqual({ ok: false, error: "empty" });
    expect(await editAdvice("student-1", { adviceId: "advice-1", body: "x", resourceUrl: "javascript:alert(1)" })).toEqual({ ok: false, error: "invalid_resource" });
    expect(await editAdvice("student-1", { adviceId: " ", body: "x" })).toEqual({ ok: false, error: "not_found" });
    expect(advice.findFirst).not.toHaveBeenCalled();
    expect(JSON.stringify(logged())).not.toContain("javascript");
  });
  it("logs a failed write with the error type only, and says it could not be saved", async () => {
    advice.updateMany.mockRejectedValue(Object.assign(new Error("connection to 10.0.0.1 lost"), { name: "PrismaClientKnownRequestError" }));
    expect(await editAdvice("student-1", { adviceId: "advice-1", body: "New advice." })).toEqual({ ok: false, error: "unexpected" });
    expect(logged()).toEqual([expect.objectContaining({ event: "advice_change_failed", level: "error", operation: "edit", errorType: "PrismaClientKnownRequestError" })]);
    expect(JSON.stringify(logged())).not.toContain("10.0.0.1");
  });
});

describe("deleteAdvice", () => {
  it("marks the author's advice removed by them, invalidates the course's feed, and logs IDs only", async () => {
    expect(await deleteAdvice("student-1", "advice-1")).toEqual({ ok: true, courseId: "course-a", changed: true });
    expect(advice.updateMany).toHaveBeenCalledWith({ where: ownWhere, data: { status: "REMOVED", removedAt: expect.any(Date), removedById: "student-1" } });
    expect(invalidateCourseAdvice).toHaveBeenCalledWith("course-a");
    expect(logged()).toEqual([expect.objectContaining({ event: "advice_deleted", level: "info", adviceId: "advice-1", courseId: "course-a", userId: "student-1" })]);
  });
  it("refuses another student's advice, and advice already removed, as not found", async () => {
    advice.findFirst.mockResolvedValue(null);
    expect(await deleteAdvice("student-2", "advice-1")).toEqual({ ok: false, error: "not_found" });
    advice.findFirst.mockResolvedValue({ courseId: "course-a" });
    advice.updateMany.mockResolvedValue({ count: 0 });
    expect(await deleteAdvice("student-1", "advice-1")).toEqual({ ok: false, error: "not_found" });
    expect(invalidateCourseAdvice).not.toHaveBeenCalled();
  });
  it("logs a failed delete with the error type only", async () => {
    advice.findFirst.mockRejectedValue(new TypeError("boom"));
    expect(await deleteAdvice("student-1", "advice-1")).toEqual({ ok: false, error: "unexpected" });
    expect(logged()).toEqual([expect.objectContaining({ event: "advice_change_failed", operation: "delete", errorType: "TypeError" })]);
  });
});

describe("the change limit (DoS protection)", () => {
  it("allows 20 edits and deletes a minute per student by default, then refuses without reading the database", async () => {
    expect(adviceChangeLimit()).toBe(20);
    for (let change = 0; change < 10; change++) {
      await editAdvice("student-1", { adviceId: "advice-1", body: `Edit ${change}` });
      await deleteAdvice("student-1", "advice-1");
    }
    advice.findFirst.mockClear();
    expect(await editAdvice("student-1", { adviceId: "advice-1", body: "One more." })).toEqual({ ok: false, error: "rate_limited" });
    expect(await deleteAdvice("student-1", "advice-1")).toEqual({ ok: false, error: "rate_limited" });
    expect(advice.findFirst).not.toHaveBeenCalled();
    expect(logged().filter(line => line.event === "advice_change_rate_limited")).toEqual([
      expect.objectContaining({ level: "warn", userId: "student-1", operation: "edit", retryAfterSeconds: expect.any(String) }),
      expect.objectContaining({ operation: "delete" }),
    ]);
  });
  it("counts each student apart", async () => {
    process.env.ADVICE_CHANGE_RATE_LIMIT_PER_MINUTE = "1";
    await deleteAdvice("student-1", "advice-1");
    expect(await deleteAdvice("student-1", "advice-1")).toEqual({ ok: false, error: "rate_limited" });
    expect((await deleteAdvice("student-2", "advice-1")).ok).toBe(true);
  });
});
