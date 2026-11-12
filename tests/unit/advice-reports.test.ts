import { beforeEach, describe, expect, it, vi } from "vitest";

// Reporting advice (US-43) with the database mocked: the reason and note rules, one open report per student and advice,
// no reports of one's own or removed advice, the rate limit, nothing typed logged, and the action's redirects.

const { tx, adviceReport, advice: adviceTable, transaction, requireUser, redirect } = vi.hoisted(() => ({
  tx: { $executeRaw: vi.fn(), advice: { findFirst: vi.fn() }, adviceReport: { findFirst: vi.fn(), create: vi.fn() } },
  adviceReport: { findMany: vi.fn(), count: vi.fn() },
  advice: { findFirst: vi.fn() },
  transaction: vi.fn(),
  requireUser: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`NEXT_REDIRECT ${location}`); }),
}));
vi.mock("@/lib/db", () => ({ db: { $transaction: transaction, adviceReport, advice: adviceTable } }));
vi.mock("@/lib/auth", () => ({ requireUser }));
vi.mock("next/navigation", () => ({ redirect }));
import { reportAdviceAction } from "@/lib/advice-report-actions";
import { adviceReportMessage, ADVICE_REPORT_REASONS, MAX_ADVICE_REPORT_NOTE_LENGTH } from "@/lib/advice-report-rules";
import { adviceReportLimit, getOpenReportedAdviceIds, getReportableAdvice, reportAdvice } from "@/lib/advice-reports";
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
const advice = { id: "advice-1", courseId: "course-a", authorId: "author-1" };
const valid = { adviceId: "advice-1", reason: "OFFENSIVE", note: "It insults the professor by name." };

beforeEach(() => {
  resetRateLimits();
  delete process.env.ADVICE_REPORT_RATE_LIMIT_PER_MINUTE;
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  transaction.mockReset().mockImplementation((work: (client: typeof tx) => unknown) => work(tx));
  tx.$executeRaw.mockReset().mockResolvedValue(1);
  tx.advice.findFirst.mockReset().mockResolvedValue(advice);
  tx.adviceReport.findFirst.mockReset().mockResolvedValue(null);
  tx.adviceReport.create.mockReset().mockResolvedValue({ id: "report-1", courseId: "course-a" });
  adviceReport.findMany.mockReset().mockResolvedValue([]);
  adviceReport.count.mockReset().mockResolvedValue(0);
  adviceTable.findFirst.mockReset().mockResolvedValue(null);
  requireUser.mockReset().mockResolvedValue({ id: "student-1" });
  redirect.mockClear();
});

