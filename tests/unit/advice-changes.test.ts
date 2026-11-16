import { beforeEach, describe, expect, it, vi } from "vitest";

// Editing and deleting one's own advice (US-36) with the database mocked: the rules for a draft, the service (only the
// author, only advice still shown, the cache invalidated, nothing typed logged), and the actions' redirects.

const { advice, invalidateCourseAdvice, requireUser, redirect } = vi.hoisted(() => ({
  advice: { findFirst: vi.fn(), updateMany: vi.fn() }, invalidateCourseAdvice: vi.fn(),
  requireUser: vi.fn(), redirect: vi.fn((url: string) => { throw new Error(`REDIRECT ${url}`); }),
}));
vi.mock("@/lib/db", () => ({ db: { advice } }));
vi.mock("@/lib/advice", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/advice")>(), invalidateCourseAdvice }));
vi.mock("@/lib/auth", () => ({ requireUser }));
vi.mock("next/navigation", () => ({ redirect }));
import { deleteAdviceAction, editAdviceAction } from "@/lib/advice-change-actions";
import { adviceChangeMessage, checkAdviceDraft, deleteAdvice, editAdvice, getOwnAdvice, type AdviceEditInput } from "@/lib/advice-changes";
import { ADVICE_BODY_MAX_LENGTH, ADVICE_TITLE_MAX_LENGTH } from "@/lib/advice-rules";
import { resetRateLimits } from "@/lib/rate-limit";

let errors: ReturnType<typeof vi.spyOn>;
const logged = () => errors.mock.calls.map(call => JSON.parse(String(call[0])));
const ownWhere = { id: "advice-1", authorId: "student-1", status: "VISIBLE" };
const draft = (over: Partial<Omit<AdviceEditInput, "adviceId">> = {}) => ({ title: "Start early", body: "Labs take long.", resourceUrl: "", resourceTitle: "", ...over });
const current = { courseId: "course-a", title: "Old title", body: "Old advice.", resourceUrl: null, resourceTitle: null };
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

beforeEach(() => {
  resetRateLimits();
  delete process.env.ADVICE_CHANGE_RATE_LIMIT_PER_MINUTE;
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  advice.findFirst.mockReset().mockResolvedValue(current);
  advice.updateMany.mockReset().mockResolvedValue({ count: 1 });
  invalidateCourseAdvice.mockReset();
  requireUser.mockReset().mockResolvedValue({ id: "student-1" });
  redirect.mockClear();
});

describe("checkAdviceDraft (the same rules as publishing)", () => {
  it("collapses the title's spacing, keeps the text's line breaks, and turns Windows line breaks into one", () => {
    expect(checkAdviceDraft(draft({ title: "  Start   early ", body: "  First line\r\nSecond line  " })))
      .toEqual({ ok: true, draft: { title: "Start early", body: "First line\nSecond line", resourceUrl: null, resourceTitle: null } });
  });
  it("refuses an empty title or text, including invisible characters only", () => {
    for (const title of ["", "   ", "​​"]) expect(checkAdviceDraft(draft({ title }))).toEqual({ ok: false, error: "title_required" });
    for (const body of ["", "   ", "​​", "\n\t"]) expect(checkAdviceDraft(draft({ body }))).toEqual({ ok: false, error: "body_required" });
  });
  it("allows the longest title and text, not one character more", () => {
    expect(checkAdviceDraft(draft({ title: "a".repeat(ADVICE_TITLE_MAX_LENGTH), body: "b".repeat(ADVICE_BODY_MAX_LENGTH) })).ok).toBe(true);
    expect(checkAdviceDraft(draft({ title: "a".repeat(ADVICE_TITLE_MAX_LENGTH + 1) }))).toEqual({ ok: false, error: "title_too_long" });
    expect(checkAdviceDraft(draft({ body: "b".repeat(ADVICE_BODY_MAX_LENGTH + 1) }))).toEqual({ ok: false, error: "body_too_long" });
    // A Windows line break counts once, as the browser counts it.
    expect(checkAdviceDraft(draft({ body: `${"a".repeat(ADVICE_BODY_MAX_LENGTH - 2)}\r\nb` })).ok).toBe(true);
  });
  it("removes the link and its name when the link is left empty, and keeps a safe https link normalized", () => {
    expect(checkAdviceDraft(draft({ resourceUrl: "  ", resourceTitle: "Notes" }))).toMatchObject({ ok: true, draft: { resourceUrl: null, resourceTitle: null } });
    expect(checkAdviceDraft(draft({ resourceUrl: " https://Example.com/notes ", resourceTitle: " My  notes " })))
      .toMatchObject({ ok: true, draft: { resourceUrl: "https://example.com/notes", resourceTitle: "My notes" } });
  });
  it("refuses any other link", () => {
    for (const resourceUrl of ["javascript:alert(1)", "http://example.com", "data:text/html,x", "/files/1", "https://user:pw@example.com", "example.com"]) {
      expect(checkAdviceDraft(draft({ resourceUrl }))).toEqual({ ok: false, error: "link_invalid" });
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
    advice.findFirst.mockResolvedValue({
      id: "advice-1", courseId: "course-a", title: "T", body: "B", resourceUrl: null, resourceTitle: null, isAnonymous: true, scopeKind: "EXAM", scopeLabel: "Final 2024",
    });
    expect(await getOwnAdvice("student-1", "course-a", "advice-1")).toMatchObject({ id: "advice-1", about: "An exam paper: Final 2024", isAnonymous: true });
    expect(advice.findFirst.mock.calls[0][0].where).toMatchObject({ courseId: "course-a", status: "VISIBLE", id: "advice-1", authorId: "student-1" });
  });
  it("is null for anyone else, and without asking the database for an empty ID", async () => {
    advice.findFirst.mockResolvedValue(null);
    expect(await getOwnAdvice("student-2", "course-a", "advice-1")).toBeNull();
    advice.findFirst.mockClear();
    expect(await getOwnAdvice("student-1", "course-a", "")).toBeNull();
    expect(advice.findFirst).not.toHaveBeenCalled();
  });
});

describe("editAdvice", () => {
  it("saves the author's change, matched by author and visible status, marks it edited, and invalidates the feed", async () => {
    expect(await editAdvice("student-1", { adviceId: "advice-1", ...draft({ resourceUrl: "https://example.com/x", resourceTitle: "X" }) }))
      .toEqual({ ok: true, courseId: "course-a", changed: true });
    const call = advice.updateMany.mock.calls[0][0];
    expect(call.where).toEqual(ownWhere);
    expect(call.data).toMatchObject({ title: "Start early", body: "Labs take long.", resourceUrl: "https://example.com/x", resourceTitle: "X" });
    expect(call.data.editedAt).toBeInstanceOf(Date);
    expect(call.data).not.toHaveProperty("isAnonymous");
    expect(call.data).not.toHaveProperty("scopeKind");
    expect(invalidateCourseAdvice).toHaveBeenCalledWith("course-a");
  });
  it("writes nothing for an unchanged draft and does not mark it edited", async () => {
    advice.findFirst.mockResolvedValue({ courseId: "course-a", title: "Start early", body: "Labs take long.", resourceUrl: null, resourceTitle: null });
    expect(await editAdvice("student-1", { adviceId: "advice-1", ...draft() })).toEqual({ ok: true, courseId: "course-a", changed: false });
    expect(advice.updateMany).not.toHaveBeenCalled();
    expect(invalidateCourseAdvice).not.toHaveBeenCalled();
  });
  it("is not found for another student's advice, and writes nothing", async () => {
    advice.findFirst.mockResolvedValue(null);
    expect(await editAdvice("student-2", { adviceId: "advice-1", ...draft() })).toEqual({ ok: false, error: "not_found" });
    expect(advice.findFirst.mock.calls[0][0].where).toEqual({ ...ownWhere, authorId: "student-2" });
    expect(advice.updateMany).not.toHaveBeenCalled();
  });
  it("is not found when the advice was removed between the read and the write", async () => {
    advice.updateMany.mockResolvedValue({ count: 0 });
    expect(await editAdvice("student-1", { adviceId: "advice-1", ...draft() })).toEqual({ ok: false, error: "not_found" });
    expect(invalidateCourseAdvice).not.toHaveBeenCalled();
  });
  it("refuses an invalid draft before reading the database", async () => {
    expect(await editAdvice("student-1", { adviceId: "advice-1", ...draft({ body: " " }) })).toEqual({ ok: false, error: "body_required" });
    expect(advice.findFirst).not.toHaveBeenCalled();
  });
  it("never logs the advice text, title, or link", async () => {
    await editAdvice("student-1", { adviceId: "advice-1", ...draft({ title: "Secret title", body: "Secret text", resourceUrl: "https://secret.example.com" }) });
    await editAdvice("student-1", { adviceId: "advice-1", ...draft({ body: "x".repeat(ADVICE_BODY_MAX_LENGTH + 1) }) });
    expect(JSON.stringify(logged())).not.toMatch(/Secret|secret\.example/);
  });
  it("stops a student over the change limit, before reading the database", async () => {
    process.env.ADVICE_CHANGE_RATE_LIMIT_PER_MINUTE = "2";
    await editAdvice("student-1", { adviceId: "advice-1", ...draft() });
    await deleteAdvice("student-1", "advice-1");
    advice.findFirst.mockClear();
    expect(await editAdvice("student-1", { adviceId: "advice-1", ...draft() })).toEqual({ ok: false, error: "rate_limited" });
    expect(advice.findFirst).not.toHaveBeenCalled();
    // Another student is not affected.
    expect((await editAdvice("student-2", { adviceId: "advice-1", ...draft() })).ok).toBe(true);
  });
  it("logs a database failure with its error type only", async () => {
    advice.findFirst.mockRejectedValue(new TypeError("boom Labs take long."));
    expect(await editAdvice("student-1", { adviceId: "advice-1", ...draft() })).toEqual({ ok: false, error: "unexpected" });
    expect(logged().find(entry => entry.event === "advice_change_failed")).toMatchObject({ errorType: "TypeError", operation: "edit" });
    expect(JSON.stringify(logged())).not.toContain("boom");
  });
});

describe("deleteAdvice", () => {
  it("marks the author's advice removed by them and invalidates the feed", async () => {
    expect(await deleteAdvice("student-1", "advice-1")).toEqual({ ok: true, courseId: "course-a", changed: true });
    const call = advice.updateMany.mock.calls[0][0];
    expect(call.where).toEqual(ownWhere);
    expect(call.data).toMatchObject({ status: "REMOVED", removedById: "student-1" });
    expect(invalidateCourseAdvice).toHaveBeenCalledWith("course-a");
  });
  it("is not found for another student's advice, or advice already removed", async () => {
    advice.findFirst.mockResolvedValue(null);
    expect(await deleteAdvice("student-2", "advice-1")).toEqual({ ok: false, error: "not_found" });
    expect(await deleteAdvice("student-1", "  ")).toEqual({ ok: false, error: "not_found" });
    expect(advice.updateMany).not.toHaveBeenCalled();
  });
});

describe("actions", () => {
  it("edit: uses the session user, never a user ID from the form, and goes back to the feed page with the outcome", async () => {
    await expect(editAdviceAction(form({ courseId: "course-a", adviceId: "advice-1", userId: "student-9", page: "3", ...draft() })))
      .rejects.toThrow("REDIRECT /courses/course-a/advice?page=3&edited=1");
    expect(requireUser).toHaveBeenCalledWith("/courses/course-a/advice/advice-1/edit");
    expect(advice.updateMany.mock.calls[0][0].where.authorId).toBe("student-1");
  });
  it("edit: an invalid draft goes back to the edit page with the reason, not the text", async () => {
    await expect(editAdviceAction(form({ courseId: "course-a", adviceId: "advice-1", ...draft({ body: " " }) })))
      .rejects.toThrow("REDIRECT /courses/course-a/advice/advice-1/edit?error=body_required");
  });
  it("edit: someone else's advice goes back to the feed with not_found", async () => {
    advice.findFirst.mockResolvedValue(null);
    await expect(editAdviceAction(form({ courseId: "course-a", adviceId: "advice-1", ...draft() })))
      .rejects.toThrow("REDIRECT /courses/course-a/advice?change_error=not_found");
  });
  it("edit: the stored advice's course decides where it lands, not the form's", async () => {
    await expect(editAdviceAction(form({ courseId: "course-b", adviceId: "advice-1", ...draft() })))
      .rejects.toThrow("REDIRECT /courses/course-a/advice?edited=1");
  });
  it("delete: goes back to the feed with deleted=1, or the reason", async () => {
    await expect(deleteAdviceAction(form({ courseId: "course-a", adviceId: "advice-1" }))).rejects.toThrow("REDIRECT /courses/course-a/advice?deleted=1");
    advice.findFirst.mockResolvedValue(null);
    await expect(deleteAdviceAction(form({ courseId: "course-a", adviceId: "advice-1" }))).rejects.toThrow("REDIRECT /courses/course-a/advice?change_error=not_found");
  });
});
