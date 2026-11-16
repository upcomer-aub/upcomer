import { randomUUID } from "node:crypto";
import { AdviceScopeKind, AdviceStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { searchAdvice } from "@/lib/advice";
import { getHelpfulCounts, setAdviceHelpful } from "@/lib/advice-votes";
import { db } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";

// US-40 against a real, migrated database: one helpful mark per student (also when sent in parallel), undo, the "Most
// helpful" sort with its ties, refusals, privacy of voters, and that a course's sort never sees another course's advice.
// Everything is created here with a unique suffix and deleted in afterAll.

const run = randomUUID().slice(0, 8);
const ids = { faculty: "", courseA: "", courseB: "", author: "", students: [] as string[], advice: {} as Record<string, string> };

beforeEach(() => resetRateLimits());

beforeAll(async () => {
  const faculty = await db.faculty.create({ data: { code: `FV${run}`, name: `Faculty ${run}` } });
  const [courseA, courseB] = await Promise.all(["A", "B"].map(name => db.course.create({ data: { code: `V${name}${run}`, name: `Votes ${name}`, facultyId: faculty.id } })));
  const users = await Promise.all(["author", "s1", "s2", "s3", "s4"].map(name =>
    db.user.create({ data: { email: `vote-${name}-${run}@example.com`, passwordHash: "x", name: `Voter ${name} ${run}` } })));
  const advice = async (name: string, courseId: string, day: number, over: Record<string, unknown> = {}) => (await db.advice.create({
    data: { courseId, authorId: users[0].id, scopeKind: AdviceScopeKind.COURSE, scopeLabel: "course", title: `${name} ${run}`, body: "body", createdAt: new Date(Date.UTC(2026, 10, day)), ...over },
  })).id;
  Object.assign(ids, { faculty: faculty.id, courseA: courseA.id, courseB: courseB.id, author: users[0].id, students: users.slice(1).map(user => user.id) });
  ids.advice = {
    oldest: await advice("oldest", courseA.id, 1),
    middle: await advice("middle", courseA.id, 2, { isAnonymous: true }),
    newest: await advice("newest", courseA.id, 3),
    removed: await advice("removed", courseA.id, 4, { status: AdviceStatus.REMOVED }),
    other: await advice("other", courseB.id, 5),
  };
});

afterAll(async () => {
  await db.course.deleteMany({ where: { id: { in: [ids.courseA, ids.courseB].filter(Boolean) } } });
  await db.user.deleteMany({ where: { id: { in: [ids.author, ...ids.students].filter(Boolean) } } });
  if (ids.faculty) await db.faculty.deleteMany({ where: { id: ids.faculty } });
  await db.$disconnect();
});

const count = async (adviceId: string) => (await getHelpfulCounts([adviceId], null)).get(adviceId)!.count;
const titles = async (courseId: string, sort?: "helpful" | "newest") =>
  (await searchAdvice(courseId, null, { sort })).items.map(item => item.title.replace(` ${run}`, ""));
const clearVotes = () => db.adviceVote.deleteMany({ where: { adviceId: { in: Object.values(ids.advice) } } });

describe("helpful marks (US-40)", () => {
  beforeEach(clearVotes);

  it("raises the count by one when a student marks advice helpful (acceptance test 1)", async () => {
    expect(await count(ids.advice.oldest)).toBe(0);
    expect(await setAdviceHelpful(ids.students[0], ids.courseA, ids.advice.oldest, true)).toEqual({ ok: true, helpful: true, changed: true });
    expect(await count(ids.advice.oldest)).toBe(1);
  });

  it("never counts the same student twice, and lets them undo (acceptance test 2)", async () => {
    await setAdviceHelpful(ids.students[0], ids.courseA, ids.advice.oldest, true);
    expect(await setAdviceHelpful(ids.students[0], ids.courseA, ids.advice.oldest, true)).toEqual({ ok: true, helpful: true, changed: false });
    expect(await count(ids.advice.oldest)).toBe(1);
    expect((await getHelpfulCounts([ids.advice.oldest], ids.students[0])).get(ids.advice.oldest)).toEqual({ count: 1, mine: true });
    expect(await setAdviceHelpful(ids.students[0], ids.courseA, ids.advice.oldest, false)).toEqual({ ok: true, helpful: false, changed: true });
    expect(await count(ids.advice.oldest)).toBe(0);
    expect(await setAdviceHelpful(ids.students[0], ids.courseA, ids.advice.oldest, false)).toEqual({ ok: true, helpful: false, changed: false });
  });

  it("makes one mark from ten parallel clicks of one student", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => setAdviceHelpful(ids.students[1], ids.courseA, ids.advice.newest, true)));
    expect(results.every(result => result.ok)).toBe(true);
    expect(results.filter(result => result.ok && result.changed)).toHaveLength(1);
    expect(await count(ids.advice.newest)).toBe(1);
  });

  it("refuses the author's own advice, removed advice, and advice of another course, saving nothing", async () => {
    expect(await setAdviceHelpful(ids.author, ids.courseA, ids.advice.oldest, true)).toEqual({ ok: false, error: "own_advice" });
    expect(await setAdviceHelpful(ids.students[0], ids.courseA, ids.advice.removed, true)).toEqual({ ok: false, error: "not_found" });
    expect(await setAdviceHelpful(ids.students[0], ids.courseA, ids.advice.other, true)).toEqual({ ok: false, error: "not_found" });
    expect(await setAdviceHelpful(ids.students[0], ids.courseA, "no-such-advice", true)).toEqual({ ok: false, error: "not_found" });
    expect(await db.adviceVote.count({ where: { adviceId: { in: Object.values(ids.advice) } } })).toBe(0);
  });

  it("gives students counts only, never who voted, so anonymous advice stays anonymous", async () => {
    await setAdviceHelpful(ids.students[0], ids.courseA, ids.advice.middle, true);
    const counts = JSON.stringify([...(await getHelpfulCounts([ids.advice.middle], ids.students[1]))]);
    for (const userId of [ids.author, ...ids.students]) expect(counts).not.toContain(userId);
    const feed = await searchAdvice(ids.courseA, ids.students[1], { sort: "helpful" });
    expect(JSON.stringify(feed)).not.toContain(ids.author);
    // The anonymous post is first (it has the only mark) and still has no author name in the sorted feed.
    expect(feed.items[0]).toMatchObject({ id: ids.advice.middle, authorLabel: "Anonymous student" });
    expect(JSON.stringify(feed.items[0])).not.toContain(`Voter author ${run}`);
  });

  it("drops a deleted student's marks from the count", async () => {
    const leaving = await db.user.create({ data: { email: `vote-leaving-${run}@example.com`, passwordHash: "x", name: "Leaving" } });
    await setAdviceHelpful(leaving.id, ids.courseA, ids.advice.oldest, true);
    expect(await count(ids.advice.oldest)).toBe(1);
    await db.user.delete({ where: { id: leaving.id } });
    expect(await count(ids.advice.oldest)).toBe(0);
  });
});

