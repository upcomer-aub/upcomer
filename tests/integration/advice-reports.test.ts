import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { deleteAdvice } from "@/lib/advice-changes";
import { getOpenReportedAdviceIds, reportAdvice } from "@/lib/advice-reports";
import { resetRateLimits } from "@/lib/rate-limit";

// US-43 against a real database: a report keeps its reason and the advice it is about, a student's second report of the
// same advice is refused (also when sent at the same moment), one's own and removed advice cannot be reported, and a
// report stays on record after its author deletes the advice.

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const id = (name: string) => `it-advrep-${name}-${stamp}`;
const faculty = { id: id("faculty"), code: `IARF${stamp}`.toUpperCase().slice(0, 20), name: "Advice Reports Faculty" };
const courseId = id("course");
const author = { id: id("author"), name: "Advice Author", email: `${id("author")}@advice.test` };
const reporter = { id: id("reporter"), name: "Reporting Student", email: `${id("reporter")}@advice.test` };
const second = { id: id("second"), name: "Second Student", email: `${id("second")}@advice.test` };
const users = [author, reporter, second];

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await db.faculty.create({ data: faculty });
  await db.course.create({ data: { id: courseId, code: `IR${stamp}`.toUpperCase().slice(0, 20), name: "Advice Reports", facultyId: faculty.id } });
  await db.user.createMany({ data: users.map(user => ({ ...user, passwordHash: "x" })) });
});

beforeEach(async () => {
  resetRateLimits();
  await db.advice.deleteMany({ where: { courseId } });
  await db.advice.createMany({ data: [
    { id: id("rude"), courseId, authorId: author.id, anonymous: true, body: "Rude advice." },
    { id: id("fine"), courseId, authorId: author.id, body: "Fine advice." },
    { id: id("removed"), courseId, authorId: author.id, body: "Already removed.", status: "REMOVED", removedAt: new Date(), removedById: author.id },
  ] });
});

afterAll(async () => {
  try {
    await db.course.deleteMany({ where: { id: courseId } });
    await db.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
    await db.faculty.deleteMany({ where: { id: faculty.id } });
    // Deleting the course deleted its advice and their reports.
    expect(await db.adviceReport.count({ where: { courseId } })).toBe(0);
  } finally {
    await db.$disconnect();
  }
});

const reportsOf = (adviceId: string) => db.adviceReport.findMany({ where: { adviceId }, orderBy: { createdAt: "asc" } });

describe("reporting advice (US-43)", () => {
  it("stores the report with its reason, note, reporter, and the advice and course it is about", async () => {
    const outcome = await reportAdvice(reporter.id, { adviceId: id("rude"), reason: "OFFENSIVE", note: "  Insults a TA.  " });
    expect(outcome).toMatchObject({ ok: true, courseId });
    expect(await reportsOf(id("rude"))).toEqual([expect.objectContaining({
      courseId, reporterId: reporter.id, reason: "OFFENSIVE", note: "Insults a TA.", status: "OPEN", closedAt: null, closedById: null,
    })]);
    expect(await getOpenReportedAdviceIds(reporter.id, [id("rude"), id("fine")])).toEqual(new Set([id("rude")]));
    expect(await getOpenReportedAdviceIds(second.id, [id("rude"), id("fine")])).toEqual(new Set());
  });

  it("refuses the same student's second report, but takes another student's", async () => {
    expect((await reportAdvice(reporter.id, { adviceId: id("rude"), reason: "OFFENSIVE" })).ok).toBe(true);
    expect(await reportAdvice(reporter.id, { adviceId: id("rude"), reason: "SPAM" })).toEqual({ ok: false, error: "duplicate" });
    expect((await reportAdvice(second.id, { adviceId: id("rude"), reason: "SPAM" })).ok).toBe(true);
    expect((await reportsOf(id("rude"))).map(report => [report.reporterId, report.reason])).toEqual([[reporter.id, "OFFENSIVE"], [second.id, "SPAM"]]);
  });

  it("opens one report when the same student sends many at the same moment", async () => {
    process.env.ADVICE_REPORT_RATE_LIMIT_PER_MINUTE = "100";
    try {
      // Several rounds, so a missing lock would be caught even when one round happens to run in order.
      for (let round = 0; round < 3; round++) {
        await db.adviceReport.deleteMany({ where: { adviceId: id("fine") } });
        const outcomes = await Promise.all(Array.from({ length: 10 }, () => reportAdvice(reporter.id, { adviceId: id("fine"), reason: "OTHER" })));
        expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1);
        expect(new Set(outcomes.filter(outcome => !outcome.ok).map(outcome => !outcome.ok && outcome.error))).toEqual(new Set(["duplicate"]));
        expect(await reportsOf(id("fine"))).toHaveLength(1);
      }
    } finally {
      delete process.env.ADVICE_REPORT_RATE_LIMIT_PER_MINUTE;
    }
  });

  it("lets the student report again once an admin closed their first report", async () => {
    expect((await reportAdvice(reporter.id, { adviceId: id("fine"), reason: "OTHER" })).ok).toBe(true);
    await db.adviceReport.updateMany({ where: { adviceId: id("fine") }, data: { status: "DISMISSED", closedAt: new Date() } });
    expect((await reportAdvice(reporter.id, { adviceId: id("fine"), reason: "SPAM" })).ok).toBe(true);
    expect((await reportsOf(id("fine"))).map(report => report.status)).toEqual(["DISMISSED", "OPEN"]);
  });

  it("refuses removed advice, unknown advice, and the author's own advice, storing nothing", async () => {
    expect(await reportAdvice(reporter.id, { adviceId: id("removed"), reason: "SPAM" })).toEqual({ ok: false, error: "not_found" });
    expect(await reportAdvice(reporter.id, { adviceId: id("no-such"), reason: "SPAM" })).toEqual({ ok: false, error: "not_found" });
    expect(await reportAdvice(author.id, { adviceId: id("rude"), reason: "SPAM" })).toEqual({ ok: false, error: "own_advice" });
    expect(await db.adviceReport.count({ where: { courseId } })).toBe(0);
  });

  it("keeps the report on record when the author deletes the advice afterwards", async () => {
    expect((await reportAdvice(reporter.id, { adviceId: id("rude"), reason: "PERSONAL_INFO" })).ok).toBe(true);
    expect((await deleteAdvice(author.id, id("rude"))).ok).toBe(true);
    expect(await reportsOf(id("rude"))).toEqual([expect.objectContaining({ reason: "PERSONAL_INFO", status: "OPEN" })]);
    // And nobody can report it any more.
    expect(await reportAdvice(second.id, { adviceId: id("rude"), reason: "SPAM" })).toEqual({ ok: false, error: "not_found" });
  });

  it("keeps the report when the reporter's account is deleted, without a reporter", async () => {
    const leaving = { id: id("leaving"), name: "Leaving Student", email: `${id("leaving")}@advice.test`, passwordHash: "x" };
    await db.user.create({ data: leaving });
    expect((await reportAdvice(leaving.id, { adviceId: id("fine"), reason: "SPAM" })).ok).toBe(true);
    await db.user.delete({ where: { id: leaving.id } });
    expect(await reportsOf(id("fine"))).toEqual([expect.objectContaining({ reporterId: null, reason: "SPAM", status: "OPEN" })]);
  });
});
