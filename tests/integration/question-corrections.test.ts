import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Question corrections against a real database, with papers uploaded through the real upload route, so extraction,
// processing runs, grouping, and ranking are the real pipeline. Only the admin session is faked.

const { getAdminUser } = vi.hoisted(() => ({ getAdminUser: vi.fn() }));
vi.mock("@/lib/auth", async original => ({ ...(await original<typeof import("@/lib/auth")>()), getAdminUser }));

import { POST as upload } from "@/app/api/admin/uploads/route";
import { getConsolidatedExam } from "@/lib/consolidated-exam";
import { db } from "@/lib/db";
import { processExamFile } from "@/lib/exam-processing";
import { getQuestionBank, rebuildQuestionBank } from "@/lib/question-bank";
import { correctQuestion, getCorrectionPage, getQuestionCorrection } from "@/lib/question-corrections";
import { resetRateLimits } from "@/lib/rate-limit";
import { linesPdf } from "./fixtures/layout-pdf";

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const faculty = { id: `it-qc-faculty-${stamp}`, code: `IQF${stamp}`.toUpperCase().slice(0, 20), name: "Corrections Faculty" };
const admins = [`it-qc-admin1-${stamp}`, `it-qc-admin2-${stamp}`];
const courseIds: string[] = [];
let root: string;
const originalRoot = process.env.FILE_STORAGE_ROOT;

async function newCourse() {
  const course = await db.course.create({ data: { id: `it-qc-course${courseIds.length}-${stamp}`, code: `IQ${courseIds.length}${stamp}`.toUpperCase().slice(0, 20), name: "Corrections Course", facultyId: faculty.id } });
  courseIds.push(course.id);
  return course.id;
}

// Uploads a typed exam through the real route; the upload extracts, groups, and ranks it.
async function uploadPaper(courseId: string, title: string, year: number, questions: string[]) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ category: "EXAM", courseId, title, year: String(year) })) form.set(key, value);
  form.set("file", new File([Buffer.from(linesPdf([questions]))], `${title}.pdf`, { type: "application/pdf" }));
  const response = await upload(new Request("http://localhost/api/admin/uploads", { method: "POST", body: form }));
  expect(response.status).toBe(201);
  const fileId = (await response.json()).file.id as string;
  expect((await db.question.findMany({ where: { fileId }, orderBy: { number: "asc" } })).map(question => question.text)).toEqual(questions);
  return fileId;
}

const questionAt = (fileId: string, number: number) => db.question.findUniqueOrThrow({ where: { fileId_number: { fileId, number } } });

// The course's groups as [text, paper count, rank, sorted "paper title #number" of their questions], in rank order.
async function groupsOf(courseId: string) {
  const bank = await getQuestionBank(courseId);
  const titles = new Map((await db.courseFile.findMany({ where: { courseId } })).map(file => [file.id, file.title]));
  return bank.groups.map(group => [group.text, group.paperCount, group.rank, group.questions.map(question => `${titles.get(question.fileId)} #${question.number}`).sort()]);
}

// Three papers: "Describe the seven OSI layers." is the OSI question in other words, so the automatic grouping misses it;
// paper C's "Explain TCP congestion control." is the same wording but a different question in context; paper A's third
// question was extracted with typos.
async function seededCourse() {
  const courseId = await newCourse();
  const a = await uploadPaper(courseId, "Paper A", 2024, ["1. Explain TCP congestion control.", "2. Define the OSI model.", "3. Explian TCP slow strat."]);
  const b = await uploadPaper(courseId, "Paper B", 2023, ["1. Explain TCP congestion control.", "2. Describe the seven OSI layers."]);
  const c = await uploadPaper(courseId, "Paper C", 2022, ["1. Explain TCP congestion control.", "2. Define the OSI model."]);
  return { courseId, a, b, c };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "upcomer-qc-"));
  process.env.FILE_STORAGE_ROOT = root;
  await db.faculty.create({ data: faculty });
  for (const [index, id] of admins.entries()) await db.user.create({ data: { id, email: `${id}@corrections.test`, name: `Corrections Admin ${index + 1}`, passwordHash: "x", role: "ADMIN" } });
});
afterAll(async () => {
  try {
    await db.course.deleteMany({ where: { id: { in: courseIds } } });
    await db.faculty.deleteMany({ where: { id: faculty.id } });
    await db.user.deleteMany({ where: { id: { in: admins } } });
  } finally {
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
    if (originalRoot === undefined) delete process.env.FILE_STORAGE_ROOT;
    else process.env.FILE_STORAGE_ROOT = originalRoot;
  }
});
beforeEach(() => {
  resetRateLimits();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  getAdminUser.mockReset().mockResolvedValue({ id: admins[0], role: "ADMIN" });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CORRECTION_RATE_LIMIT_PER_MINUTE;
});

