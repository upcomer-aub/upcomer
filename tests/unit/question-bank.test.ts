import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findCourse: vi.fn(), findCourses: vi.fn(), findQuestions: vi.fn(), updateQuestions: vi.fn(), findGroups: vi.fn(),
  deleteGroups: vi.fn(), upsertGroup: vi.fn(), countFiles: vi.fn(), findFiles: vi.fn(), executeRaw: vi.fn(), transaction: vi.fn(), logError: vi.fn(),
}));
const tx = {
  $executeRaw: mocks.executeRaw,
  question: { findMany: mocks.findQuestions, updateMany: mocks.updateQuestions },
  questionGroup: { deleteMany: mocks.deleteGroups, upsert: mocks.upsertGroup },
};
vi.mock("@/lib/db", () => ({ db: {
  course: { findUnique: mocks.findCourse, findMany: mocks.findCourses },
  courseFile: { count: mocks.countFiles, findMany: mocks.findFiles },
  questionGroup: { findMany: mocks.findGroups },
  $transaction: mocks.transaction,
} }));
vi.mock("@/lib/logger", () => ({ logError: mocks.logError }));
import {
  getQuestionBank, getQuestionBankFilterOptions, getQuestionBankOverview, MAX_LOGGED_LOW_CONFIDENCE, parseQuestionBankFilters, rebuildQuestionBank,
} from "@/lib/question-bank";

const failure = (name: string) => Object.assign(new Error("database is down"), { name });

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.transaction.mockImplementation((work: (client: typeof tx) => unknown) => work(tx));
  mocks.upsertGroup.mockImplementation(({ where }) => Promise.resolve({ id: `group-${where.courseId_normalizedText.normalizedText}` }));
});

