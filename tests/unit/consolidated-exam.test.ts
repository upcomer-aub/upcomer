import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ countFiles: vi.fn(), findFiles: vi.fn(), findGroups: vi.fn(), logError: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  courseFile: { count: mocks.countFiles, findMany: mocks.findFiles },
  questionGroup: { findMany: mocks.findGroups },
} }));
vi.mock("@/lib/logger", () => ({ logError: mocks.logError }));
// The real question bank service runs on the mocked database, so these tests also cover the hand-off from it.
import { fullQuestionText, getConsolidatedExam } from "@/lib/consolidated-exam";

const course = { id: "course-a", code: "EECE350", name: "Computer Networks" };
const paper = (id: string, year: number | null, term: string | null = "Fall") =>
  ({ id, title: `Exam ${id}`, year, examType: "FINAL", term: term ? { id: `term-${term}`, name: term } : null, professor: { id: "prof-a", name: "Professor A" } });
const papers = { p2023: paper("p2023", 2023, "Spring"), p2024: paper("p2024", 2024), p2025: paper("p2025", 2025), p2026: paper("p2026", 2026) };
type PaperId = keyof typeof papers;
// A group row as stored: its questions in paper then position order, each with its paper.
const group = (id: string, rank: number, text: string, sources: Array<[PaperId, number, string?]>) => ({
  id, rank, text, normalizedText: text.toLowerCase(), paperCount: new Set(sources.map(([fileId]) => fileId)).size, courseId: course.id, course,
  questions: sources.map(([fileId, number, raw], index) => ({ id: `${id}-q${index}`, number, text: raw ?? text, fileId, file: papers[fileId] })),
});
const stored = [
  group("g1", 1, "Explain the TCP three-way handshake.", [["p2023", 1, "Q1. Explain the TCP three-way handshake. (10 points)"], ["p2024", 2], ["p2025", 1], ["p2026", 4]]),
  // Repeated inside one paper: still one paper.
  group("g2", 2, "Define a socket.", [["p2024", 1], ["p2024", 5, "define a socket"], ["p2025", 3]]),
  group("g3", 3, "Consider the network below. (a) Find the subnet mask. (b) How many hosts fit?", [
    ["p2025", 2, "2. Consider the network below. (8 points)\n  (a) Find the subnet mask.\n\n  (b)   How many hosts fit?"],
  ]),
];
const coursePapers = (...ids: PaperId[]) => ids.map(id => ({ id }));

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.countFiles.mockResolvedValue(4);
  mocks.findFiles.mockResolvedValue(coursePapers("p2023", "p2024", "p2025", "p2026"));
  mocks.findGroups.mockResolvedValue(stored);
});

describe("fullQuestionText (US-18 sub-parts)", () => {
  it("keeps every sub-part on its own line and drops the number and marks of the question", () => {
    expect(fullQuestionText("2. Consider the network below. (8 points)\n  (a) Find the subnet mask.\n\n  (b)   How many hosts fit?"))
      .toBe("Consider the network below.\n(a) Find the subnet mask.\n(b) How many hosts fit?");
  });
  it("handles Windows line breaks, tabs and a first line that is only a number", () => {
    expect(fullQuestionText("Question 3\r\n(a)\tState Ohm's law.\r\n(b) Give its unit.")).toBe("(a) State Ohm's law.\n(b) Give its unit.");
    expect(fullQuestionText("1.\nExplain ARP.")).toBe("Explain ARP.");
  });
  it("leaves a one-line question as the grouping shows it, and an empty one empty", () => {
    expect(fullQuestionText("Q1. explain the TCP three-way  handshake")).toBe("explain the TCP three-way handshake");
    expect(fullQuestionText("  \n \n")).toBe("");
  });
});

