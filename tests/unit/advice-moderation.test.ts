import { beforeEach, describe, expect, it, vi } from "vitest";

// Moderation of reported advice (US-77) with the database mocked: the queue (one item per advice, as students see it,
// without reporters), the decisions (remove or keep, open reports only, the feed cache invalidated), the limit, logs
// without text, and the action (admins only).

const { tx, adviceReport, advice, transaction, invalidateCourseAdvice, requireAdmin, redirect } = vi.hoisted(() => ({
  tx: { $executeRaw: vi.fn(), advice: { findUnique: vi.fn(), update: vi.fn() }, adviceReport: { updateMany: vi.fn() } },
  adviceReport: { findMany: vi.fn() },
  advice: { findMany: vi.fn() },
  transaction: vi.fn(),
  invalidateCourseAdvice: vi.fn(),
  requireAdmin: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`NEXT_REDIRECT ${location}`); }),
}));
vi.mock("@/lib/db", () => ({ db: { $transaction: transaction, adviceReport, advice } }));
vi.mock("@/lib/advice", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/advice")>(), invalidateCourseAdvice }));
vi.mock("@/lib/auth", () => ({ requireAdmin }));
vi.mock("next/navigation", () => ({ redirect }));
import { moderateAdviceAction } from "@/lib/advice-moderation-actions";
import { ADVICE_QUEUE_PAGE_SIZE, adviceModerationLimit, getAdviceReportQueue, moderateAdvice } from "@/lib/advice-moderation";
import { resetRateLimits } from "@/lib/rate-limit";

let errors: ReturnType<typeof vi.spyOn>;
const logged = () => errors.mock.calls.map(call => JSON.parse(String(call[0])));
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const redirectedTo = async (run: Promise<unknown>) => {
  await expect(run).rejects.toThrow("NEXT_REDIRECT");
  return redirect.mock.calls.at(-1)?.[0];
};
const at = (minute: number) => new Date(Date.UTC(2026, 10, 12, 9, minute));
const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, courseId: "course-a", authorId: "author-1", body: `Body of ${id}.`, anonymous: false, scope: "COURSE", topic: null, resourceUrl: null,
  editedAt: null, createdAt: at(0), status: "VISIBLE", removedById: null, author: { name: "Real Author" }, file: null, term: null,
  questionGroup: null, course: { id: "course-a", code: "EECE350", name: "Computer Networks" }, ...overrides,
});
const report = (id: string, adviceId: string, minute: number, reason = "OFFENSIVE", note: string | null = null) => ({ id, adviceId, reason, note, createdAt: at(minute) });

beforeEach(() => {
  resetRateLimits();
  delete process.env.ADVICE_MODERATION_RATE_LIMIT_PER_MINUTE;
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  transaction.mockReset().mockImplementation((work: (client: typeof tx) => unknown) => work(tx));
  tx.$executeRaw.mockReset().mockResolvedValue(1);
  tx.advice.findUnique.mockReset().mockResolvedValue({ courseId: "course-a", status: "VISIBLE" });
  tx.advice.update.mockReset().mockResolvedValue({});
  tx.adviceReport.updateMany.mockReset().mockResolvedValue({ count: 2 });
  adviceReport.findMany.mockReset().mockResolvedValue([]);
  advice.findMany.mockReset().mockResolvedValue([]);
  invalidateCourseAdvice.mockReset();
  requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", role: "ADMIN" });
  redirect.mockClear();
});