describe("acceptance test 1: moving or splitting a wrongly grouped question updates the counts and ranking", () => {
  it("starts from the automatic grouping", async () => {
    const { courseId } = await seededCourse();
    expect(await groupsOf(courseId)).toEqual([
      ["Explain TCP congestion control.", 3, 1, ["Paper A #1", "Paper B #1", "Paper C #1"]],
      ["Define the OSI model.", 2, 2, ["Paper A #2", "Paper C #2"]],
      ["Explian TCP slow strat.", 1, 3, ["Paper A #3"]],
      ["Describe the seven OSI layers.", 1, 4, ["Paper B #2"]],
    ]);
  });

  it("moves a question into another group: the group gains a paper, the old group goes, and the ranks follow", async () => {
    const { courseId, b } = await seededCourse();
    const osi = (await getQuestionBank(courseId)).groups.find(group => group.text === "Define the OSI model.")!;
    expect(await correctQuestion(admins[0], courseId, { kind: "move", questionId: (await questionAt(b, 2)).id, groupId: osi.id })).toEqual({ ok: true, regrouped: true });
    expect(await groupsOf(courseId)).toEqual([
      ["Define the OSI model.", 3, 1, ["Paper A #2", "Paper B #2", "Paper C #2"]],
      ["Explain TCP congestion control.", 3, 2, ["Paper A #1", "Paper B #1", "Paper C #1"]],
      ["Explian TCP slow strat.", 1, 3, ["Paper A #3"]],
    ]);
    // The group keeps its ID, so links to it stay valid; students see the new count.
    const exam = await getConsolidatedExam(courseId);
    expect(exam.questions.find(question => question.id === osi.id)).toMatchObject({ paperCount: 3, position: 1 });
  });

  it("splits a question out: its old group loses a paper and it becomes its own group", async () => {
    const { courseId, c } = await seededCourse();
    expect(await correctQuestion(admins[0], courseId, { kind: "split", questionId: (await questionAt(c, 1)).id })).toEqual({ ok: true, regrouped: true });
    expect(await groupsOf(courseId)).toEqual([
      ["Define the OSI model.", 2, 1, ["Paper A #2", "Paper C #2"]],
      ["Explain TCP congestion control.", 2, 2, ["Paper A #1", "Paper B #1"]],
      ["Explian TCP slow strat.", 1, 3, ["Paper A #3"]],
      ["Describe the seven OSI layers.", 1, 4, ["Paper B #2"]],
      ["Explain TCP congestion control.", 1, 5, ["Paper C #1"]],
    ]);
  });

  it("undoes a move or a split, so the question is grouped by its text again", async () => {
    const { courseId, c } = await seededCourse();
    const before = await groupsOf(courseId);
    const questionId = (await questionAt(c, 1)).id;
    await correctQuestion(admins[0], courseId, { kind: "split", questionId });
    expect(await correctQuestion(admins[0], courseId, { kind: "reset", questionId })).toEqual({ ok: true, regrouped: true });
    expect(await groupsOf(courseId)).toEqual(before);
    expect(await db.question.findUniqueOrThrow({ where: { id: questionId } })).toMatchObject({ splitOut: false, pinnedToQuestionId: null });
  });

  it("moves a question back out of a group without taking the questions moved onto it", async () => {
    const { courseId, a, b } = await seededCourse();
    const bank = (await getQuestionBank(courseId)).groups;
    const typo = (await questionAt(a, 3)).id;
    // Paper B's OSI question goes into the typo group (anchored on the typo question), then the typo question is moved away.
    await correctQuestion(admins[0], courseId, { kind: "move", questionId: (await questionAt(b, 2)).id, groupId: bank.find(group => group.text.startsWith("Explian"))!.id });
    await correctQuestion(admins[0], courseId, { kind: "move", questionId: typo, groupId: bank.find(group => group.text.startsWith("Explain TCP"))!.id });
    const groups = await groupsOf(courseId);
    expect(groups.find(group => (group[3] as string[]).includes("Paper B #2"))).toEqual(["Describe the seven OSI layers.", 1, 3, ["Paper B #2"]]);
    expect(groups.find(group => (group[3] as string[]).includes("Paper A #3"))?.[0]).toBe("Explain TCP congestion control.");
  });
});

