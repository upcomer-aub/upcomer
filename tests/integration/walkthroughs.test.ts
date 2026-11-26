import { randomUUID } from "node:crypto";
import { FileCategory, FileStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// US-51 against a real, migrated database (the local test database, never the shared one), with the AI client mocked: no
// test here calls DeepSeek. Only a question of a published exam paper of the course is accepted; a walkthrough is stored
// once and then read without calling the AI; invalid answers are never stored; parallel clicks share one call and one row;
// a corrected question text gets a new walkthrough; deleting a question deletes its walkthroughs. Every record is created
// with a unique suffix and deleted in afterAll.

const ai = vi.hoisted(() => ({ chatCompletion: vi.fn(), isAiConfigured: vi.fn(() => true) }));
vi.mock("@/lib/ai-client", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/ai-client")>();
  return {
    ...ai,
    runAiPrompt: (prompt: Parameters<typeof actual.runAiPrompt>[0], input: unknown) =>
      actual.runAiPrompt(prompt, input, {}, ai.chatCompletion),
  };
});

import { getConsolidatedExam } from "@/lib/consolidated-exam";
import { db } from "@/lib/db";
import { createMockExam, getMockExam } from "@/lib/mock-exams";
import { rebuildQuestionBank } from "@/lib/question-bank";
import { resetRateLimits } from "@/lib/rate-limit";
import { WALKTHROUGH_PROMPT_VERSION } from "@/lib/walkthrough-rules";
import { generateWalkthrough, getWalkthroughPage, questionTextHash, resetWalkthroughCalls } from "@/lib/walkthroughs";

const run = randomUUID().slice(0, 8);
const ids = { faculty: "", course: "", otherCourse: "", student: "", other: "", published: "", pending: "", material: "", otherCourseQuestion: "" };
const TEXT = "Explain how the TCP three way handshake establishes a connection";
const goodAnswer = () => ({
  ok: true, model: "deepseek-flash",
  content: "```json\n" + JSON.stringify({ steps: [
    { title: "Read what is asked", explanation: "The question asks how a connection is set up.", basis: "question", quote: "three way handshake establishes a connection" },
    { title: "Recall the segments", explanation: "SYN, then SYN-ACK, then ACK.", basis: "method", quote: "" },
    { title: "State what is assumed", explanation: "No packet loss is assumed.", basis: "assumption", quote: "" },
  ] }) + "\n```",
});
const rows = (questionId: string) => db.questionWalkthrough.findMany({ where: { questionId }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  const faculty = await db.faculty.create({ data: { code: `WF${run}`, name: `Faculty ${run}` } });
  const [course, otherCourse] = await Promise.all(["A", "B"].map(letter =>
    db.course.create({ data: { code: `WT${letter}${run}`, name: `Walkthrough course ${letter}`, facultyId: faculty.id } })));
  const [student, other] = await Promise.all(["student", "other"].map(name =>
    db.user.create({ data: { email: `walk-${name}-${run}@example.com`, passwordHash: "x", name: `Walk ${name} ${run}` } })));
  const paper = (courseId: string, title: string, over: { status?: FileStatus; category?: FileCategory } = {}) => db.courseFile.create({
    data: { courseId, title: `${title} ${run}`, originalFileName: `${title}.pdf`, storageKey: `test/${run}/${title}`, category: over.category ?? FileCategory.EXAM, status: over.status ?? FileStatus.PUBLISHED, year: 2025, topic: "TCP" },
  });
  const question = async (fileId: string, text: string) => (await db.question.create({ data: { fileId, number: 1, text } })).id;
  const [published, pending, material, otherPaper] = await Promise.all([
    paper(course.id, "Final"), paper(course.id, "Pending", { status: FileStatus.PENDING }), paper(course.id, "Notes", { category: FileCategory.MATERIAL }), paper(otherCourse.id, "Other final"),
  ]);
  Object.assign(ids, {
    faculty: faculty.id, course: course.id, otherCourse: otherCourse.id, student: student.id, other: other.id,
    published: await question(published.id, TEXT), pending: await question(pending.id, "Explain slow start in TCP congestion control"),
    material: await question(material.id, "Explain the sliding window protocol"), otherCourseQuestion: await question(otherPaper.id, "Explain DNS caching"),
  });
});