describe("getAdviceReportQueue", () => {
  it("groups the open reports by advice, the advice reported longest ago first, with reason counts and notes", async () => {
    adviceReport.findMany.mockResolvedValue([
      report("r1", "b", 1, "SPAM"), report("r2", "a", 2, "OFFENSIVE", "Insults a TA."), report("r3", "b", 3, "SPAM"), report("r4", "b", 4, "OTHER"),
    ]);
    advice.findMany.mockResolvedValue([row("a"), row("b")]);
    const queue = await getAdviceReportQueue();
    expect(adviceReport.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "OPEN" } }));
    expect(queue).toMatchObject({ total: 2, reportCount: 4, page: 1, totalPages: 1 });
    expect(queue.items.map(item => item.advice.id)).toEqual(["b", "a"]);
    expect(queue.items[0]).toMatchObject({
      shown: true, firstReportedAt: at(1), course: { code: "EECE350" },
      reasons: [{ reason: "SPAM", count: 2 }, { reason: "OTHER", count: 1 }],
    });
    expect(queue.items[1].reports).toEqual([{ id: "r2", reason: "OFFENSIVE", note: "Insults a TA.", createdAt: at(2) }]);
  });
  it("shows an anonymous author as anonymous, never their name or ID, and never who reported", async () => {
    adviceReport.findMany.mockResolvedValue([report("r1", "a", 1)]);
    advice.findMany.mockResolvedValue([row("a", { anonymous: true })]);
    const queue = await getAdviceReportQueue();
    expect(queue.items[0].advice.author).toBe("Anonymous student");
    const json = JSON.stringify(queue);
    expect(json).not.toContain("Real Author");
    expect(json).not.toContain("author-1");
    expect(json).not.toContain("reporter");
  });
  it("marks advice its author already deleted as no longer shown", async () => {
    adviceReport.findMany.mockResolvedValue([report("r1", "a", 1)]);
    advice.findMany.mockResolvedValue([row("a", { status: "REMOVED", removedById: "author-1" })]);
    expect((await getAdviceReportQueue()).items[0].shown).toBe(false);
  });
  it(`shows ${ADVICE_QUEUE_PAGE_SIZE} advice a page and reads only that page's advice; a bad page falls back`, async () => {
    adviceReport.findMany.mockResolvedValue(Array.from({ length: 45 }, (_, index) => report(`r${index}`, `a${index}`, index)));
    advice.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map(id => row(id)));
    const second = await getAdviceReportQueue("2");
    expect(second).toMatchObject({ total: 45, page: 2, totalPages: 3 });
    expect(second.items.map(item => item.advice.id)).toEqual(Array.from({ length: 20 }, (_, index) => `a${index + 20}`));
    expect((await getAdviceReportQueue("99")).page).toBe(3);
    expect((await getAdviceReportQueue("x")).page).toBe(1);
  });
  it("logs a failure by its type only and rethrows it", async () => {
    adviceReport.findMany.mockRejectedValue(new TypeError("db down"));
    await expect(getAdviceReportQueue()).rejects.toThrow("db down");
    expect(logged().at(-1)).toEqual(expect.objectContaining({ event: "advice_report_queue_failed", errorType: "TypeError" }));
  });
});

