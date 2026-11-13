import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { getCourseAdvice, resetAdviceCache } from "@/lib/advice";
import { deleteAdvice } from "@/lib/advice-changes";
import { getAdviceReportQueue, moderateAdvice } from "@/lib/advice-moderation";
import { reportAdvice } from "@/lib/advice-reports";
import { resetRateLimits } from "@/lib/rate-limit";

// US-77 against a real database: the queue shows reported advice once with all its reports, removing advice takes it out
// of the feed at once (through the cache) and resolves its reports, keeping it dismisses them, two admins deciding at once
// close each report once, and the anonymous author stays anonymous in the queue.

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const id = (name: string) => `it-advmod-${name}-${stamp}`;
const faculty = { id: id("faculty"), code: `IAMF${stamp}`.toUpperCase().slice(0, 20), name: "Advice Moderation Faculty" };
const courseId = id("course");
const author = { id: id("author"), name: `Secret Author ${stamp}`, email: `${id("author")}@advice.test` };
const students = [1, 2, 3].map(index => ({ id: id(`student${index}`), name: `Student ${index}`, email: `${id(`student${index}`)}@advice.test` }));
const admins = [1, 2].map(index => ({ id: id(`admin${index}`), name: `Admin ${index}`, email: `${id(`admin${index}`)}@advice.test`, role: "ADMIN" as const }));
const users = [author, ...students, ...admins];

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await db.faculty.create({ data: faculty });
  await db.course.create({ data: { id: courseId, code: `IM${stamp}`.toUpperCase().slice(0, 20), name: "Advice Moderation", facultyId: faculty.id } });
  await db.user.createMany({ data: users.map(user => ({ ...user, passwordHash: "x" })) });
});

beforeEach(async () => {
  resetRateLimits();
  resetAdviceCache();
  await db.advice.deleteMany({ where: { courseId } });
  await db.advice.createMany({ data: [
    { id: id("rude"), courseId, authorId: author.id, anonymous: true, body: "Rude advice.", createdAt: new Date(Date.now() - 2_000) },
    { id: id("fine"), courseId, authorId: author.id, body: "Fine advice.", createdAt: new Date(Date.now() - 1_000) },
  ] });
});

afterAll(async () => {
  try {
    await db.course.deleteMany({ where: { id: courseId } });
    await db.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
    await db.faculty.deleteMany({ where: { id: faculty.id } });
  } finally {
    await db.$disconnect();
  }
});

const ours = async () => (await getAdviceReportQueue()).items.filter(item => item.course.id === courseId);
const statuses = async (adviceId: string) => (await db.adviceReport.findMany({ where: { adviceId }, orderBy: { createdAt: "asc" } })).map(report => report.status);