describe("reportAdvice", () => {
  it("files a report with its reason, note, and the advice's own course, linked to the advice", async () => {
    expect(await reportAdvice("student-1", valid)).toEqual({ ok: true, reportId: "report-1", courseId: "course-a" });
    expect(tx.advice.findFirst).toHaveBeenCalledWith({ where: { id: "advice-1", status: "VISIBLE" }, select: { id: true, courseId: true, authorId: true } });
    expect(tx.adviceReport.create).toHaveBeenCalledWith({
      data: { adviceId: "advice-1", courseId: "course-a", reporterId: "student-1", reason: "OFFENSIVE", note: "It insults the professor by name." },
      select: { id: true, courseId: true },
    });
  });
  it("locks on the advice and the student, so two clicks open one report", async () => {
    await reportAdvice("student-1", valid);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.calls[0].slice(1)).toEqual(["advice-report:advice-1:student-1"]);
  });
  it("refuses a second report while the student's first is open, and opens nothing", async () => {
    tx.adviceReport.findFirst.mockResolvedValue({ id: "report-0" });
    expect(await reportAdvice("student-1", valid)).toEqual({ ok: false, error: "duplicate" });
    expect(tx.adviceReport.findFirst).toHaveBeenCalledWith({ where: { adviceId: "advice-1", reporterId: "student-1", status: "OPEN" }, select: { id: true } });
    expect(tx.adviceReport.create).not.toHaveBeenCalled();
  });
  it("refuses advice that is removed or does not exist, and the student's own advice", async () => {
    tx.advice.findFirst.mockResolvedValueOnce(null);
    expect(await reportAdvice("student-1", valid)).toEqual({ ok: false, error: "not_found" });
    expect(await reportAdvice("author-1", valid)).toEqual({ ok: false, error: "own_advice" });
    expect(await reportAdvice("student-1", { ...valid, adviceId: "  " })).toEqual({ ok: false, error: "not_found" });
    expect(tx.adviceReport.create).not.toHaveBeenCalled();
  });
  it("refuses a reason not on the list, including inherited names", async () => {
    for (const reason of ["", "offensive", "WRONG_TEXT", "toString", "__proto__"]) {
      expect(await reportAdvice("student-1", { ...valid, reason })).toEqual({ ok: false, error: "invalid_reason" });
    }
    expect(transaction).not.toHaveBeenCalled();
  });
  it(`keeps a note of up to ${MAX_ADVICE_REPORT_NOTE_LENGTH} characters, trimmed; an empty or invisible note is no note`, async () => {
    expect(await reportAdvice("student-1", { ...valid, note: "a".repeat(MAX_ADVICE_REPORT_NOTE_LENGTH + 1) })).toEqual({ ok: false, error: "note_too_long" });
    await reportAdvice("student-1", { ...valid, note: `  ${"a".repeat(MAX_ADVICE_REPORT_NOTE_LENGTH - 2)}\r\nb ` });
    expect(tx.adviceReport.create.mock.calls.at(-1)?.[0].data.note).toHaveLength(MAX_ADVICE_REPORT_NOTE_LENGTH);
    for (const note of ["", "   ", "​​"]) {
      resetRateLimits();
      await reportAdvice("student-1", { ...valid, note });
      expect(tx.adviceReport.create.mock.calls.at(-1)?.[0].data.note).toBeNull();
    }
  });
  it("logs IDs and the category only, never the note", async () => {
    await reportAdvice("student-1", valid);
    tx.adviceReport.findFirst.mockResolvedValue({ id: "report-0" });
    await reportAdvice("student-1", valid);
    expect(logged()).toEqual([
      expect.objectContaining({ event: "advice_report_submitted", reportId: "report-1", courseId: "course-a", adviceId: "advice-1", category: "OFFENSIVE", userId: "student-1" }),
      expect.objectContaining({ event: "advice_report_refused", adviceId: "advice-1", reason: "duplicate", userId: "student-1" }),
    ]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("insults");
  });
  it("stops a student after 10 reports a minute, before the database, and the limit can be set", async () => {
    for (let report = 0; report < 10; report++) expect((await reportAdvice("student-1", valid)).ok).toBe(true);
    expect(await reportAdvice("student-1", valid)).toEqual({ ok: false, error: "rate_limited" });
    expect(transaction).toHaveBeenCalledTimes(10);
    expect(logged().at(-1)).toMatchObject({ event: "advice_report_rate_limited", userId: "student-1" });
    // Another student is not affected.
    expect((await reportAdvice("student-2", valid)).ok).toBe(true);
    process.env.ADVICE_REPORT_RATE_LIMIT_PER_MINUTE = "3";
    expect(adviceReportLimit()).toBe(3);
  });
  it("answers a database failure with the general refusal and logs its type only", async () => {
    transaction.mockRejectedValue(new TypeError("connection lost to secret-host"));
    expect(await reportAdvice("student-1", valid)).toEqual({ ok: false, error: "unexpected" });
    expect(logged().at(-1)).toEqual(expect.objectContaining({ event: "advice_report_failed", errorType: "TypeError" }));
    expect(JSON.stringify(errors.mock.calls)).not.toContain("secret-host");
  });
});

describe("getOpenReportedAdviceIds", () => {
  it("returns the advice the student has an open report of, from one query", async () => {
    adviceReport.findMany.mockResolvedValue([{ adviceId: "a" }, { adviceId: "a" }, { adviceId: "c" }]);
    expect(await getOpenReportedAdviceIds("student-1", ["a", "b", "c"])).toEqual(new Set(["a", "c"]));
    expect(adviceReport.findMany).toHaveBeenCalledWith({ where: { reporterId: "student-1", status: "OPEN", adviceId: { in: ["a", "b", "c"] } }, select: { adviceId: true } });
  });
  it("reads nothing for an empty page", async () => {
    expect(await getOpenReportedAdviceIds("student-1", [])).toEqual(new Set());
    expect(adviceReport.findMany).not.toHaveBeenCalled();
  });
});

