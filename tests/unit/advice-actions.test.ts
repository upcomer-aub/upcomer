import { beforeEach, describe, expect, it, vi } from "vitest";

// The edit and delete actions of one's own advice (US-36): who may call them, and where each outcome lands.

const { requireUser, editAdvice, deleteAdvice, redirect } = vi.hoisted(() => ({
  requireUser: vi.fn(), editAdvice: vi.fn(), deleteAdvice: vi.fn(),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); }),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/auth", () => ({ requireUser }));
vi.mock("@/lib/advice-changes", () => ({ editAdvice, deleteAdvice }));
import { deleteAdviceAction, editAdviceAction } from "@/lib/advice-actions";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};
const edit = (extra: Record<string, string> = {}) => form({ courseId: "course-a", adviceId: "advice-1", body: "New advice.", resourceUrl: "", ...extra });

beforeEach(() => {
  requireUser.mockReset().mockResolvedValue({ id: "student-1", role: "STUDENT" });
  editAdvice.mockReset().mockResolvedValue({ ok: true, courseId: "course-a", changed: true });
  deleteAdvice.mockReset().mockResolvedValue({ ok: true, courseId: "course-a", changed: true });
  redirect.mockClear();
});

describe("editAdviceAction", () => {
  it("saves for the logged-in student and returns to the advice in the feed", async () => {
    await expect(editAdviceAction(edit())).rejects.toThrow("NEXT_REDIRECT /courses/course-a/advice?edited=1#advice-advice-1");
    expect(requireUser).toHaveBeenCalledWith("/courses/course-a/advice/advice-1/edit");
    expect(editAdvice).toHaveBeenCalledWith("student-1", { adviceId: "advice-1", body: "New advice.", resourceUrl: "" });
  });
  it("returns to the feed page the author came from, and says when nothing changed", async () => {
    editAdvice.mockResolvedValue({ ok: true, courseId: "course-a", changed: false });
    await expect(editAdviceAction(edit({ page: "3" }))).rejects.toThrow("NEXT_REDIRECT /courses/course-a/advice?page=3&unchanged=1#advice-advice-1");
  });
  it("goes to the stored advice's course, not the form's", async () => {
    editAdvice.mockResolvedValue({ ok: true, courseId: "course-b", changed: true });
    await expect(editAdviceAction(edit())).rejects.toThrow("NEXT_REDIRECT /courses/course-b/advice?edited=1#advice-advice-1");
  });
  it("sends a refused draft back to the edit page with the reason, never the text", async () => {
    editAdvice.mockResolvedValue({ ok: false, error: "too_long" });
    await expect(editAdviceAction(edit({ page: "2" }))).rejects.toThrow("NEXT_REDIRECT /courses/course-a/advice/advice-1/edit?page=2&error=too_long");
    expect(String(redirect.mock.calls[0][0])).not.toContain("New advice");
  });
  it("sends advice that is not the author's back to the feed", async () => {
    editAdvice.mockResolvedValue({ ok: false, error: "not_found" });
    await expect(editAdviceAction(edit())).rejects.toThrow("NEXT_REDIRECT /courses/course-a/advice?change_error=not_found");
  });
  it("changes nothing for a visitor", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    await expect(editAdviceAction(edit())).rejects.toThrow("NEXT_REDIRECT /login");
    expect(editAdvice).not.toHaveBeenCalled();
  });
  it("keeps a hand-made course or advice ID inside its own path segment", async () => {
    editAdvice.mockResolvedValue({ ok: false, error: "empty" });
    await expect(editAdviceAction(edit({ courseId: "../admin?x=1", adviceId: "a/b" }))).rejects.toThrow("NEXT_REDIRECT /courses/..%2Fadmin%3Fx%3D1/advice/a%2Fb/edit?error=empty");
  });
});

describe("deleteAdviceAction", () => {
  it("deletes for the logged-in student and says so on the feed page they came from", async () => {
    await expect(deleteAdviceAction(form({ courseId: "course-a", adviceId: "advice-1", page: "2" }))).rejects.toThrow("NEXT_REDIRECT /courses/course-a/advice?page=2&deleted=1");
    expect(deleteAdvice).toHaveBeenCalledWith("student-1", "advice-1");
  });
  it("shows a refusal on the feed", async () => {
    deleteAdvice.mockResolvedValue({ ok: false, error: "rate_limited" });
    await expect(deleteAdviceAction(form({ courseId: "course-a", adviceId: "advice-1" }))).rejects.toThrow("NEXT_REDIRECT /courses/course-a/advice?change_error=rate_limited");
  });
  it("deletes nothing for a visitor", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    await expect(deleteAdviceAction(form({ courseId: "course-a", adviceId: "advice-1" }))).rejects.toThrow("NEXT_REDIRECT /login");
    expect(deleteAdvice).not.toHaveBeenCalled();
  });
});
