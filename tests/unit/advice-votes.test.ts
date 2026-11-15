import { beforeEach, describe, expect, it, vi } from "vitest";

// US-40: the helpful mark (set, undo, one per student, own advice, other course, removed advice, rate limit, failures) and
// the counts, with the database mocked. The real database is in tests/integration/advice-votes.test.ts.

const db = vi.hoisted(() => ({
  advice: { findFirst: vi.fn() },
  adviceVote: { createMany: vi.fn(), deleteMany: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
}));
const logError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/logger", () => ({ logError, errorCode: (error: unknown) => (error as { code?: string } | null)?.code }));

import { getHelpfulCounts, setAdviceHelpful } from "@/lib/advice-votes";
import { helpfulLabel, keptAdviceQuery, parseAdviceSort, parseHelpful, voteMessage } from "@/lib/advice-vote-rules";
import { resetRateLimits } from "@/lib/rate-limit";

const events = () => logError.mock.calls.map(([event, context]) => ({ event, ...context }));

beforeEach(() => {
  resetRateLimits();
  delete process.env.ADVICE_VOTE_RATE_LIMIT_PER_MINUTE;
  logError.mockReset();
  db.advice.findFirst.mockReset().mockResolvedValue({ authorId: "author-1" });
  db.adviceVote.createMany.mockReset().mockResolvedValue({ count: 1 });
  db.adviceVote.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  db.adviceVote.groupBy.mockReset().mockResolvedValue([]);
  db.adviceVote.findMany.mockReset().mockResolvedValue([]);
});

describe("advice vote rules (US-40)", () => {
  it("reads only 1 and 0 as a helpful state", () => {
    expect(parseHelpful("1")).toBe(true);
    expect(parseHelpful("0")).toBe(false);
    for (const value of [null, "", "2", "true", "on", " 1"]) expect(parseHelpful(value)).toBeNull();
  });
  it("sorts newest first unless most helpful is asked for", () => {
    expect(parseAdviceSort("helpful")).toBe("helpful");
    for (const value of [undefined, "", "newest", "HELPFUL", "votes", ["helpful"]]) expect(parseAdviceSort(value)).toBe("newest");
  });
  it("keeps only the advice page's search, filters, sort, and page when coming back", () => {
    const kept = keptAdviceQuery("q=labs&topic=TCP&sort=helpful&page=2&helpful=saved&helpful_error=x&evil=1");
    expect(Object.fromEntries(kept)).toEqual({ q: "labs", topic: "TCP", sort: "helpful", page: "2" });
    expect(keptAdviceQuery(`q=${"a".repeat(500)}`).get("q")).toHaveLength(200);
  });
  it("has a message for every refusal and a safe default", () => {
    expect(voteMessage("own_advice")).toBe("You cannot mark your own advice as helpful.");
    expect(voteMessage("<script>")).toBe(voteMessage("unexpected"));
    expect(voteMessage("toString")).toBe(voteMessage("unexpected"));
  });
  it("words the count", () => {
    expect([0, 1, 2].map(helpfulLabel)).toEqual(["0 students found this helpful", "1 student found this helpful", "2 students found this helpful"]);
  });
});

describe("setAdviceHelpful (US-40)", () => {
  it("marks visible advice of the course as helpful once", async () => {
    expect(await setAdviceHelpful("student-1", "course-1", "advice-1", true)).toEqual({ ok: true, helpful: true, changed: true });
    expect(db.advice.findFirst).toHaveBeenCalledWith({ where: { id: "advice-1", courseId: "course-1", status: "VISIBLE" }, select: { authorId: true } });
    expect(db.adviceVote.createMany).toHaveBeenCalledWith({ data: [{ adviceId: "advice-1", userId: "student-1" }], skipDuplicates: true });
    expect(events()).toEqual([{ event: "advice_vote_saved", userId: "student-1", courseId: "course-1", adviceId: "advice-1", helpful: "true", changed: "true" }]);
  });
  it("does not count a second mark by the same student (changed: false)", async () => {
    db.adviceVote.createMany.mockResolvedValue({ count: 0 });
    expect(await setAdviceHelpful("student-1", "course-1", "advice-1", true)).toEqual({ ok: true, helpful: true, changed: false });
  });
  it("undoes the student's own mark only", async () => {
    expect(await setAdviceHelpful("student-1", "course-1", "advice-1", false)).toEqual({ ok: true, helpful: false, changed: true });
    expect(db.adviceVote.deleteMany).toHaveBeenCalledWith({ where: { adviceId: "advice-1", userId: "student-1" } });
    db.adviceVote.deleteMany.mockResolvedValue({ count: 0 });
    expect(await setAdviceHelpful("student-1", "course-1", "advice-1", false)).toEqual({ ok: true, helpful: false, changed: false });
  });
  it("refuses unknown, removed, or another course's advice as not found, saving nothing", async () => {
    db.advice.findFirst.mockResolvedValue(null);
    expect(await setAdviceHelpful("student-1", "course-1", "advice-x", true)).toEqual({ ok: false, error: "not_found" });
    expect(await setAdviceHelpful("student-1", "", "advice-x", true)).toEqual({ ok: false, error: "not_found" });
    expect(db.adviceVote.createMany).not.toHaveBeenCalled();
    expect(events()[0]).toMatchObject({ event: "advice_vote_refused", reason: "not_found" });
  });
  it("refuses a mark on the student's own advice", async () => {
    db.advice.findFirst.mockResolvedValue({ authorId: "student-1" });
    expect(await setAdviceHelpful("student-1", "course-1", "advice-1", true)).toEqual({ ok: false, error: "own_advice" });
    expect(db.adviceVote.createMany).not.toHaveBeenCalled();
  });
  it("treats advice deleted during the save as not found", async () => {
    db.adviceVote.createMany.mockRejectedValue(Object.assign(new Error("fk"), { code: "P2003" }));
    expect(await setAdviceHelpful("student-1", "course-1", "advice-1", true)).toEqual({ ok: false, error: "not_found" });
  });
  it("logs a failure with IDs and the error type only", async () => {
    db.advice.findFirst.mockRejectedValue(new TypeError("connection to 10.0.0.1 lost"));
    expect(await setAdviceHelpful("student-1", "course-1", "advice-1", true)).toEqual({ ok: false, error: "unexpected" });
    expect(events()).toEqual([expect.objectContaining({ event: "advice_vote_failed", userId: "student-1", adviceId: "advice-1", errorType: "TypeError" })]);
    expect(JSON.stringify(events())).not.toContain("10.0.0.1");
  });
  it("limits marks per student per minute without touching the database", async () => {
    process.env.ADVICE_VOTE_RATE_LIMIT_PER_MINUTE = "2";
    await setAdviceHelpful("student-1", "course-1", "advice-1", true);
    await setAdviceHelpful("student-1", "course-1", "advice-1", false);
    db.advice.findFirst.mockClear();
    expect(await setAdviceHelpful("student-1", "course-1", "advice-1", true)).toEqual({ ok: false, error: "rate_limited" });
    expect(db.advice.findFirst).not.toHaveBeenCalled();
    expect(events().at(-1)).toMatchObject({ event: "advice_vote_rate_limited" });
    expect((await setAdviceHelpful("student-2", "course-1", "advice-1", true)).ok).toBe(true);
  });
});

describe("getHelpfulCounts (US-40)", () => {
  it("gives every advice a count, zero without marks, and says which the viewer marked", async () => {
    db.adviceVote.groupBy.mockResolvedValue([{ adviceId: "a", _count: { _all: 3 } }, { adviceId: "b", _count: { _all: 1 } }]);
    db.adviceVote.findMany.mockResolvedValue([{ adviceId: "b" }]);
    const counts = await getHelpfulCounts(["a", "b", "c"], "viewer-1");
    expect(Object.fromEntries(counts)).toEqual({ a: { count: 3, mine: false }, b: { count: 1, mine: true }, c: { count: 0, mine: false } });
    expect(db.adviceVote.findMany).toHaveBeenCalledWith({ where: { userId: "viewer-1", adviceId: { in: ["a", "b", "c"] } }, select: { adviceId: true } });
  });
  it("reads no viewer marks for a visitor, and nothing for an empty page", async () => {
    await getHelpfulCounts(["a"], null);
    expect(db.adviceVote.findMany).not.toHaveBeenCalled();
    db.adviceVote.groupBy.mockClear();
    expect((await getHelpfulCounts([], "viewer-1")).size).toBe(0);
    expect(db.adviceVote.groupBy).not.toHaveBeenCalled();
  });
  it("logs a failed read and rethrows it", async () => {
    db.adviceVote.groupBy.mockRejectedValue(new RangeError("x"));
    await expect(getHelpfulCounts(["a"], "viewer-1")).rejects.toThrow(RangeError);
    expect(events()).toEqual([expect.objectContaining({ event: "advice_vote_retrieval_failed", userId: "viewer-1", errorType: "RangeError" })]);
  });
});