describe("moderateAdvice", () => {
  it("removes the advice for the admin, resolves its open reports, and clears the course's feed cache", async () => {
    expect(await moderateAdvice("admin-1", { adviceId: "a", decision: "remove" })).toEqual({ ok: true, decision: "remove", closedReports: 2 });
    expect(tx.adviceReport.updateMany).toHaveBeenCalledWith({
      where: { adviceId: "a", status: "OPEN" }, data: { status: "RESOLVED", closedAt: expect.any(Date), closedById: "admin-1" },
    });
    expect(tx.advice.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { status: "REMOVED", removedAt: expect.any(Date), removedById: "admin-1" } });
    expect(invalidateCourseAdvice).toHaveBeenCalledWith("course-a");
    expect(logged().at(-1)).toEqual(expect.objectContaining({ event: "advice_removed_by_admin", adviceId: "a", courseId: "course-a", adminId: "admin-1", closedReports: "2", adviceRemoved: "true" }));
  });
  it("keeps the advice and dismisses its reports, leaving the feed as it is", async () => {
    expect(await moderateAdvice("admin-1", { adviceId: "a", decision: "keep" })).toEqual({ ok: true, decision: "keep", closedReports: 2 });
    expect(tx.adviceReport.updateMany.mock.calls[0][0].data.status).toBe("DISMISSED");
    expect(tx.advice.update).not.toHaveBeenCalled();
    expect(invalidateCourseAdvice).not.toHaveBeenCalled();
    expect(logged().at(-1)).toMatchObject({ event: "advice_reports_dismissed", closedReports: "2" });
  });
  it("closes the reports of advice its author already deleted, without touching the advice", async () => {
    tx.advice.findUnique.mockResolvedValue({ courseId: "course-a", status: "REMOVED" });
    expect((await moderateAdvice("admin-1", { adviceId: "a", decision: "remove" })).ok).toBe(true);
    expect(tx.advice.update).not.toHaveBeenCalled();
    expect(logged().at(-1)).toMatchObject({ adviceRemoved: "false" });
  });
  it("refuses advice with no open report (already decided, or never reported) and unknown advice, changing nothing", async () => {
    tx.adviceReport.updateMany.mockResolvedValue({ count: 0 });
    expect(await moderateAdvice("admin-1", { adviceId: "a", decision: "remove" })).toEqual({ ok: false, error: "not_found" });
    expect(tx.advice.update).not.toHaveBeenCalled();
    tx.advice.findUnique.mockResolvedValue(null);
    expect(await moderateAdvice("admin-1", { adviceId: "nope", decision: "keep" })).toEqual({ ok: false, error: "not_found" });
    expect(await moderateAdvice("admin-1", { adviceId: " ", decision: "keep" })).toEqual({ ok: false, error: "not_found" });
    expect(invalidateCourseAdvice).not.toHaveBeenCalled();
  });
  it("locks on the advice, so two admins deciding at once wait for each other", async () => {
    await moderateAdvice("admin-1", { adviceId: "a", decision: "keep" });
    expect(tx.$executeRaw.mock.calls[0].slice(1)).toEqual(["advice-moderation:a"]);
  });
  it("refuses any other decision before the database", async () => {
    for (const decision of ["", "REMOVE", "delete", "toString"]) {
      expect(await moderateAdvice("admin-1", { adviceId: "a", decision })).toEqual({ ok: false, error: "invalid_decision" });
    }
    expect(transaction).not.toHaveBeenCalled();
  });
  it("stops an admin after 60 decisions a minute, and the limit can be set", async () => {
    for (let index = 0; index < 60; index++) await moderateAdvice("admin-1", { adviceId: "a", decision: "keep" });
    expect(await moderateAdvice("admin-1", { adviceId: "a", decision: "keep" })).toEqual({ ok: false, error: "rate_limited" });
    expect(transaction).toHaveBeenCalledTimes(60);
    expect(logged().at(-1)).toMatchObject({ event: "advice_moderation_rate_limited", adminId: "admin-1" });
    process.env.ADVICE_MODERATION_RATE_LIMIT_PER_MINUTE = "5";
    expect(adviceModerationLimit()).toBe(5);
  });
  it("answers a database failure with the general refusal, logs its type only, and leaves the cache", async () => {
    transaction.mockRejectedValue(new TypeError("lost secret-host"));
    expect(await moderateAdvice("admin-1", { adviceId: "a", decision: "remove" })).toEqual({ ok: false, error: "unexpected" });
    expect(logged().at(-1)).toEqual(expect.objectContaining({ event: "advice_moderation_failed", errorType: "TypeError" }));
    expect(JSON.stringify(errors.mock.calls)).not.toContain("secret-host");
    expect(invalidateCourseAdvice).not.toHaveBeenCalled();
  });
});

describe("moderateAdviceAction", () => {
  it("lets only admins decide: anyone else is stopped by requireAdmin before the service", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(moderateAdviceAction(form({ adviceId: "a", decision: "remove" }))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(requireAdmin).toHaveBeenCalledWith("/admin/advice-reports");
    expect(transaction).not.toHaveBeenCalled();
  });
  it("comes back to the queue page with the outcome", async () => {
    expect(await redirectedTo(moderateAdviceAction(form({ adviceId: "a", decision: "remove", page: "2" })))).toBe("/admin/advice-reports?page=2&removed=1");
    expect(await redirectedTo(moderateAdviceAction(form({ adviceId: "a", decision: "keep" })))).toBe("/admin/advice-reports?kept=1");
    tx.adviceReport.updateMany.mockResolvedValue({ count: 0 });
    expect(await redirectedTo(moderateAdviceAction(form({ adviceId: "a", decision: "keep", page: "x" })))).toBe("/admin/advice-reports?error=not_found");
  });
});
