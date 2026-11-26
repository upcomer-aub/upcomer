import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateAiPracticeQuestions } from "@/lib/ai-practice";
import { db } from "@/lib/db";
import { reviewGeneratedRubric } from "@/lib/generated-rubrics";
import { generateMockAiFeedback } from "@/lib/mock-ai-feedback";
import { createMockExam, saveMockExam } from "@/lib/mock-exams";
import { markMockExam, saveAnswerKey } from "@/lib/mock-marking";
import { getMockResults } from "@/lib/mock-results";
import { getGeneratedPracticeQuestions } from "@/lib/practice-generation";
import { rebuildQuestionBank } from "@/lib/question-bank";
import { resetRateLimits } from "@/lib/rate-limit";
import { draftRubric, envelope, feedbackOutput, practiceOutput, requestData } from "../fixtures/shared-ai-provider";
import type { PracticePromptInput } from "@/lib/ai-practice-rules";
import type { MockFeedbackInput } from "@/lib/mock-ai-feedback-rules";

const run = randomUUID().slice(0, 8);
const courseCode = `AI${run}`;
const tcpText = "Explain why a TCP receiver checks sequence numbers before accepting duplicate segments.";
const settings = { difficulty: "MEDIUM", count: 2 } as const;
const keys = draftRubric.keyPoints.join("\n");
const ids = { faculty: "", course: "", student: "", other: "", admin: "", tcp: "", bankDuplicate: "" };
const fetcher = vi.fn<typeof fetch>();

function generate(userId = ids.student, count = 2) {
  return generateAiPracticeQuestions(userId, ids.course, { ...settings, count });
}

beforeAll(async () => {
  const faculty = await db.faculty.create({ data: { code: courseCode, name: `Faculty ${run}` } });
  ids.faculty = faculty.id;
  const course = await db.course.create({ data: { code: courseCode, name: "Practice Networks", facultyId: ids.faculty } });
  ids.course = course.id;
  for (const name of ["student", "other", "admin"] as const) {
    const user = await db.user.create({ data: { email: `${name}-ai-${run}@example.com`, passwordHash: "test", name, role: name === "admin" ? "ADMIN" : "STUDENT" } });
    ids[name] = user.id;
  }
  const paper = (title: string, topic: string, status: "PUBLISHED" | "PENDING", texts: string[]) => db.courseFile.create({
    data: {
      courseId: ids.course, title, category: "EXAM", topic, status, originalFileName: "exam.pdf", storageKey: `test/${run}/${title}`,
      questions: { create: texts.map((text, index) => ({ number: index + 1, text })) },
    }, include: { questions: { orderBy: { number: "asc" } } },
  });
  const tcp = await paper("TCP exam", "TCP", "PUBLISHED", [tcpText, "Calculate the initial congestion window for a TCP sender in slow start."]);
  const dns = await paper("DNS exam", "DNS", "PUBLISHED", ["Describe the difference between recursive and iterative DNS queries."]);
  await paper("Private paper", "TCP", "PENDING", ["Use PRIVATE UNPUBLISHED INFORMATION to describe a TCP header."]);
  ids.tcp = tcp.questions[0].id;
  ids.bankDuplicate = dns.questions[0].text;
  expect((await rebuildQuestionBank(ids.course)).ok).toBe(true);
  await db.learningTopic.create({ data: { userId: ids.student, courseId: ids.course, topicKey: "tcp", topic: "TCP", weakness: 0.9, confidence: 1 } });
});

beforeEach(() => {
  vi.stubEnv("AI_PRACTICE_GENERATION_ENABLED", "true");
  vi.stubEnv("AI_MOCK_FEEDBACK_ENABLED", "true");
  vi.stubEnv("DEEPSEEK_MODEL", "fake-model");
  vi.stubEnv("DEEPSEEK_API_KEY", "fake-unit-key");
  vi.stubEnv("DEEPSEEK_API_URL", "http://127.0.0.1:3219/chat/completions");
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset().mockImplementation(async (_url, options) => {
    const input = requestData(String(options?.body));
    return Response.json(envelope("sources" in input ? practiceOutput(input) : feedbackOutput(input)));
  });
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.course.deleteMany({ where: { id: ids.course } });
  await db.user.deleteMany({ where: { id: { in: [ids.student, ids.other, ids.admin] } } });
  await db.faculty.deleteMany({ where: { id: ids.faculty } });
  await db.$disconnect();
});