beforeEach(() => {
  resetRateLimits();
  resetWalkthroughCalls();
  ai.chatCompletion.mockReset().mockResolvedValue(goodAnswer());
});

afterAll(async () => {
  await db.course.deleteMany({ where: { id: { in: [ids.course, ids.otherCourse].filter(Boolean) } } });
  await db.user.deleteMany({ where: { id: { in: [ids.student, ids.other].filter(Boolean) } } });
  if (ids.faculty) await db.faculty.deleteMany({ where: { id: ids.faculty } });
  await db.$disconnect();
});

describe("US-51 walkthroughs on the real database", () => {
  it("refuses a question of another course, of an unpublished paper, or of a material, without calling the AI", async () => {
    expect(await generateWalkthrough(ids.student, ids.course, ids.otherCourseQuestion)).toEqual({ ok: false, error: "not_found" });
    expect(await generateWalkthrough(ids.student, ids.otherCourse, ids.published)).toEqual({ ok: false, error: "not_found" });
    expect(await generateWalkthrough(ids.student, ids.course, ids.pending)).toEqual({ ok: false, error: "not_found" });
    expect(await generateWalkthrough(ids.student, ids.course, ids.material)).toEqual({ ok: false, error: "not_found" });
    expect(await generateWalkthrough(ids.student, ids.course, `missing-${run}`)).toEqual({ ok: false, error: "not_found" });
    expect(await getWalkthroughPage(ids.student, ids.course, ids.pending)).toBeNull();
    expect(await getWalkthroughPage(ids.student, ids.otherCourse, ids.published)).toBeNull();
    expect(ai.chatCompletion).not.toHaveBeenCalled();
  });

  it("never stores an invalid answer", async () => {
    ai.chatCompletion.mockResolvedValueOnce({ ok: true, model: "m", content: "Sure! Step 1: ..." });
    ai.chatCompletion.mockResolvedValueOnce({ ok: false, error: "truncated" });
    ai.chatCompletion.mockResolvedValueOnce({ ok: true, model: "m", content: JSON.stringify({ steps: [{ title: "only one", explanation: "x", basis: "method", quote: "" }] }) });
    for (let i = 0; i < 3; i++) expect(await generateWalkthrough(ids.student, ids.course, ids.published)).toEqual({ ok: false, error: "invalid_output" });
    expect(await rows(ids.published)).toEqual([]);
    expect((await getWalkthroughPage(ids.student, ids.course, ids.published))?.walkthrough).toBeNull();
  });

  it("stores one checked walkthrough, then serves it to everyone without calling the AI", async () => {
    expect(await generateWalkthrough(ids.student, ids.course, ids.published)).toEqual({ ok: true, stored: false });
    expect(await generateWalkthrough(ids.other, ids.course, ids.published)).toEqual({ ok: true, stored: true });
    expect(ai.chatCompletion).toHaveBeenCalledTimes(1);
    const [row] = await rows(ids.published);
    expect(row).toMatchObject({ textHash: questionTextHash(TEXT), promptVersion: WALKTHROUGH_PROMPT_VERSION, model: "deepseek-flash" });
    const page = await getWalkthroughPage(ids.other, ids.course, ids.published);
    expect(page?.walkthrough?.steps.map(step => [step.basis, step.verified, step.unverifiedReason])).toEqual([
      ["question", true, null], ["method", false, "method"], ["assumption", false, "assumption"],
    ]);
    // Only the checked steps are stored: no raw answer, fence or reasoning.
    expect(JSON.stringify(row.steps)).not.toContain("```");
    expect(Object.keys(row)).not.toContain("content");
  });

  it("parallel clicks by two students share one call and one row", async () => {
    await db.questionWalkthrough.deleteMany({ where: { questionId: ids.published } });
    let release!: (value: unknown) => void;
    ai.chatCompletion.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const clicks = [generateWalkthrough(ids.student, ids.course, ids.published), generateWalkthrough(ids.other, ids.course, ids.published), generateWalkthrough(ids.other, ids.course, ids.published)];
    await vi.waitFor(() => expect(ai.chatCompletion).toHaveBeenCalledTimes(1));
    release(goodAnswer());
    expect((await Promise.all(clicks)).every(result => result.ok)).toBe(true);
    expect(ai.chatCompletion).toHaveBeenCalledTimes(1);
    expect(await rows(ids.published)).toHaveLength(1);
  });

  it("two server processes saving the same walkthrough keep one row", async () => {
    await db.questionWalkthrough.deleteMany({ where: { questionId: ids.published } });
    const releases: Array<(value: unknown) => void> = [];
    ai.chatCompletion.mockImplementation(() => new Promise(resolve => { releases.push(resolve); }));
    const first = generateWalkthrough(ids.student, ids.course, ids.published);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    // Another process does not see this one's call in progress.
    resetWalkthroughCalls();
    const second = generateWalkthrough(ids.other, ids.course, ids.published);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.forEach(release => release(goodAnswer()));
    expect(await Promise.all([first, second])).toEqual([{ ok: true, stored: false }, { ok: true, stored: false }]);
    expect(await rows(ids.published)).toHaveLength(1);
  });

  it("a corrected question text gets a new walkthrough; the old one is no longer shown", async () => {
    expect(await rows(ids.published)).toHaveLength(1);
    const corrected = `${TEXT} between a client and a server`;
    await db.question.update({ where: { id: ids.published }, data: { text: corrected, textCorrectedAt: new Date() } });
    try {
      const page = await getWalkthroughPage(ids.student, ids.course, ids.published);
      expect(page?.question.text).toBe(corrected);
      expect(page?.walkthrough).toBeNull();
      expect(await generateWalkthrough(ids.student, ids.course, ids.published)).toEqual({ ok: true, stored: false });
      expect(ai.chatCompletion).toHaveBeenCalledTimes(1);
      const stored = await rows(ids.published);
      expect(stored.map(row => row.textHash)).toEqual([questionTextHash(TEXT), questionTextHash(corrected)]);
    } finally {
      await db.question.update({ where: { id: ids.published }, data: { text: TEXT, textCorrectedAt: null } });
    }
    // Back to the original text: the original walkthrough is shown again, with no new call.
    expect((await getWalkthroughPage(ids.student, ids.course, ids.published))?.walkthrough).not.toBeNull();
  });

  it("the per-student limit counts real calls only", async () => {
    process.env.WALKTHROUGH_RATE_LIMIT_PER_HOUR = "1";
    try {
      // Stored walkthrough: no call, no count.
      for (let i = 0; i < 3; i++) expect(await generateWalkthrough(ids.student, ids.course, ids.published)).toEqual({ ok: true, stored: true });
      const second = await db.question.create({ data: { fileId: (await db.question.findUniqueOrThrow({ where: { id: ids.published } })).fileId, number: 2, text: "Describe how TCP flow control uses the receive window" } });
      ai.chatCompletion.mockResolvedValue({ ok: false, error: "timeout" });
      expect(await generateWalkthrough(ids.student, ids.course, second.id)).toEqual({ ok: false, error: "timeout" });
      expect(await generateWalkthrough(ids.student, ids.course, second.id)).toEqual({ ok: false, error: "rate_limited" });
      expect(ai.chatCompletion).toHaveBeenCalledTimes(1);
      expect(await rows(second.id)).toEqual([]);
    } finally {
      delete process.env.WALKTHROUGH_RATE_LIMIT_PER_HOUR;
    }
  });

  it("every Upcomer Exam card links a question the walkthrough page accepts (step 6a)", async () => {
    expect(await rebuildQuestionBank(ids.course)).toMatchObject({ ok: true });
    const exam = await getConsolidatedExam(ids.course);
    expect(exam.questions.length).toBeGreaterThan(0);
    for (const item of exam.questions) {
      expect(item.sourceQuestionId).toBeTruthy();
      const page = await getWalkthroughPage(ids.student, ids.course, item.sourceQuestionId!);
      expect(page?.question.id).toBe(item.sourceQuestionId);
    }
    // The pending paper's and the material's questions are never linked.
    const linked = exam.questions.map(item => item.sourceQuestionId);
    expect(linked).not.toContain(ids.pending);
    expect(linked).not.toContain(ids.material);
  });

  it("refuses a question excluded from the bank, and the Upcomer Exam never links one", async () => {
    const fileId = (await db.question.findUniqueOrThrow({ where: { id: ids.published } })).fileId;
    // A second copy of the published question, so it would share its group if it were not excluded.
    const excluded = await db.question.create({ data: { fileId, number: 9, text: TEXT, excludedFromBank: true } });
    try {
      expect(await rebuildQuestionBank(ids.course)).toMatchObject({ ok: true });
      expect(await generateWalkthrough(ids.student, ids.course, excluded.id)).toEqual({ ok: false, error: "not_found" });
      expect(await getWalkthroughPage(ids.student, ids.course, excluded.id)).toBeNull();
      expect(ai.chatCompletion).not.toHaveBeenCalled();
      expect(await rows(excluded.id)).toEqual([]);
      const linked = (await getConsolidatedExam(ids.course)).questions.map(item => item.sourceQuestionId);
      expect(linked).not.toContain(excluded.id);
      expect(linked).toContain(ids.published);
    } finally {
      await db.question.delete({ where: { id: excluded.id } });
    }
  });

  it("a submitted mock exam gives each past-paper question's source, which the walkthrough page accepts (6b)", async () => {
    const fileId = (await db.question.findUniqueOrThrow({ where: { id: ids.published } })).fileId;
    // Three more distinct questions of their own, so the course has enough for a 3-question exam whatever ran before.
    const extra = await Promise.all(["Explain how DNS caching reduces lookup time", "State the purpose of an MX record", "Describe iterative DNS resolution"]
      .map((text, index) => db.question.create({ data: { fileId, number: 20 + index, text } })));
    try {
      expect(await rebuildQuestionBank(ids.course)).toMatchObject({ ok: true });
      process.env.MOCK_EXAM_RATE_LIMIT_PER_HOUR = "1000";
      const created = await createMockExam(ids.student, { courseId: ids.course, length: "3", difficulty: "MIXED", topics: [] });
      if (!created.ok) throw new Error(`mock exam not created: ${created.error}`);
      const exam = await getMockExam(ids.student, created.id);
      expect(exam?.questions.length).toBe(3);
      for (const item of exam!.questions) {
        expect(item.questionId).toBeTruthy();
        expect((await getWalkthroughPage(ids.student, ids.course, item.questionId!))?.question.id).toBe(item.questionId);
      }
    } finally {
      await db.question.deleteMany({ where: { id: { in: extra.map(question => question.id) } } });
      delete process.env.MOCK_EXAM_RATE_LIMIT_PER_HOUR;
    }
  });

  it("deleting the question deletes its walkthroughs", async () => {
    const question = await db.question.create({ data: { fileId: (await db.question.findUniqueOrThrow({ where: { id: ids.published } })).fileId, number: 3, text: "Explain the purpose of the TCP checksum field" } });
    expect(await generateWalkthrough(ids.student, ids.course, question.id)).toEqual({ ok: true, stored: false });
    expect(await rows(question.id)).toHaveLength(1);
    await db.question.delete({ where: { id: question.id } });
    expect(await rows(question.id)).toEqual([]);
  });
});