describe("acceptance test 2: editing a wrongly extracted question shows the corrected text to students", () => {
  it("replaces the text in the question bank and the ordered exam, and a fixed text regroups by its new wording", async () => {
    const { courseId, a } = await seededCourse();
    const question = await questionAt(a, 3);
    expect(await correctQuestion(admins[0], courseId, { kind: "edit", questionId: question.id, text: "3. Explain TCP slow start.", previousText: question.text })).toEqual({ ok: true, regrouped: true });
    const exam = await getConsolidatedExam(courseId);
    expect(exam.questions.map(item => item.text)).toContain("Explain TCP slow start.");
    expect(JSON.stringify(exam)).not.toContain("Explian");
    expect((await getQuestionBank(courseId, { query: "slow start" })).groups.map(group => group.text)).toEqual(["Explain TCP slow start."]);
    expect(await db.question.findUniqueOrThrow({ where: { id: question.id } })).toMatchObject({ text: "3. Explain TCP slow start." });
  });

  it("keeps several lines and stores them with plain line breaks", async () => {
    const { courseId, a } = await seededCourse();
    const question = await questionAt(a, 3);
    await correctQuestion(admins[0], courseId, { kind: "edit", questionId: question.id, text: "  3. Explain TCP slow start.\r\n(a) When does it end?  ", previousText: question.text });
    expect((await db.question.findUniqueOrThrow({ where: { id: question.id } })).text).toBe("3. Explain TCP slow start.\n(a) When does it end?");
  });
});

describe("acceptance test 3: corrections survive the pipeline running again and are in the activity log", () => {
  it("keeps every correction after reprocessing each paper, a manual regroup, and a new paper, and logs each one once", async () => {
    const { courseId, a, b, c } = await seededCourse();
    const bank = (await getQuestionBank(courseId)).groups;
    const typo = await questionAt(a, 3);
    await correctQuestion(admins[0], courseId, { kind: "edit", questionId: typo.id, text: "3. Explain TCP slow start.", previousText: typo.text });
    getAdminUser.mockResolvedValue({ id: admins[1], role: "ADMIN" });
    await correctQuestion(admins[1], courseId, { kind: "move", questionId: (await questionAt(b, 2)).id, groupId: bank.find(group => group.text === "Define the OSI model.")!.id });
    await correctQuestion(admins[1], courseId, { kind: "split", questionId: (await questionAt(c, 1)).id });
    const corrected = await groupsOf(courseId);

    // The pipeline again: each paper processed again, an admin's "Regroup and rank", and a new paper uploaded.
    for (const fileId of [a, b, c]) expect(await processExamFile(fileId)).toMatchObject({ ok: true });
    expect(await rebuildQuestionBank(courseId)).toMatchObject({ ok: true });
    expect(await groupsOf(courseId)).toEqual(corrected);
    await uploadPaper(courseId, "Paper D", 2025, ["1. Define the OSI model.", "2. Explain TCP slow start."]);
    // The new paper's copies join the corrected groups; slow start ties with TCP at 2 papers and wins on the newer paper.
    expect(await groupsOf(courseId)).toEqual([
      ["Define the OSI model.", 4, 1, ["Paper A #2", "Paper B #2", "Paper C #2", "Paper D #1"]],
      ["Explain TCP slow start.", 2, 2, ["Paper A #3", "Paper D #2"]],
      ["Explain TCP congestion control.", 2, 3, ["Paper A #1", "Paper B #1"]],
      ["Explain TCP congestion control.", 1, 4, ["Paper C #1"]],
    ]);
    expect((await questionAt(a, 3)).text).toBe("3. Explain TCP slow start.");

    const view = await getCorrectionPage(courseId);
    expect(view!.log.map(entry => [entry.kind, entry.admin?.name, entry.paperTitle, entry.questionNumber, entry.before, entry.after])).toEqual([
      ["SPLIT", "Corrections Admin 2", "Paper C", 1, "Explain TCP congestion control.", null],
      ["MOVE", "Corrections Admin 2", "Paper B", 2, "Describe the seven OSI layers.", "Define the OSI model."],
      ["EDIT_TEXT", "Corrections Admin 1", "Paper A", 3, "3. Explian TCP slow strat.", "3. Explain TCP slow start."],
    ]);
  });

  it("keeps the log after the question's paper is deleted, and a question moved onto it goes back to its own text", async () => {
    const { courseId, a, b, c } = await seededCourse();
    const osi = (await getQuestionBank(courseId)).groups.find(group => group.text === "Define the OSI model.")!;
    await correctQuestion(admins[0], courseId, { kind: "move", questionId: (await questionAt(b, 2)).id, groupId: osi.id });
    const anchor = (await db.question.findUniqueOrThrow({ where: { fileId_number: { fileId: b, number: 2 } } })).pinnedToQuestionId;
    const anchorPaper = (await db.question.findUniqueOrThrow({ where: { id: anchor! } })).fileId;
    expect([a, c]).toContain(anchorPaper);
    await db.courseFile.delete({ where: { id: anchorPaper } });
    await rebuildQuestionBank(courseId);
    // The other OSI paper is left, but the moved question was pinned to the deleted one, so it follows its own text again.
    expect((await groupsOf(courseId)).find(group => (group[3] as string[]).includes("Paper B #2"))?.[0]).toBe("Describe the seven OSI layers.");
    expect((await getCorrectionPage(courseId))!.log.map(entry => [entry.kind, entry.paperTitle])).toEqual([["MOVE", "Paper B"]]);
  });
});