const review = (id: string, revision = "", keyPoints = keys, intent = "approve") =>
  reviewGeneratedRubric(ids.admin, { id, revision, keyPoints, intent, courseId: ids.course, explanation: draftRubric.explanation });

const assemble = async () => {
  const result = await createMockExam(ids.student, { courseId: ids.course, length: "3", difficulty: "MIXED", topics: ["tcp"], includeGenerated: true });
  if (!result.ok) throw new Error(result.error);
  const item = await db.mockExamQuestion.findFirstOrThrow({ where: { mockExamId: result.id, generatedQuestionId: { not: null } } });
  return { examId: result.id, itemId: item.id, generatedId: item.generatedQuestionId!, snapshot: item.generatedRubricSnapshot };
};

describe("shared AI workflows on PostgreSQL", () => {
  it("rejects a changed source while the provider is running and writes no partial batch", async () => {
    for (const index of [0, 1]) {
      let edited: { id: string; text: string } | undefined;
      fetcher.mockImplementationOnce(async (_url, options) => {
        const input: PracticePromptInput = requestData(String(options?.body));
        edited = await db.question.findUniqueOrThrow({ where: { id: input.sources[index].sourceRef }, select: { id: true, text: true } });
        await db.question.update({ where: { id: edited.id }, data: { text: "Describe how TCP validates retransmitted sequence numbers." } });
        return Response.json(envelope(practiceOutput(input)));
      });
      try {
        expect(await generate()).toMatchObject({ ok: false, error: "source_changed" });
        expect(await db.generatedPracticeQuestion.count({ where: { courseId: ids.course } })).toBe(0);
      } finally {
        if (edited) await db.question.update({ where: { id: edited.id }, data: { text: edited.text } });
      }
    }
  });

  it("rejects normalized duplicates elsewhere in the course bank and preserves separate feature switches", async () => {
    vi.stubEnv("AI_PRACTICE_GENERATION_ENABLED", "false");
    expect(await generate()).toMatchObject({ ok: false, error: "ai_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
    vi.stubEnv("AI_PRACTICE_GENERATION_ENABLED", "true");
    fetcher.mockImplementationOnce(async (_url, options) => {
      const input: PracticePromptInput = requestData(String(options?.body));
      const output = practiceOutput(input);
      output.questions[1].question = `Q9. ${ids.bankDuplicate.toUpperCase()} (2 marks)`;
      return Response.json(envelope(output));
    });
    expect(await generate()).toMatchObject({ ok: false, error: "insufficient_novel_questions" });
    expect(await db.generatedPracticeQuestion.count({ where: { courseId: ids.course } })).toBe(0);
  });

  it("saves one atomic batch under concurrent duplicates, limits the source scope, and keeps the library private", async () => {
    const results = await Promise.all([generate(), generate()]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, error: "insufficient_novel_questions" }]);
    const input = requestData(String(fetcher.mock.calls[0][1]?.body));
    expect(input.topics).toEqual([{ key: "tcp", label: "TCP" }]);
    expect(input.sources).toHaveLength(2);
    expect(JSON.stringify(input)).not.toMatch(/weakness|PRIVATE UNPUBLISHED INFORMATION/);
    const library = await getGeneratedPracticeQuestions(ids.student, ids.course);
    expect(library).toHaveLength(2);
    expect(library.every(item => item.rubricStatus === "DRAFT" && item.aiModel === "fake-model" && item.aiPromptVersion === "practice-v1")).toBe(true);
    expect(await getGeneratedPracticeQuestions(ids.other, ids.course)).toEqual([]);
    expect((await generate(ids.other, 2)).ok).toBe(true);
    expect(await getGeneratedPracticeQuestions(ids.other, ids.course)).toHaveLength(2);
    await db.generatedPracticeQuestion.deleteMany({ where: { courseId: ids.course } });
  });

  it("reviews a rubric, snapshots it at assembly, and leaves scores and evidence intact after AI failure", async () => {
    expect((await generate()).ok).toBe(true);
    fetcher.mockClear();
    const beforeReview = await assemble();
    expect(beforeReview.snapshot).toBeNull();
    const id = beforeReview.generatedId;
    const sourceId = (await db.generatedPracticeQuestion.findUniqueOrThrow({ where: { id } })).sourceQuestionId;
    await db.question.update({ where: { id: sourceId }, data: { excludedFromBank: true } });
    try {
      expect(await review(id)).toEqual({ ok: false, error: "source_changed" });
    } finally {
      await db.question.update({ where: { id: sourceId }, data: { excludedFromBank: false } });
    }
    expect(await review(id)).toEqual({ ok: true });
    const approved = await db.generatedPracticeQuestion.findUniqueOrThrow({ where: { id } });
    expect(approved).toMatchObject({ rubricStatus: "APPROVED", reviewedById: ids.admin });
    expect(approved.reviewedAt).not.toBeNull();
    const afterReview = await assemble();
    expect(afterReview.generatedId).toBe(id);
    expect(afterReview.snapshot).toEqual(draftRubric);
    expect(await review(id, approved.reviewedAt!.toISOString(), "", "reject")).toEqual({ ok: true });
    expect(await review(id)).toEqual({ ok: false, error: "stale_review" });
    expect((await db.generatedPracticeQuestion.findUniqueOrThrow({ where: { id } })).rubricStatus).toBe("REJECTED");

    for (const exam of [beforeReview, afterReview]) {
      expect((await saveMockExam(ids.student, exam.examId, { [exam.itemId]: "The receiver compares sequence numbers." }, true)).ok).toBe(true);
      expect((await markMockExam(ids.student, exam.examId)).ok).toBe(true);
    }
    const scored = await db.mockExamQuestion.findUniqueOrThrow({ where: { id: afterReview.itemId } });
    expect(scored).toMatchObject({ outcome: "PARTIAL", matchedPoints: ["sequence numbers"], missedPoints: ["duplicate segment"] });
    expect((await db.mockExamQuestion.findUniqueOrThrow({ where: { id: beforeReview.itemId } })).outcome).toBe("NO_KEY");
    const eventWhere = { userId: ids.student, eventId: `${afterReview.examId}:${afterReview.itemId}`, generatedQuestionId: id };
    expect(await db.learningEvent.count({ where: eventWhere })).toBe(1);
    await markMockExam(ids.student, afterReview.examId);
    expect(await db.learningEvent.count({ where: eventWhere })).toBe(1);

    const request = (userId = ids.student, consent = true, courseId = ids.course) =>
      generateMockAiFeedback(userId, courseId, afterReview.examId, afterReview.itemId, consent);
    vi.stubEnv("AI_MOCK_FEEDBACK_ENABLED", "false");
    expect(await request()).toEqual({ ok: false, error: "ai_unavailable" });
    vi.stubEnv("AI_MOCK_FEEDBACK_ENABLED", "true");
    const original = await getMockResults(ids.student, afterReview.examId);
    expect(original).toMatchObject({ ok: true, report: { marked: 1, credit: 0.5 } });
    expect(await request(ids.student, false)).toEqual({ ok: false, error: "ineligible" });
    expect(await request(ids.other)).toEqual({ ok: false, error: "ineligible" });
    expect(await request(ids.student, true, "wrong-course")).toEqual({ ok: false, error: "ineligible" });
    expect(await generateMockAiFeedback(ids.student, ids.course, beforeReview.examId, beforeReview.itemId, true)).toEqual({ ok: false, error: "ineligible" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await db.mockAiExplanation.count({ where: { mockExamQuestionId: afterReview.itemId } })).toBe(0);

    fetcher.mockResolvedValueOnce(new Response("invalid private response", { status: 503 }));
    expect(await request()).toEqual({ ok: false, error: "ai_failed" });
    expect(await getMockResults(ids.student, afterReview.examId)).toEqual(original);
    expect(await db.learningEvent.count({ where: eventWhere })).toBe(1);

    vi.stubEnv("AI_PRACTICE_GENERATION_ENABLED", "false");
    expect(await Promise.all([request(), request()])).toEqual([{ ok: true }, { ok: true }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const feedback: MockFeedbackInput = requestData(String(fetcher.mock.calls[1][1]?.body));
    expect(feedback).toEqual({
      question: scored.text, answer: scored.answer, rubric: draftRubric, matchedPoints: scored.matchedPoints, missedPoints: scored.missedPoints,
    });
    expect(await getMockResults(ids.student, afterReview.examId)).toMatchObject({
      ok: true, report: { marked: 1, credit: 0.5, missed: [expect.objectContaining({ feedback: scored.feedback, aiExplanation: feedbackOutput(feedback).explanation })] },
    });
    expect(await request()).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await db.mockAiExplanation.count({ where: { mockExamQuestionId: afterReview.itemId } })).toBe(1);
    expect(await db.mockExamQuestion.findUniqueOrThrow({ where: { id: afterReview.itemId } })).toEqual(scored);
  });

  it("limits practice calls per student", async () => {
    vi.stubEnv("AI_PRACTICE_RATE_LIMIT_PER_HOUR", "1");
    fetcher.mockResolvedValue(new Response(null, { status: 503 }));
    expect(await generate()).toEqual({ ok: false, error: "ai_failed" });
    expect(await generate()).toEqual({ ok: false, error: "ai_rate_limited" });
    expect(await generate(ids.other)).toEqual({ ok: false, error: "ai_failed" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses the original rubric for past-paper feedback, including legacy marks", async () => {
    const { groupId } = await db.question.findUniqueOrThrow({ where: { id: ids.tcp }, select: { groupId: true } });
    const saveKey = (keyPoints: string, explanation: string) =>
      saveAnswerKey(ids.admin, { courseId: ids.course, groupId: groupId!, keyPoints, explanation });
    expect((await saveKey(keys, draftRubric.explanation)).ok).toBe(true);
    const marked = [];
    for (const legacy of [false, true]) {
      const exam = await createMockExam(ids.student, { courseId: ids.course, length: "3", difficulty: "MIXED", topics: [] });
      if (!exam.ok) throw new Error(exam.error);
      const item = await db.mockExamQuestion.findFirstOrThrow({ where: { mockExamId: exam.id, groupId } });
      expect((await saveMockExam(ids.student, exam.id, { [item.id]: "Sequence numbers" }, true)).ok).toBe(true);
      expect((await markMockExam(ids.student, exam.id)).ok).toBe(true);
      if (legacy) await db.$executeRaw`UPDATE "MockExamQuestion" SET "markingRubric" = NULL WHERE "id" = ${item.id}`;
      marked.push({ examId: exam.id, itemId: item.id });
    }
    expect((await saveKey("packet header", "This is the new answer key.")).ok).toBe(true);
    vi.stubEnv("AI_PRACTICE_RATE_LIMIT_PER_HOUR", "1");
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(await generate()).toEqual({ ok: false, error: "ai_failed" });
    expect(await generate()).toEqual({ ok: false, error: "ai_rate_limited" });
    fetcher.mockClear();
    vi.stubEnv("AI_MOCK_FEEDBACK_RATE_LIMIT_PER_HOUR", "1");
    expect(await generateMockAiFeedback(ids.student, ids.course, marked[0].examId, marked[0].itemId, true)).toEqual({ ok: true });
    expect(await generateMockAiFeedback(ids.student, ids.course, marked[1].examId, marked[1].itemId, true)).toEqual({ ok: false, error: "ai_rate_limited" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    resetRateLimits();
    expect(await generateMockAiFeedback(ids.student, ids.course, marked[1].examId, marked[1].itemId, true)).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, options] of fetcher.mock.calls) {
      expect(requestData(String(options?.body))).toMatchObject({ rubric: draftRubric, matchedPoints: ["sequence numbers"], missedPoints: ["duplicate segment"] });
    }
  });
});
