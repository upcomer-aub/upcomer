import { createHash, randomBytes } from "node:crypto";
import type { LoadContext, Scenario } from "../scenario";

// US-38 load: logged-in students open a course's advice feed while the course holds 500 pieces of advice of every scope
// (a tenth anonymous, a tenth removed). Everything is deleted afterwards; deleting the course deletes its advice.
// Every user shares one session, so the per-student read limit (DoS protection) is raised for the run. The feed cache is on
// (30 s); run with ADVICE_FEED_CACHE_SECONDS=0 to measure every request reading the database.

const ADVICE = 500;
const ids = (ctx: LoadContext) => ({
  faculty: `${ctx.stamp}-faculty`, course: `${ctx.stamp}-course`, student: `${ctx.stamp}-student`, term: `${ctx.stamp}-term`,
  paper: `${ctx.stamp}-paper`, group: `${ctx.stamp}-group`, session: `${ctx.stamp}-session`,
});
const SCOPES = ["COURSE", "EXAM", "SESSION", "TOPIC", "QUESTION"] as const;

const scenario: Scenario = {
  description: `Students open /courses/<id>/advice (page 1, 20 of ${ADVICE} pieces of advice of every scope; feed cache ${process.env.ADVICE_FEED_CACHE_SECONDS === "0" ? "off" : "on"}).`,
  stages: [1, 10, 25, 50, 100],
  serverEnv: { ADVICE_FEED_RATE_LIMIT_PER_MINUTE: "1000000" },
  async setup(ctx) {
    const id = ids(ctx);
    await ctx.db.faculty.create({ data: { id: id.faculty, code: ctx.stamp.toUpperCase().slice(0, 18) + "F", name: "Load Test Faculty" } });
    await ctx.db.course.create({ data: { id: id.course, code: ctx.stamp.toUpperCase().slice(0, 18) + "C", name: "Load Test Course", facultyId: id.faculty } });
    await ctx.db.term.create({ data: { id: id.term, name: `Load Term ${ctx.stamp}` } });
    await ctx.db.user.create({ data: { id: id.student, email: `${ctx.stamp}@load.upcomer.test`, name: "Load Student", passwordHash: "not-a-login" } });
    await ctx.db.courseFile.create({ data: {
      id: id.paper, courseId: id.course, title: "Load Final", category: "EXAM", examType: "FINAL", year: 2024,
      originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf",
    } });
    await ctx.db.questionGroup.create({ data: { id: id.group, courseId: id.course, text: "Load question?", normalizedText: `load ${ctx.stamp}`, paperCount: 1, rank: 1 } });
    const start = Date.now() - ADVICE * 60_000;
    await ctx.db.advice.createMany({
      data: Array.from({ length: ADVICE }, (_, index) => {
        const scope = SCOPES[index % SCOPES.length];
        return {
          id: `${ctx.stamp}-advice-${index}`, courseId: id.course, authorId: id.student, body: `Load advice ${index}. `.repeat(10),
          anonymous: index % 10 === 0, status: index % 10 === 5 ? "REMOVED" as const : "VISIBLE" as const, scope,
          fileId: scope === "EXAM" ? id.paper : null, termId: scope === "SESSION" ? id.term : null,
          topic: scope === "TOPIC" ? "Routing" : null, questionGroupId: scope === "QUESTION" ? id.group : null,
          resourceUrl: index % 3 === 0 ? "https://example.com/notes" : null, createdAt: new Date(start + index * 60_000),
        };
      }),
    });
    // A session created the same way login does (only the token's hash is stored).
    const token = randomBytes(32).toString("hex");
    await ctx.db.session.create({ data: {
      id: id.session, userId: id.student, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } });
    return { method: "GET", path: `/courses/${id.course}/advice`, headers: { cookie: `upcomer_session=${token}` } };
  },
  async teardown(ctx) {
    const id = ids(ctx);
    await ctx.db.course.deleteMany({ where: { id: id.course } });
    await ctx.db.faculty.deleteMany({ where: { id: id.faculty } });
    await ctx.db.term.deleteMany({ where: { id: id.term } });
    // Deleting the student deletes the session.
    await ctx.db.user.deleteMany({ where: { id: id.student } });
  },
};

export default scenario;