describe("refusals", () => {
  it("refuses stale, empty, invisible, too long, and unchanged text, and changes nothing", async () => {
    const { courseId, a } = await seededCourse();
    const question = await questionAt(a, 3);
    const edit = (text: string, previousText = question.text) => correctQuestion(admins[0], courseId, { kind: "edit", questionId: question.id, text, previousText });
    expect(await edit("New text", "3. Some older text")).toEqual({ ok: false, error: "stale" });
    expect(await edit("   ")).toEqual({ ok: false, error: "text_required" });
    expect(await edit(String.fromCodePoint(0x200b, 0x3164, 0x2800))).toEqual({ ok: false, error: "text_required" });
    expect(await edit("x".repeat(2001))).toEqual({ ok: false, error: "text_too_long" });
    expect(await edit(`  ${question.text}  `)).toEqual({ ok: false, error: "text_unchanged" });
    expect(await db.question.findUniqueOrThrow({ where: { id: question.id } })).toMatchObject({ text: question.text, textCorrectedAt: null });
    expect(await db.questionCorrection.count({ where: { courseId } })).toBe(0);
  });

  it("refuses a question or group of another course, a move into its own group, a second split, and an undo with nothing to undo", async () => {
    const { courseId, a } = await seededCourse();
    const other = await seededCourse();
    const tcp = await questionAt(a, 1);
    const groups = (await getQuestionBank(courseId)).groups;
    const otherGroup = (await getQuestionBank(other.courseId)).groups[0];
    expect(await correctQuestion(admins[0], other.courseId, { kind: "split", questionId: tcp.id })).toEqual({ ok: false, error: "not_found" });
    expect(await correctQuestion(admins[0], courseId, { kind: "split", questionId: "no-such-question" })).toEqual({ ok: false, error: "not_found" });
    expect(await correctQuestion(admins[0], courseId, { kind: "move", questionId: tcp.id, groupId: otherGroup.id })).toEqual({ ok: false, error: "group_not_found" });
    expect(await correctQuestion(admins[0], courseId, { kind: "move", questionId: tcp.id, groupId: groups[0].id })).toEqual({ ok: false, error: "same_group" });
    expect(await correctQuestion(admins[0], courseId, { kind: "reset", questionId: tcp.id })).toEqual({ ok: false, error: "not_corrected" });
    await correctQuestion(admins[0], courseId, { kind: "split", questionId: tcp.id });
    expect(await correctQuestion(admins[0], courseId, { kind: "split", questionId: tcp.id })).toEqual({ ok: false, error: "already_split" });
    expect(await db.questionCorrection.count({ where: { courseId: { in: [courseId, other.courseId] } } })).toBe(1);
  });

  it("does not let an admin correct a question of a pending submission or a material", async () => {
    const courseId = await newCourse();
    const pending = await db.courseFile.create({ data: { courseId, title: "Pending", originalFileName: "p.pdf", storageKey: `qc/${stamp}/p.pdf`, category: "EXAM", status: "PENDING" } });
    const material = await db.courseFile.create({ data: { courseId, title: "Notes", originalFileName: "n.pdf", storageKey: `qc/${stamp}/n.pdf`, category: "MATERIAL" } });
    for (const file of [pending, material]) {
      const question = await db.question.create({ data: { fileId: file.id, number: 1, text: "1. Hidden question." } });
      expect(await correctQuestion(admins[0], courseId, { kind: "split", questionId: question.id })).toEqual({ ok: false, error: "not_found" });
      expect(await getQuestionCorrection(courseId, question.id)).toBeNull();
    }
  });

  it("limits each admin to the configured corrections per minute", async () => {
    process.env.CORRECTION_RATE_LIMIT_PER_MINUTE = "2";
    const { courseId, a, b } = await seededCourse();
    const split = async (fileId: string, number: number, admin = admins[0]) => correctQuestion(admin, courseId, { kind: "split", questionId: (await questionAt(fileId, number)).id });
    expect((await split(a, 1)).ok).toBe(true);
    expect((await split(a, 2)).ok).toBe(true);
    expect(await split(a, 3)).toEqual({ ok: false, error: "rate_limited" });
    expect((await split(b, 1, admins[1])).ok).toBe(true);
  });
});