describe("rebuildQuestionBank", () => {
  const stored = [
    { id: "q1", fileId: "paper-2024", number: 1, text: "Define a socket.", file: { year: 2024 } },
    { id: "q2", fileId: "paper-2025", number: 3, text: "define a SOCKET", file: { year: 2025 } },
    { id: "q3", fileId: "paper-2025", number: 1, text: "Explain ARP.", file: { year: 2025 } },
    { id: "q4", fileId: "paper-2025", number: 2, text: "Q2.", file: { year: 2025 } },
  ];

  it("groups and ranks the course's exam questions under a per-course lock", async () => {
    mocks.findCourse.mockResolvedValue({ id: "course-a" });
    mocks.findQuestions.mockResolvedValue(stored);
    expect(await rebuildQuestionBank("course-a")).toEqual({ ok: true, groupCount: 2, questionCount: 4 });
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.executeRaw.mock.calls[0].slice(1)).toEqual(["course-a"]);
    expect(mocks.findQuestions).toHaveBeenCalledWith(expect.objectContaining({ where: { file: { courseId: "course-a", category: "EXAM", status: "PUBLISHED" } } }));
    expect(mocks.deleteGroups).toHaveBeenCalledWith({ where: { courseId: "course-a", normalizedText: { notIn: ["define a socket", "explain arp"] } } });
    expect(mocks.upsertGroup.mock.calls.map(([call]) => [call.where.courseId_normalizedText.normalizedText, call.update])).toEqual([
      ["define a socket", { text: "Define a socket.", paperCount: 2, rank: 1 }],
      ["explain arp", { text: "Explain ARP.", paperCount: 1, rank: 2 }],
    ]);
    expect(mocks.updateQuestions).toHaveBeenCalledWith({ where: { id: { in: ["q1", "q2"] } }, data: { groupId: "group-define a socket" } });
    expect(mocks.updateQuestions).toHaveBeenCalledWith({ where: { id: { in: ["q3"] } }, data: { groupId: "group-explain arp" } });
    expect(mocks.updateQuestions).toHaveBeenCalledWith({ where: { id: { in: ["q4"] } }, data: { groupId: null } });
  });
  it("removes every group of a course that has no questions left", async () => {
    mocks.findCourse.mockResolvedValue({ id: "course-a" });
    mocks.findQuestions.mockResolvedValue([]);
    expect(await rebuildQuestionBank("course-a")).toEqual({ ok: true, groupCount: 0, questionCount: 0 });
    expect(mocks.deleteGroups).toHaveBeenCalledWith({ where: { courseId: "course-a", normalizedText: { notIn: [] } } });
    expect(mocks.upsertGroup).not.toHaveBeenCalled();
    expect(mocks.updateQuestions).not.toHaveBeenCalled();
  });
  it("logs a summary of the grouping decisions after the rebuild commits (US-15b)", async () => {
    mocks.findCourse.mockResolvedValue({ id: "course-a" });
    mocks.findQuestions.mockResolvedValue([
      ...stored,
      { id: "q5", fileId: "paper-2025", number: 4, text: "What is a socket?", file: { year: 2025 } },
      { id: "q6", fileId: "paper-2025", number: 5, text: "Describe how ARP works when a host resolves addresses.", file: { year: 2025 } },
    ]);
    expect(await rebuildQuestionBank("course-a")).toEqual({ ok: true, groupCount: 3, questionCount: 6 });
    expect(mocks.updateQuestions).toHaveBeenCalledWith({ where: { id: { in: ["q1", "q2", "q5"] } }, data: { groupId: "group-define a socket" } });
    expect(mocks.logError).toHaveBeenCalledWith("question_grouping_completed", {
      courseId: "course-a", questionCount: "6", groupCount: "3", rewordedMatches: "1", lowConfidenceMatches: "0",
    });
    expect(mocks.logError).not.toHaveBeenCalledWith("question_grouping_low_confidence", expect.anything());
  });
  it("logs each low-confidence match with IDs and the score only", async () => {
    mocks.findCourse.mockResolvedValue({ id: "course-a" });
    mocks.findQuestions.mockResolvedValue([
      { id: "h0", fileId: "paper-a", number: 1, text: "Explain the TCP three-way handshake.", file: { year: 2024 } },
      { id: "h1", fileId: "paper-b", number: 1, text: "Describe how TCP establishes a connection using the three-way handshake.", file: { year: 2025 } },
    ]);
    await rebuildQuestionBank("course-a");
    expect(mocks.logError).toHaveBeenCalledWith("question_grouping_completed", expect.objectContaining({
      groupCount: "1", rewordedMatches: "1", lowConfidenceMatches: "1",
    }));
    expect(mocks.logError).toHaveBeenCalledWith("question_grouping_low_confidence", { courseId: "course-a", questionId: "h1", matchedQuestionId: "h0", score: "0.75" });
    const logged = mocks.logError.mock.calls.filter(([event]) => event === "question_grouping_low_confidence");
    expect(JSON.stringify(logged)).not.toContain("handshake");
  });
  it("caps the low-confidence lines at MAX_LOGGED_LOW_CONFIDENCE per rebuild", async () => {
    mocks.findCourse.mockResolvedValue({ id: "course-a" });
    const count = MAX_LOGGED_LOW_CONFIDENCE + 5;
    // Each topic has a short first version and a longer rewording of it, a low-confidence match.
    mocks.findQuestions.mockResolvedValue(Array.from({ length: count }, (_, index) => [
      { id: `a${index}`, fileId: "paper-a", number: index + 1, text: `Explain t${index}q alpha.`, file: { year: 2024 } },
      { id: `b${index}`, fileId: "paper-b", number: index + 1, text: `Explain t${index}q alpha gamma.`, file: { year: 2025 } },
    ]).flat());
    await rebuildQuestionBank("course-a");
    expect(mocks.logError).toHaveBeenCalledWith("question_grouping_completed", expect.objectContaining({ lowConfidenceMatches: String(count) }));
    expect(mocks.logError.mock.calls.filter(([event]) => event === "question_grouping_low_confidence")).toHaveLength(MAX_LOGGED_LOW_CONFIDENCE);
  });
  it("logs no grouping decisions when the rebuild fails", async () => {
    mocks.findCourse.mockResolvedValue({ id: "course-a" });
    mocks.findQuestions.mockResolvedValue(stored);
    mocks.upsertGroup.mockRejectedValue(failure("PrismaClientKnownRequestError"));
    expect(await rebuildQuestionBank("course-a")).toEqual({ ok: false, error: "unexpected" });
    expect(mocks.logError).not.toHaveBeenCalledWith("question_grouping_completed", expect.anything());
  });
  it("refuses an unknown course and logs the reason", async () => {
    mocks.findCourse.mockResolvedValue(null);
    expect(await rebuildQuestionBank("course-x")).toEqual({ ok: false, error: "not_found" });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith("question_grouping_rejected", { courseId: "course-x", reason: "course_not_found" });
  });
  it("logs a database failure with the course and error type only", async () => {
    mocks.findCourse.mockResolvedValue({ id: "course-a" });
    mocks.transaction.mockRejectedValue(failure("PrismaClientKnownRequestError"));
    expect(await rebuildQuestionBank("course-a")).toEqual({ ok: false, error: "unexpected" });
    expect(mocks.logError).toHaveBeenCalledWith("question_grouping_failed", { courseId: "course-a", errorType: "PrismaClientKnownRequestError" });
  });
});