describe("getReportableAdvice", () => {
  const stored = {
    id: "advice-1", authorId: "author-1", body: "Skip the labs.", anonymous: true, scope: "COURSE", topic: null, resourceUrl: null, editedAt: null,
    createdAt: new Date("2026-11-10T09:00:00Z"), author: { name: "Real Author" }, file: null, term: null, questionGroup: null,
  };
  it("finds only advice shown in the course, as students see it, without the author's ID or an anonymous author's name", async () => {
    adviceTable.findFirst.mockResolvedValue(stored);
    const found = await getReportableAdvice("student-1", "course-a", "advice-1");
    expect(adviceTable.findFirst.mock.calls[0][0].where).toMatchObject({ courseId: "course-a", status: "VISIBLE", id: "advice-1" });
    expect(found).toMatchObject({ own: false, reported: false, advice: { id: "advice-1", author: "Anonymous student", body: "Skip the labs." } });
    expect(JSON.stringify(found)).not.toContain("author-1");
    expect(JSON.stringify(found)).not.toContain("Real Author");
  });
  it("says when it is the student's own advice, or when they already have an open report of it", async () => {
    adviceTable.findFirst.mockResolvedValue(stored);
    expect(await getReportableAdvice("author-1", "course-a", "advice-1")).toMatchObject({ own: true, reported: false });
    expect(adviceReport.count).not.toHaveBeenCalled();
    adviceReport.count.mockResolvedValue(1);
    expect(await getReportableAdvice("student-1", "course-a", "advice-1")).toMatchObject({ own: false, reported: true });
    expect(adviceReport.count).toHaveBeenCalledWith({ where: { adviceId: "advice-1", reporterId: "student-1", status: "OPEN" } });
  });
  it("is null for advice not shown in the course, and reads nothing for an empty ID", async () => {
    expect(await getReportableAdvice("student-1", "course-a", "advice-1")).toBeNull();
    expect(await getReportableAdvice("student-1", "course-a", "")).toBeNull();
    expect(adviceTable.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe("the report rules", () => {
  it("lists five reasons; unknown errors get the general message", () => {
    expect(ADVICE_REPORT_REASONS.map(reason => reason.value)).toEqual(["OFFENSIVE", "SPAM", "PERSONAL_INFO", "ACADEMIC_DISHONESTY", "OTHER"]);
    expect(adviceReportMessage("duplicate")).toBe("You already reported this advice. An admin will check it.");
    expect(adviceReportMessage("constructor")).toBe("Your report could not be sent. Please try again.");
  });
});

describe("reportAdviceAction", () => {
  it("sends a visitor to log in and back to the feed, filing nothing", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    await expect(reportAdviceAction(form({ courseId: "course-a", ...valid }))).rejects.toThrow("NEXT_REDIRECT");
    expect(requireUser).toHaveBeenCalledWith("/courses/course-a/advice");
    expect(transaction).not.toHaveBeenCalled();
  });
  it("comes back to the advice's own course and feed page with the outcome, never the note", async () => {
    expect(await redirectedTo(reportAdviceAction(form({ courseId: "forged", page: "3", ...valid })))).toBe("/courses/course-a/advice?page=3&reported=1");
    tx.adviceReport.findFirst.mockResolvedValue({ id: "report-0" });
    expect(await redirectedTo(reportAdviceAction(form({ courseId: "course-a", page: "x", ...valid })))).toBe("/courses/course-a/advice?report_error=duplicate");
    expect(redirect.mock.calls.flat().join(" ")).not.toContain("insults");
  });
  it("sends a reason or note to fix, or the rate limit, back to the report page", async () => {
    expect(await redirectedTo(reportAdviceAction(form({ courseId: "course-a", ...valid, reason: "MADE_UP", page: "2" }))))
      .toBe("/courses/course-a/advice/advice-1/report?page=2&error=invalid_reason");
    expect(await redirectedTo(reportAdviceAction(form({ courseId: "course-a", ...valid, note: "a".repeat(MAX_ADVICE_REPORT_NOTE_LENGTH + 1) }))))
      .toBe("/courses/course-a/advice/advice-1/report?error=note_too_long");
  });
  it("keeps a hand-made course ID inside its path segment", async () => {
    tx.advice.findFirst.mockResolvedValue(null);
    expect(await redirectedTo(reportAdviceAction(form({ courseId: "../admin?x=1", ...valid })))).toBe("/courses/..%2Fadmin%3Fx%3D1/advice?report_error=not_found");
  });
});