describe("concurrency", () => {
  it("applies corrections from two admins at the same moment without losing any, and a rebuild after them changes nothing", async () => {
    const { courseId, a, b, c } = await seededCourse();
    const osi = (await getQuestionBank(courseId)).groups.find(group => group.text === "Define the OSI model.")!;
    const typo = await questionAt(a, 3);
    const results = await Promise.all([
      correctQuestion(admins[0], courseId, { kind: "edit", questionId: typo.id, text: "3. Explain TCP slow start.", previousText: typo.text }),
      correctQuestion(admins[1], courseId, { kind: "move", questionId: (await questionAt(b, 2)).id, groupId: osi.id }),
      correctQuestion(admins[0], courseId, { kind: "split", questionId: (await questionAt(c, 1)).id }),
      correctQuestion(admins[1], courseId, { kind: "edit", questionId: typo.id, text: "3. Explain slow start in TCP.", previousText: typo.text }),
    ]);
    // Both admins edited from the same text: exactly one edit wins and the other is told the text changed.
    expect(results.filter(result => result.ok)).toHaveLength(3);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, error: "stale" }]);
    const after = await groupsOf(courseId);
    expect(after.map(group => group.slice(0, 2))).toEqual(expect.arrayContaining([["Define the OSI model.", 3], ["Explain TCP congestion control.", 2], ["Explain TCP congestion control.", 1]]));
    await rebuildQuestionBank(courseId);
    expect(await groupsOf(courseId)).toEqual(after);
    expect(await db.questionCorrection.count({ where: { courseId } })).toBe(3);
  });
});

describe("the admin views", () => {
  it("pages the groups, finds questions by text, and returns null for an unknown course or question", async () => {
    const { courseId, a } = await seededCourse();
    const view = await getCorrectionPage(courseId, { page: 99 });
    expect(view).toMatchObject({ total: 4, page: 1, totalPages: 1, totalPapers: 3 });
    expect(view!.groups.map(group => group.rank)).toEqual([1, 2, 3, 4]);
    expect((await getCorrectionPage(courseId, { query: "osi" }))!.groups.map(group => group.text)).toEqual(["Define the OSI model.", "Describe the seven OSI layers."]);
    expect((await getCorrectionPage(courseId, { query: "%" }))!.groups).toEqual([]);
    expect(await getCorrectionPage("no-such-course")).toBeNull();
    const question = await getQuestionCorrection(courseId, (await questionAt(a, 1)).id);
    expect(question!.question.group).toMatchObject({ rank: 1, paperCount: 3 });
    expect(question!.groups).toHaveLength(4);
    expect(await getQuestionCorrection(courseId, "no-such-question")).toBeNull();
  });
});