describe("parseQuestionBankFilters", () => {
  it("keeps valid filters", () => {
    expect(parseQuestionBankFilters({ query: " socket ", year: "2024", termId: "term-fall", examType: "final", professorId: "prof-a" }))
      .toEqual({ query: "socket", year: 2024, termId: "term-fall", examType: "FINAL", professorId: "prof-a" });
  });
  it("drops unusable values", () => {
    expect(parseQuestionBankFilters({ year: "20x4", examType: "essay", termId: " ", professorId: "" }))
      .toEqual({ query: "", year: undefined, termId: undefined, examType: undefined, professorId: undefined });
  });
});

const paper = (id: string, year: number | null, title = id) => ({ id, title, year, examType: "FINAL", term: null, professor: null });
const row = (id: string, rank: number, normalizedText: string, questions: Array<{ id: string; text: string; file: ReturnType<typeof paper> }>) => ({
  id, rank, normalizedText, text: normalizedText, paperCount: new Set(questions.map(item => item.file.id)).size, courseId: "course-a",
  createdAt: new Date(0), updatedAt: new Date(0), course: { id: "course-a", code: "EECE350", name: "Computer Networks" },
  questions: questions.map((item, index) => ({ ...item, number: index + 1, fileId: item.file.id })),
});

describe("getQuestionBank", () => {
  const groups = [
    row("g-socket", 1, "define a socket", [
      { id: "q1", text: "Define a socket.", file: paper("paper-2023", 2023) },
      { id: "q2", text: "Define a socket", file: paper("paper-2025", 2025) },
      { id: "q3", text: "DEFINE A SOCKET", file: paper("paper-2025", 2025) },
    ]),
    row("g-arp", 2, "explain arp", [{ id: "q4", text: "Explain ARP.", file: paper("paper-2024", 2024) }]),
    row("g-port", 3, "what is a port number", [{ id: "q5", text: "What is a port number?", file: paper("paper-2023", 2023) }]),
  ];

  it("returns the ranked groups with their course, questions, and papers, and the course's paper count", async () => {
    mocks.countFiles.mockResolvedValue(3);
    mocks.findGroups.mockResolvedValue(groups);
    const bank = await getQuestionBank("course-a");
    expect(mocks.countFiles).toHaveBeenCalledWith({ where: { courseId: "course-a", category: "EXAM", status: "PUBLISHED", questions: { some: {} } } });
    expect(mocks.findGroups).toHaveBeenCalledWith(expect.objectContaining({ where: { courseId: "course-a", questions: { some: { file: { status: "PUBLISHED" } } } }, orderBy: { rank: "asc" } }));
    expect(bank.totalPapers).toBe(3);
    expect(bank.groups.map(group => group.id)).toEqual(["g-socket", "g-arp", "g-port"]);
    expect(bank.groups[0]).toEqual({
      id: "g-socket", rank: 1, text: "define a socket", paperCount: 2, course: { id: "course-a", code: "EECE350", name: "Computer Networks" },
      questions: [
        { id: "q1", number: 1, text: "Define a socket.", fileId: "paper-2023" },
        { id: "q2", number: 2, text: "Define a socket", fileId: "paper-2025" },
        { id: "q3", number: 3, text: "DEFINE A SOCKET", fileId: "paper-2025" },
      ],
      // Each paper once, newest first.
      papers: [paper("paper-2025", 2025), paper("paper-2023", 2023)],
    });
  });
  it("matches the keyword ignoring case, spacing, and punctuation, and keeps the ranking order", async () => {
    mocks.countFiles.mockResolvedValue(3);
    mocks.findGroups.mockResolvedValue(groups);
    expect((await getQuestionBank("course-a", { query: "  SOCKET!" })).groups.map(group => group.id)).toEqual(["g-socket"]);
    expect((await getQuestionBank("course-a", { query: "a" })).groups.map(group => group.id)).toEqual(["g-socket", "g-arp", "g-port"]);
    expect((await getQuestionBank("course-a", { query: "port   number?" })).groups.map(group => group.id)).toEqual(["g-port"]);
    expect((await getQuestionBank("course-a", { query: "routing" })).groups).toEqual([]);
  });
  it("applies every paper filter to the same paper and combines them with the keyword", async () => {
    mocks.countFiles.mockResolvedValue(3);
    mocks.findGroups.mockResolvedValue([groups[0], groups[2]]);
    const bank = await getQuestionBank("course-a", { query: "socket", year: "2023", termId: "term-fall", examType: "FINAL", professorId: "prof-a" });
    expect(mocks.findGroups).toHaveBeenCalledWith(expect.objectContaining({
      where: { courseId: "course-a", questions: { some: { file: { year: 2023, termId: "term-fall", examType: "FINAL", professorId: "prof-a", status: "PUBLISHED" } } } },
      orderBy: { rank: "asc" },
    }));
    expect(bank.groups.map(group => group.id)).toEqual(["g-socket"]);
  });
  it("logs a failed search with the filter IDs but never the keyword, and rethrows", async () => {
    const error = failure("PrismaClientKnownRequestError");
    mocks.countFiles.mockResolvedValue(0);
    mocks.findGroups.mockRejectedValue(error);
    await expect(getQuestionBank("course-a", { query: "secret words", year: "2024", examType: "MIDTERM" })).rejects.toBe(error);
    expect(mocks.logError).toHaveBeenCalledWith("question_search_failed", {
      courseId: "course-a", year: "2024", termId: undefined, examType: "MIDTERM", professorId: undefined, errorType: "PrismaClientKnownRequestError",
    });
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain("secret");
  });
  it("logs a failed unfiltered read as a retrieval failure", async () => {
    mocks.countFiles.mockRejectedValue(failure("PrismaClientInitializationError"));
    mocks.findGroups.mockResolvedValue([]);
    await expect(getQuestionBank("course-a")).rejects.toThrow();
    expect(mocks.logError).toHaveBeenCalledWith("question_bank_retrieval_failed", expect.objectContaining({ courseId: "course-a", errorType: "PrismaClientInitializationError" }));
  });
});

