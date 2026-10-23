import { beforeEach, describe, expect, it, vi } from "vitest";

// The checks done before the database is touched, the logging, and the actions' redirects. The corrections themselves run
// against a real database in tests/integration/question-corrections.test.ts.

const { transaction, rebuild, log, requireAdmin, redirect } = vi.hoisted(() => ({
  transaction: vi.fn(), rebuild: vi.fn(), log: vi.fn(), requireAdmin: vi.fn(),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); }),
}));
vi.mock("@/lib/db", () => ({ db: { $transaction: transaction } }));
vi.mock("@/lib/question-bank", () => ({ courseExams: (courseId: string) => ({ courseId }), rebuildQuestionBank: rebuild }));
vi.mock("@/lib/logger", () => ({ logError: log }));
vi.mock("@/lib/auth", () => ({ requireAdmin }));
vi.mock("next/navigation", () => ({ redirect }));
import { correctQuestion } from "@/lib/question-corrections";
import { cleanCorrectedText, correctionMessage, savedMessage } from "@/lib/question-correction-rules";
import { editQuestionTextAction, moveQuestionAction, resetQuestionGroupAction, splitQuestionAction } from "@/lib/question-correction-actions";
import { resetRateLimits } from "@/lib/rate-limit";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

beforeEach(() => {
  resetRateLimits();
  delete process.env.CORRECTION_RATE_LIMIT_PER_MINUTE;
  for (const mock of [transaction, rebuild, log, requireAdmin, redirect]) mock.mockClear();
  transaction.mockReset().mockResolvedValue(undefined);
  rebuild.mockReset().mockResolvedValue({ ok: true });
  requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", role: "ADMIN" });
});

describe("correctQuestion", () => {
  it.each([["", "text_required"], ["  \n ", "text_required"], [String.fromCodePoint(0x200b, 0xfeff), "text_required"], ["x".repeat(2001), "text_too_long"]])(
    "refuses the text %j before touching the database", async (text, error) => {
      expect(await correctQuestion("admin-1", "course-a", { kind: "edit", questionId: "q-1", text, previousText: "old" })).toEqual({ ok: false, error });
      expect(transaction).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("question_correction_refused", expect.objectContaining({ reason: error, kind: "edit", userId: "admin-1" }));
    });

  it("saves, regroups, and logs who corrected what without the text", async () => {
    expect(await correctQuestion("admin-1", "course-a", { kind: "edit", questionId: "q-1", text: "Secret wording", previousText: "old" })).toEqual({ ok: true, regrouped: true });
    expect(rebuild).toHaveBeenCalledWith("course-a");
    expect(log).toHaveBeenCalledWith("question_corrected", { courseId: "course-a", questionId: "q-1", kind: "edit", userId: "admin-1", regrouped: "true" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("Secret wording");
  });

  it("reports a failed regroup without undoing the correction", async () => {
    rebuild.mockResolvedValue({ ok: false, error: "unexpected" });
    expect(await correctQuestion("admin-1", "course-a", { kind: "split", questionId: "q-1" })).toEqual({ ok: true, regrouped: false });
  });

  it("turns a database failure into a general error and logs it", async () => {
    transaction.mockRejectedValue(Object.assign(new Error("down"), { name: "PrismaClientInitializationError" }));
    expect(await correctQuestion("admin-1", "course-a", { kind: "split", questionId: "q-1" })).toEqual({ ok: false, error: "unexpected" });
    expect(rebuild).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("question_correction_failed", expect.objectContaining({ errorType: "PrismaClientInitializationError" }));
  });

  it("limits each admin separately", async () => {
    process.env.CORRECTION_RATE_LIMIT_PER_MINUTE = "1";
    expect((await correctQuestion("admin-1", "course-a", { kind: "split", questionId: "q-1" })).ok).toBe(true);
    expect(await correctQuestion("admin-1", "course-a", { kind: "split", questionId: "q-2" })).toEqual({ ok: false, error: "rate_limited" });
    expect((await correctQuestion("admin-2", "course-a", { kind: "split", questionId: "q-2" })).ok).toBe(true);
    expect(log).toHaveBeenCalledWith("question_correction_rate_limited", expect.objectContaining({ userId: "admin-1" }));
  });
});

describe("question correction rules", () => {
  it("trims the text and stores plain line breaks", () => expect(cleanCorrectedText("  a\r\nb\rc  ")).toBe("a\nb\nc"));
  it("shows only known messages", () => {
    expect(correctionMessage("same_group")).toBe("The question is already in that group.");
    expect(correctionMessage("constructor")).toBe("Something went wrong. Please try again.");
    expect(savedMessage("toString")).toBeNull();
  });
});

describe("question correction actions", () => {
  const ids = { courseId: "course-a", questionId: "q-1" };
  const route = "/admin/questions/course-a/q-1";

  it.each([
    [editQuestionTextAction, { ...ids, text: "New", previousText: "Old" }, "saved=edit"],
    [moveQuestionAction, { ...ids, groupId: "g-2" }, "saved=move"],
    [splitQuestionAction, ids, "saved=split"],
    [resetQuestionGroupAction, ids, "saved=reset"],
  ] as const)("checks the admin, corrects, and returns to the question (%#)", async (action, fields, outcome) => {
    await expect(action(form(fields))).rejects.toThrow(`NEXT_REDIRECT ${route}?${outcome}`);
    expect(requireAdmin).toHaveBeenCalledWith(route);
  });

  it("puts the error in the URL but never the text", async () => {
    await expect(editQuestionTextAction(form({ ...ids, text: " ", previousText: "Secret old text" }))).rejects.toThrow(`NEXT_REDIRECT ${route}?error=text_required`);
    expect(JSON.stringify(redirect.mock.calls)).not.toContain("Secret");
  });

  it("says when the regroup failed", async () => {
    rebuild.mockResolvedValue({ ok: false });
    await expect(splitQuestionAction(form(ids))).rejects.toThrow(`NEXT_REDIRECT ${route}?saved=split&regroup=failed`);
  });

  it("does nothing for a visitor who is not an admin", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    await expect(splitQuestionAction(form(ids))).rejects.toThrow("NEXT_REDIRECT /login");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("encodes hostile IDs in the return URL", async () => {
    await expect(splitQuestionAction(form({ courseId: "../x?y", questionId: "a/b" }))).rejects.toThrow("NEXT_REDIRECT /admin/questions/..%2Fx%3Fy/a%2Fb?");
  });
});