describe("sort by helpfulness (US-40)", () => {
  beforeAll(clearVotes);

  it("keeps newest first by default", async () => {
    expect(await titles(ids.courseA)).toEqual(["newest", "middle", "oldest"]);
    expect(await titles(ids.courseA, "newest")).toEqual(["newest", "middle", "oldest"]);
  });

  it("puts the most helpful first, breaks ties by newest, and reacts to new marks (acceptance test 3)", async () => {
    // No marks yet: every count ties, so the order is newest first.
    expect(await titles(ids.courseA, "helpful")).toEqual(["newest", "middle", "oldest"]);
    for (const student of ids.students.slice(0, 2)) await setAdviceHelpful(student, ids.courseA, ids.advice.oldest, true);
    await setAdviceHelpful(ids.students[2], ids.courseA, ids.advice.middle, true);
    expect(await titles(ids.courseA, "helpful")).toEqual(["oldest", "middle", "newest"]);
    // middle and oldest tie at 2: the newer one (middle) comes first.
    await setAdviceHelpful(ids.students[3], ids.courseA, ids.advice.middle, true);
    expect(await titles(ids.courseA, "helpful")).toEqual(["middle", "oldest", "newest"]);
    // An undo moves it back.
    await setAdviceHelpful(ids.students[3], ids.courseA, ids.advice.middle, false);
    expect(await titles(ids.courseA, "helpful")).toEqual(["oldest", "middle", "newest"]);
  });

  it("never brings in removed advice or another course's advice, however many marks they have", async () => {
    for (const student of ids.students) await setAdviceHelpful(student, ids.courseB, ids.advice.other, true);
    await db.adviceVote.create({ data: { adviceId: ids.advice.removed, userId: ids.students[0] } });
    const shown = await titles(ids.courseA, "helpful");
    expect(shown).not.toContain("other");
    expect(shown).not.toContain("removed");
    expect(await titles(ids.courseB, "helpful")).toEqual(["other"]);
  });
});
