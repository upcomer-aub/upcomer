import { createHash, randomBytes } from "node:crypto";
import type { LoadContext, Scenario } from "../scenario";

// US-49 load: a student opens their own marked 50-question mock exam (the largest allowed), each question with its
// outcome, covered and missed key points, and explanation. Marking itself happens once per exam, at submit, and is timed
// in the logs as "mock_exam_marking"; this measures reading the marked exam under load. Everything is deleted afterwards;
// deleting the course and the student deletes the exam.

const QUESTIONS = 50;
const OUTCOMES = ["CORRECT", "PARTIAL", "INCORRECT", "UNANSWERED", "NO_KEY"] as const;
const ids = (ctx: LoadContext) => ({
  faculty: `${ctx.stamp}-faculty`, course: `${ctx.stamp}-course`, student: `${ctx.stamp}-student`, session: `${ctx.stamp}-session`, exam: `${ctx.stamp}-exam`,
});

const scenario: Scenario = {
  description: `A student opens their own marked mock exam of ${QUESTIONS} questions (/courses/<id>/mock-exams/<mockExamId>).`,
  stages: [1, 10, 25, 50, 100],
  async setup(ctx) {
    const id = ids(ctx);
    await ctx.db.faculty.create({ data: { id: id.faculty, code: ctx.stamp.toUpperCase().slice(0, 18) + "F", name: "Load Test Faculty" } });
    await ctx.db.course.create({ data: { id: id.course, code: ctx.stamp.toUpperCase().slice(0, 18) + "C", name: "Load Test Course", facultyId: id.faculty } });
    await ctx.db.user.create({ data: { id: id.student, email: `${ctx.stamp}@load.upcomer.test`, name: "Load Student", passwordHash: "not-a-login" } });
    const now = new Date();
    await ctx.db.mockExam.create({ data: {
      id: id.exam, userId: id.student, courseId: id.course, topicKeys: [], topics: [], length: QUESTIONS, difficulty: "MIXED", status: "SUBMITTED", submittedAt: now, markedAt: now,
      questions: { create: Array.from({ length: QUESTIONS }, (_, index) => ({
        position: index + 1, text: `Load question ${index + 1}. `.repeat(8), paperCount: 2, totalPapers: 5, sourcePapers: ["Final (2024)", "Midterm (2023)"],
        answer: `Load answer ${index + 1}. `.repeat(20), answeredAt: now, markedAt: now, outcome: OUTCOMES[index % OUTCOMES.length],
        matchedPoints: ["first key point"], missedPoints: ["second key point", "third key point"],
        feedback: 'Your answer does not cover: "second key point"; "third key point".\n\nThe explanation of the answer key.',
      })) },
    } });
    // A session created the same way login does (only the token's hash is stored).
    const token = randomBytes(32).toString("hex");
    await ctx.db.session.create({ data: {
      id: id.session, userId: id.student, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } });
    return { method: "GET", path: `/courses/${id.course}/mock-exams/${id.exam}`, headers: { cookie: `upcomer_session=${token}` } };
  },
  async teardown(ctx) {
    const id = ids(ctx);
    await ctx.db.course.deleteMany({ where: { id: id.course } });
    await ctx.db.faculty.deleteMany({ where: { id: id.faculty } });
    await ctx.db.user.deleteMany({ where: { id: id.student } });
  },
};

export default scenario;
