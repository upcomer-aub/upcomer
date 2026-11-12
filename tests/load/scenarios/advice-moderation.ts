import { createHash, randomBytes } from "node:crypto";
import type { LoadContext, Scenario } from "../scenario";

// US-77 load: admins open the queue of reported advice (/admin/advice-reports) while 100 pieces of advice have open
// reports (300 reports in all, from 3 students each), so every request groups 300 reports and reads one page of 20
// advice. The decisions are POST server actions that answer with a redirect, which this runner counts as errors; they are
// covered by the integration and end-to-end tests. Everything is deleted afterwards; deleting the course deletes its
// advice and reports.

const ADVICE = 100;
const ids = (ctx: LoadContext) => ({
  faculty: `${ctx.stamp}-faculty`, course: `${ctx.stamp}-course`, admin: `${ctx.stamp}-admin`, author: `${ctx.stamp}-author`, session: `${ctx.stamp}-session`,
  students: [0, 1, 2].map(index => `${ctx.stamp}-student-${index}`),
});

const scenario: Scenario = {
  description: `Admins open /admin/advice-reports with ${ADVICE} reported pieces of advice (${ADVICE * 3} open reports).`,
  stages: [1, 10, 25, 50, 100],
  async setup(ctx) {
    const id = ids(ctx);
    await ctx.db.faculty.create({ data: { id: id.faculty, code: ctx.stamp.toUpperCase().slice(0, 18) + "F", name: "Load Test Faculty" } });
    await ctx.db.course.create({ data: { id: id.course, code: ctx.stamp.toUpperCase().slice(0, 18) + "C", name: "Load Test Course", facultyId: id.faculty } });
    await ctx.db.user.createMany({ data: [
      { id: id.admin, email: `${ctx.stamp}-admin@load.upcomer.test`, name: "Load Admin", passwordHash: "not-a-login", role: "ADMIN" as const },
      { id: id.author, email: `${ctx.stamp}-author@load.upcomer.test`, name: "Load Author", passwordHash: "not-a-login" },
      ...id.students.map((student, index) => ({ id: student, email: `${student}@load.upcomer.test`, name: `Load Student ${index}`, passwordHash: "not-a-login" })),
    ] });
    await ctx.db.advice.createMany({ data: Array.from({ length: ADVICE }, (_, index) => ({
      id: `${ctx.stamp}-advice-${index}`, courseId: id.course, authorId: id.author, anonymous: index % 2 === 0, body: `Reported load advice ${index}. `.repeat(5),
    })) });
    const reasons = ["OFFENSIVE", "SPAM", "OTHER"] as const;
    await ctx.db.adviceReport.createMany({ data: Array.from({ length: ADVICE }, (_, index) => id.students.map((reporterId, student) => ({
      adviceId: `${ctx.stamp}-advice-${index}`, courseId: id.course, reporterId, reason: reasons[student], note: student === 0 ? "Load note." : null,
      createdAt: new Date(Date.now() - (ADVICE - index) * 60_000 + student * 1_000),
    }))).flat() });
    // A session created the same way login does (only the token's hash is stored).
    const token = randomBytes(32).toString("hex");
    await ctx.db.session.create({ data: {
      id: id.session, userId: id.admin, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } });
    return { method: "GET", path: "/admin/advice-reports", headers: { cookie: `upcomer_session=${token}` } };
  },
  async teardown(ctx) {
    const id = ids(ctx);
    await ctx.db.course.deleteMany({ where: { id: id.course } });
    await ctx.db.faculty.deleteMany({ where: { id: id.faculty } });
    // Deleting the users deletes the session.
    await ctx.db.user.deleteMany({ where: { id: { in: [id.admin, id.author, ...id.students] } } });
  },
};

export default scenario;