describe("getQuestionBankFilterOptions", () => {
  it("lists the distinct years (newest first), types, terms, and professors of papers with questions", async () => {
    mocks.findFiles.mockResolvedValue([
      { year: 2024, examType: "FINAL", term: { id: "term-fall", name: "Fall" }, professor: { id: "prof-b", name: "Professor B" } },
      { year: 2025, examType: "MIDTERM", term: { id: "term-fall", name: "Fall" }, professor: { id: "prof-a", name: "Professor A" } },
      { year: null, examType: null, term: null, professor: null },
      { year: 2024, examType: "FINAL", term: { id: "term-spring", name: "Spring" }, professor: { id: "prof-a", name: "Professor A" } },
    ]);
    expect(await getQuestionBankFilterOptions("course-a")).toEqual({
      years: [2025, 2024],
      examTypes: ["MIDTERM", "FINAL"],
      terms: [{ id: "term-fall", name: "Fall" }, { id: "term-spring", name: "Spring" }],
      professors: [{ id: "prof-a", name: "Professor A" }, { id: "prof-b", name: "Professor B" }],
    });
    expect(mocks.findFiles).toHaveBeenCalledWith(expect.objectContaining({ where: { courseId: "course-a", category: "EXAM", status: "PUBLISHED", questions: { some: {} } } }));
  });
  it("logs and rethrows a failure", async () => {
    mocks.findFiles.mockRejectedValue(failure("PrismaClientInitializationError"));
    await expect(getQuestionBankFilterOptions("course-a")).rejects.toThrow();
    expect(mocks.logError).toHaveBeenCalledWith("question_bank_retrieval_failed", { courseId: "course-a", errorType: "PrismaClientInitializationError" });
  });
});

describe("getQuestionBankOverview", () => {
  it("lists courses with questions or groups, with their paper, question, and group counts", async () => {
    mocks.findFiles.mockResolvedValue([
      { courseId: "course-a", _count: { questions: 4 } }, { courseId: "course-a", _count: { questions: 6 } }, { courseId: "course-b", _count: { questions: 2 } },
    ]);
    mocks.findCourses.mockResolvedValue([
      { id: "course-a", code: "A100", name: "A", _count: { questionGroups: 7 } },
      { id: "course-b", code: "B100", name: "B", _count: { questionGroups: 0 } },
      { id: "course-c", code: "C100", name: "C", _count: { questionGroups: 0 } },
      { id: "course-d", code: "D100", name: "D", _count: { questionGroups: 3 } },
    ]);
    expect(await getQuestionBankOverview()).toEqual([
      { id: "course-a", code: "A100", name: "A", groupCount: 7, papers: 2, questions: 10 },
      { id: "course-b", code: "B100", name: "B", groupCount: 0, papers: 1, questions: 2 },
      { id: "course-d", code: "D100", name: "D", groupCount: 3, papers: 0, questions: 0 },
    ]);
  });
});
