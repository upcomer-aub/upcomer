import { createHash, randomBytes } from "node:crypto";
import type { LoadContext, Scenario } from "../scenario";

// US-36 load: logged-in students open the edit page of their own advice, in a course holding 500 pieces of advice (50 of
// them theirs). Each request checks the session and reads the one advice by its ID and its author, so this measures that
// read under load. The saves themselves are POST server actions that answer with a redirect, which this runner counts as
// an error, so they are measured by `npm run availability` instead (the "POST edit own advice" API, with its outcome
// checked). Everything is deleted afterwards; deleting the course deletes its advice.

const ADVICE = 500;
const ids = (ctx: LoadContext) => ({
  faculty: `${ctx.stamp}-faculty`, course: `${ctx.stamp}-course`, student: `${ctx.stamp}-student`, other: `${ctx.stamp}-other`, session: `${ctx.stamp}-session`,
});

const scenario: Scenario = {
  description: `Students open the edit page of their own advice (/courses/<id>/advice/<adviceId>/edit) in a course with ${ADVICE} pieces of advice.`,
  stages: [1, 10, 25, 50, 100],
  async setup(ctx) {
    const id = ids(ctx);
    await ctx.db.faculty.create({ data: { id: id.faculty, code: ctx.stamp.toUpperCase().slice(0, 18) + "F", name: "Load Test Faculty" } });
    await ctx.db.course.create({ data: { id: id.course, code: ctx.stamp.toUpperCase().slice(0, 18) + "C", name: "Load Test Course", facultyId: id.faculty } });
    await ctx.db.user.createMany({ data: [
      { id: id.student, email: `${ctx.stamp}@load.upcomer.test`, name: "Load Student", passwordHash: "not-a-login" },
      { id: id.other, email: `${ctx.stamp}-other@load.upcomer.test`, name: "Other Load Student", passwordHash: "not-a-login" },
    ] });
    await ctx.db.advice.createMany({
      data: Array.from({ length: ADVICE }, (_, index) => ({
        id: `${ctx.stamp}-advice-${index}`, courseId: id.course, authorId: index % 10 === 0 ? id.student : id.other,
        body: `Load advice ${index}. `.repeat(10), anonymous: index % 20 === 0, createdAt: new Date(Date.now() - (ADVICE - index) * 60_000),
      })),
    });
    // A session created the same way login does (only the token's hash is stored).
    const token = randomBytes(32).toString("hex");
    await ctx.db.session.create({ data: {
      id: id.session, userId: id.student, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } });
    return { method: "GET", path: `/courses/${id.course}/advice/${ctx.stamp}-advice-250/edit`, headers: { cookie: `upcomer_session=${token}` } };
  },
  async teardown(ctx) {
    const id = ids(ctx);
    await ctx.db.course.deleteMany({ where: { id: id.course } });
    await ctx.db.faculty.deleteMany({ where: { id: id.faculty } });
    // Deleting the students deletes the session.
    await ctx.db.user.deleteMany({ where: { id: { in: [id.student, id.other] } } });
  },
};

export default scenario;