describe("getConsolidatedExam", () => {
  it("lists every distinct question exactly once, in ranking order, numbered from 1 (US-18)", async () => {
    const exam = await getConsolidatedExam(course.id);
    expect(exam.questions.map(question => [question.position, question.rank, question.id])).toEqual([[1, 1, "g1"], [2, 2, "g2"], [3, 3, "g3"]]);
    expect(new Set(exam.questions.map(question => question.id)).size).toBe(exam.questions.length);
    expect(mocks.findGroups).toHaveBeenCalledWith(expect.objectContaining({ where: { courseId: course.id, questions: { some: { file: { status: "PUBLISHED" } } } }, orderBy: { rank: "asc" } }));
    expect(mocks.findFiles).toHaveBeenCalledWith({ where: { courseId: course.id, category: "EXAM", status: "PUBLISHED", questions: { some: { excludedFromBank: false, groupId: { not: null } } } }, select: { id: true } });
  });
  it("never lets a pending or rejected submission change X, Y, or the questions (US-13)", async () => {
    const before = await getConsolidatedExam(course.id);
    // A submitted paper that slipped into the stored groups: the published-only paper list (Y) leaves it out.
    const pending = paper("pending", 2027);
    const withPending = [
      { ...stored[0], paperCount: 5, questions: [...stored[0].questions, { id: "g1-pending", number: 1, text: stored[0].text, fileId: "pending", file: pending }] },
      stored[1], stored[2],
      { ...group("g4", 4, "A question only the pending paper has.", []), paperCount: 1, questions: [{ id: "g4-q0", number: 2, text: "A question only the pending paper has.", fileId: "pending", file: pending }] },
    ];
    mocks.findGroups.mockResolvedValue(withPending);
    const after = await getConsolidatedExam(course.id);
    expect(after.totalPapers).toBe(before.totalPapers);
    expect(after.questions.map(question => [question.id, question.paperCount, question.totalPapers]))
      .toEqual(before.questions.map(question => [question.id, question.paperCount, question.totalPapers]));
    expect(after.questions.flatMap(question => question.papers.map(item => item.id))).not.toContain("pending");
  });
  it("shows the full text of a question with sub-parts together (US-18)", async () => {
    const exam = await getConsolidatedExam(course.id);
    expect(exam.questions[2].text).toBe("Consider the network below.\n(a) Find the subnet mask.\n(b) How many hosts fit?");
    // A one-line question reads the same as in the question bank.
    expect(exam.questions[0].text).toBe("Explain the TCP three-way handshake.");
  });
  it("takes the text from the source question the group was built from, and from the next one if that paper is gone", async () => {
    const variants = group("g1", 1, "Explain the TCP three-way handshake.", [["p2023", 1, "explain the tcp three-way handshake"], ["p2024", 2, "Q2. Explain the TCP three-way handshake."]]);
    mocks.findGroups.mockResolvedValue([variants]);
    expect((await getConsolidatedExam(course.id)).questions[0].text).toBe("Explain the TCP three-way handshake.");
    mocks.findGroups.mockResolvedValue([{ ...variants, questions: variants.questions.slice(0, 1) }]);
    expect((await getConsolidatedExam(course.id)).questions[0].text).toBe("explain the tcp three-way handshake");
  });
  it("counts X as the distinct papers of the group and Y as the course's papers (US-17)", async () => {
    const exam = await getConsolidatedExam(course.id);
    expect(exam.totalPapers).toBe(4);
    expect(exam.questions.map(question => [question.paperCount, question.totalPapers])).toEqual([[4, 4], [2, 4], [1, 4]]);
    // X equals the number of distinct papers in the group, also when a paper repeats the question.
    exam.questions.forEach((question, index) => expect(question.paperCount).toBe(new Set(stored[index].questions.map(item => item.fileId)).size));
  });
  it("lists each source paper once, newest first, with its year and session (US-17)", async () => {
    const exam = await getConsolidatedExam(course.id);
    expect(exam.questions[0].papers.map(item => [item.id, item.year, item.term?.name])).toEqual([
      ["p2026", 2026, "Fall"], ["p2025", 2025, "Fall"], ["p2024", 2024, "Fall"], ["p2023", 2023, "Spring"],
    ]);
    expect(exam.questions[1].papers.map(item => item.id)).toEqual(["p2025", "p2024"]);
  });
  it("uses the course's current paper count, so a new paper changes Y", async () => {
    mocks.findFiles.mockResolvedValue(coursePapers("p2023", "p2024", "p2025", "p2026").concat({ id: "p-new" } as never));
    const exam = await getConsolidatedExam(course.id);
    expect(exam.totalPapers).toBe(5);
    expect(exam.questions[0].totalPapers).toBe(5);
  });
  it("never counts a paper that left the course before the next regroup, so X never exceeds Y", async () => {
    // p2026 moved to another course and p2025 was made a material; the stored groups still list them.
    mocks.findFiles.mockResolvedValue(coursePapers("p2023", "p2024"));
    const exam = await getConsolidatedExam(course.id);
    expect(exam.totalPapers).toBe(2);
    expect(exam.questions.map(question => [question.id, question.position, question.paperCount])).toEqual([["g1", 1, 2], ["g2", 2, 1]]);
    expect(exam.questions[0].papers.map(item => item.id)).toEqual(["p2024", "p2023"]);
    exam.questions.forEach(question => expect(question.paperCount).toBeLessThanOrEqual(question.totalPapers));
  });
  it("assigns tiers by the share of papers and keeps them in ranking order (US-19)", async () => {
    const exam = await getConsolidatedExam(course.id);
    expect(exam.questions.map(question => question.tier)).toEqual(["VERY_LIKELY", "VERY_LIKELY", "LIKELY"]);
    expect(exam.sections.map(section => [section.tier, section.questions.map(question => question.position)])).toEqual([
      ["VERY_LIKELY", [1, 2]], ["LIKELY", [3]],
    ]);
    expect(exam.lowConfidence).toBe(true);
  });
  it("is not low confidence from five papers, where a single paper is rare", async () => {
    mocks.findFiles.mockResolvedValue(coursePapers("p2023", "p2024", "p2025", "p2026").concat({ id: "p-new" } as never));
    const exam = await getConsolidatedExam(course.id);
    expect(exam.lowConfidence).toBe(false);
    expect(exam.questions.map(question => question.tier)).toEqual(["VERY_LIKELY", "LIKELY", "RARE"]);
  });
  it("returns nothing for a course with no processed papers", async () => {
    mocks.countFiles.mockResolvedValue(0);
    mocks.findFiles.mockResolvedValue([]);
    mocks.findGroups.mockResolvedValue([]);
    expect(await getConsolidatedExam(course.id)).toEqual({ totalPapers: 0, lowConfidence: false, questions: [], sections: [] });
  });
  it("logs a failed paper lookup without any question text and rethrows it", async () => {
    mocks.findFiles.mockRejectedValue(Object.assign(new Error("Define a socket. connection refused"), { name: "PrismaClientInitializationError" }));
    await expect(getConsolidatedExam(course.id)).rejects.toThrow();
    expect(mocks.logError).toHaveBeenCalledWith("question_bank_retrieval_failed", { courseId: course.id, source: "consolidated_exam", errorType: "PrismaClientInitializationError" });
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain("socket");
  });
  it("lets the question bank log its own failure and rethrows it", async () => {
    mocks.findGroups.mockRejectedValue(Object.assign(new Error("down"), { name: "PrismaClientKnownRequestError" }));
    await expect(getConsolidatedExam(course.id)).rejects.toThrow("down");
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith("question_bank_retrieval_failed", expect.objectContaining({ courseId: course.id, errorType: "PrismaClientKnownRequestError" }));
  });
});