describe("moderating reported advice (US-77)", () => {
  it("queues each reported advice once, with all its open reports, as students see it", async () => {
    await reportAdvice(students[0].id, { adviceId: id("rude"), reason: "OFFENSIVE", note: "Insults a TA." });
    await reportAdvice(students[1].id, { adviceId: id("rude"), reason: "SPAM" });
    const [item, ...rest] = await ours();
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ shown: true, advice: { id: id("rude"), author: "Anonymous student", body: "Rude advice." } });
    expect(item.reports.map(report => [report.reason, report.note])).toEqual([["OFFENSIVE", "Insults a TA."], ["SPAM", null]]);
    // The anonymous author, and who reported, are not in what the page gets.
    const json = JSON.stringify(item);
    for (const secret of [author.id, author.name, students[0].id, students[1].id]) expect(json).not.toContain(secret);
  });

  it("removing the advice takes it out of the feed at once, resolves its reports, and empties the queue", async () => {
    await reportAdvice(students[0].id, { adviceId: id("rude"), reason: "OFFENSIVE" });
    await reportAdvice(students[1].id, { adviceId: id("rude"), reason: "SPAM" });
    // The feed is cached before the decision.
    expect((await getCourseAdvice(courseId)).items.map(item => item.id)).toContain(id("rude"));
    expect(await moderateAdvice(admins[0].id, { adviceId: id("rude"), decision: "remove" })).toEqual({ ok: true, decision: "remove", closedReports: 2 });
    expect((await getCourseAdvice(courseId)).items.map(item => item.id)).toEqual([id("fine")]);
    expect(await db.advice.findUniqueOrThrow({ where: { id: id("rude") } })).toMatchObject({ status: "REMOVED", removedById: admins[0].id });
    expect(await statuses(id("rude"))).toEqual(["RESOLVED", "RESOLVED"]);
    expect((await db.adviceReport.findFirstOrThrow({ where: { adviceId: id("rude") } })).closedById).toBe(admins[0].id);
    expect(await ours()).toEqual([]);
    // Removed advice can no longer be reported, nor edited back by its author.
    expect(await reportAdvice(students[2].id, { adviceId: id("rude"), reason: "SPAM" })).toEqual({ ok: false, error: "not_found" });
  });

  it("keeping the advice dismisses its reports and leaves it in the feed; it can be reported again", async () => {
    await reportAdvice(students[0].id, { adviceId: id("fine"), reason: "OTHER" });
    expect(await moderateAdvice(admins[0].id, { adviceId: id("fine"), decision: "keep" })).toMatchObject({ ok: true, decision: "keep", closedReports: 1 });
    expect(await statuses(id("fine"))).toEqual(["DISMISSED"]);
    expect((await getCourseAdvice(courseId)).items.map(item => item.id)).toContain(id("fine"));
    expect((await reportAdvice(students[0].id, { adviceId: id("fine"), reason: "SPAM" })).ok).toBe(true);
    expect(await statuses(id("fine"))).toEqual(["DISMISSED", "OPEN"]);
  });

  it("two admins deciding at once close each report once; the second is told it was already decided", async () => {
    await reportAdvice(students[0].id, { adviceId: id("rude"), reason: "OFFENSIVE" });
    await reportAdvice(students[1].id, { adviceId: id("rude"), reason: "OFFENSIVE" });
    const outcomes = await Promise.all([
      moderateAdvice(admins[0].id, { adviceId: id("rude"), decision: "remove" }),
      moderateAdvice(admins[1].id, { adviceId: id("rude"), decision: "keep" }),
    ]);
    const decided = outcomes.filter(outcome => outcome.ok);
    expect(decided).toHaveLength(1);
    expect(outcomes.filter(outcome => !outcome.ok)).toEqual([{ ok: false, error: "not_found" }]);
    const winner = decided[0].ok ? decided[0].decision : null;
    expect(await statuses(id("rude"))).toEqual(winner === "remove" ? ["RESOLVED", "RESOLVED"] : ["DISMISSED", "DISMISSED"]);
    expect((await db.advice.findUniqueOrThrow({ where: { id: id("rude") } })).status).toBe(winner === "remove" ? "REMOVED" : "VISIBLE");
  });

  it("refuses advice with no open report, so an admin cannot remove advice nobody reported", async () => {
    expect(await moderateAdvice(admins[0].id, { adviceId: id("fine"), decision: "remove" })).toEqual({ ok: false, error: "not_found" });
    expect((await db.advice.findUniqueOrThrow({ where: { id: id("fine") } })).status).toBe("VISIBLE");
  });

  it("shows advice its author deleted after the report as no longer shown, and closing it keeps the author's deletion", async () => {
    await reportAdvice(students[0].id, { adviceId: id("rude"), reason: "PERSONAL_INFO" });
    expect((await deleteAdvice(author.id, id("rude"))).ok).toBe(true);
    expect((await ours())[0]).toMatchObject({ shown: false });
    expect((await moderateAdvice(admins[0].id, { adviceId: id("rude"), decision: "remove" })).ok).toBe(true);
    expect(await db.advice.findUniqueOrThrow({ where: { id: id("rude") } })).toMatchObject({ status: "REMOVED", removedById: author.id });
    expect(await statuses(id("rude"))).toEqual(["RESOLVED"]);
  });
});
