import { adminSession, type LoadContext, type Scenario } from "../scenario";

// Question corrections load: admins open a large course's correction page (/admin/questions/<course>): the first 20 of
// 200 question groups with their questions, and a full activity log of 50 corrections. The papers point at a seeded
// fixture, so no file is written. Everything is deleted afterwards.

const PAPERS = 40;
const GROUPS = 200;
const QUESTIONS_PER_PAPER = 25;
let session: Awaited<ReturnType<typeof adminSession>> | undefined;
const ids = (ctx: LoadContext) => ({ faculty: `${ctx.stamp}-faculty`, course: `${ctx.stamp}-course` });

const scenario: Scenario = {
  description: `Admins open the question corrections page of a course with ${PAPERS} papers, ${PAPERS * QUESTIONS_PER_PAPER} questions in ${GROUPS} groups, and 50 logged corrections.`,
  stages: [1, 10, 25, 50, 100],
  async setup(ctx) {
    const { faculty, course } = ids(ctx);
    await ctx.db.faculty.create({ data: { id: faculty, code: ctx.stamp.toUpperCase().slice(0, 18) + "F", name: "Load Test Faculty" } });
    await ctx.db.course.create({ data: { id: course, code: ctx.stamp.toUpperCase().slice(0, 18) + "C", name: "Load Test Course", facultyId: faculty } });
    // Group g holds the question "Explain load concept g"; the most frequent groups come first, as the rebuild would rank them.
    await ctx.db.questionGroup.createMany({
      data: Array.from({ length: GROUPS }, (_, index) => ({
        id: `${ctx.stamp}-group-${index}`, courseId: course, text: `Explain load concept ${index}.`, normalizedText: `explain load concept ${index}`,
        paperCount: Math.max(1, PAPERS - Math.floor(index / 5)), rank: index + 1,
      })),
    });
    await ctx.db.courseFile.createMany({
      data: Array.from({ length: PAPERS }, (_, index) => ({
        id: `${ctx.stamp}-paper-${index}`, courseId: course, title: `Load Paper ${index + 1}`, category: "EXAM" as const, year: 2000 + (index % 25),
        originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf",
      })),
    });
    await ctx.db.question.createMany({
      data: Array.from({ length: PAPERS }, (_, paper) => Array.from({ length: QUESTIONS_PER_PAPER }, (_, number) => {
        const group = (paper * 7 + number * 8) % GROUPS;
        return { fileId: `${ctx.stamp}-paper-${paper}`, number: number + 1, text: `${number + 1}. Explain load concept ${group}.`, groupId: `${ctx.stamp}-group-${group}` };
      })).flat(),
    });
    session = await adminSession(ctx.db);
    await ctx.db.questionCorrection.createMany({
      data: Array.from({ length: 50 }, (_, index) => ({
        courseId: course, adminId: session!.adminId, kind: "EDIT_TEXT" as const, paperTitle: `Load Paper ${index + 1}`, questionNumber: 1,
        before: `1. Explian load concept ${index}.`, after: `1. Explain load concept ${index}.`,
      })),
    });
    return { method: "GET", path: `/admin/questions/${course}`, headers: { cookie: session.cookie } };
  },
  async teardown(ctx) {
    const { faculty, course } = ids(ctx);
    // Deleting the course deletes its papers, questions, groups, and correction log.
    await ctx.db.course.deleteMany({ where: { id: course } });
    await ctx.db.faculty.deleteMany({ where: { id: faculty } });
    if (session) await ctx.db.session.deleteMany({ where: { id: session.sessionId } });
  },
};

export default scenario;
