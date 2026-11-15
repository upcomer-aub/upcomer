import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The mock exam pages and their actions (US-45): the form with its settings, the student's own exams, the sitting flow,
// the notices, and who may see what.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), getCurrentUser: vi.fn(), getCourseById: vi.fn(),
  getMockExamOptions: vi.fn(), listMyMockExams: vi.fn(), getMockExam: vi.fn(), createMockExam: vi.fn(), saveMockExam: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser, getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
// US-46 (Lea Tass): the exam page also reads the exam's versions; one version here, so these tests are unchanged.
vi.mock("@/lib/mock-exam-versions", () => ({ getMockExamVersions: vi.fn(async () => ({ current: 1, versions: [] })) }));
vi.mock("@/lib/mock-exams", () => ({
  getMockExamOptions: mocks.getMockExamOptions, listMyMockExams: mocks.listMyMockExams, getMockExam: mocks.getMockExam,
  createMockExam: mocks.createMockExam, saveMockExam: mocks.saveMockExam,
}));
import MockExamPage from "@/app/courses/[courseId]/mock-exams/[mockExamId]/page";
import { createMockExamAction, saveMockExamAction } from "@/app/courses/[courseId]/mock-exams/actions";
import MockExamsPage from "@/app/courses/[courseId]/mock-exams/page";

const course = { id: "course-a", code: "EECE350", name: "Computer Networks", faculty: { name: "Engineering" }, professors: [] };
const student = { id: "student-1", role: "STUDENT" };
const options = { total: 12, topics: [{ key: "dns", label: "DNS", count: 1 }, { key: "tcp", label: "TCP", count: 5 }], generated: 0 };
const listPage = () => MockExamsPage({ params: Promise.resolve({ courseId: course.id }) }).then(renderToStaticMarkup);
const pastPaper = { id: "mq-1", position: 1, topic: "TCP", text: "Explain the handshake.\na) SYN\nb) ACK", paperCount: 2, totalPapers: 5, sourcePapers: ["Final (2024)", "Midterm (2023)"], answer: "My answer" };
const generated = { id: "mq-2", position: 2, topic: "DNS", text: "Plan a solution for the resolver task.", paperCount: 0, totalPapers: 5, sourcePapers: ["Final 2025"], answer: null };
const exam = (over: Record<string, unknown> = {}) => ({
  id: "mock-1", courseId: course.id, length: 2, difficulty: "HARD", topics: ["TCP", "DNS"], includeGenerated: true, status: "IN_PROGRESS",
  createdAt: new Date("2026-11-15T10:00:00Z"), submittedAt: null, questions: [pastPaper, generated], ...over,
});
const examPage = (query: Record<string, string> = {}, ids = { courseId: course.id, mockExamId: "mock-1" }) =>
  MockExamPage({ params: Promise.resolve(ids), searchParams: Promise.resolve(query) }).then(renderToStaticMarkup);
const notices = (html: string) => [...html.matchAll(/<p class="notice[^"]*" role="(status|alert)">(.*?)<\/p>/g)].map(match => [match[1], match[2]]);
const form = (fields: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) for (const item of [value].flat()) data.append(name, item);
  return data;
};

beforeEach(() => {
  mocks.requireUser.mockReset().mockResolvedValue(student);
  mocks.getCurrentUser.mockReset().mockResolvedValue(student);
  mocks.getCourseById.mockReset().mockResolvedValue(course);
  mocks.getMockExamOptions.mockReset().mockResolvedValue(options);
  mocks.listMyMockExams.mockReset().mockResolvedValue([]);
  mocks.getMockExam.mockReset().mockResolvedValue(exam());
  mocks.createMockExam.mockReset().mockResolvedValue({ ok: true, id: "mock-1", difficultyApplied: true });
  mocks.saveMockExam.mockReset().mockResolvedValue({ ok: true, submitted: false });
  mocks.redirect.mockClear();
});

describe("the mock exams page (US-45)", () => {
  it("shows the form with the course's topics, the length and the difficulty", async () => {
    const html = await listPage();
    expect(mocks.getMockExamOptions).toHaveBeenCalledWith("course-a", "student-1");
    expect(html).toContain('<form class="card form"');
    expect(html).toContain('<fieldset class="checkbox-list"><legend>Topics</legend>');
    expect(html).toContain('<input type="checkbox" name="topic" value="tcp"/> TCP (5 questions)');
    expect(html).toContain('<input type="checkbox" name="topic" value="dns"/> DNS (1 question)');
    const length = /<input[^>]*name="length"[^>]*>/.exec(html)![0];
    for (const attribute of ['type="number"', 'min="3"', 'max="50"', 'required=""', 'value="10"']) expect(length).toContain(attribute);
    expect(html).toContain("3 to 50. This course has 12 questions from past papers.");
    for (const [value, label] of [["EASY", "Easier"], ["MEDIUM", "Medium"], ["HARD", "Harder"], ["MIXED", "Mixed"]]) expect(html).toMatch(new RegExp(`<option value="${value}"[^>]*>${label}</option>`));
    expect(html).toContain("Difficulty is estimated from each question&#x27;s length and number of parts");
    expect(html).toContain("Generate mock exam</button>");
    expect(html).toContain('<input type="hidden" name="courseId" value="course-a"/>');
  });
  it("offers the student's generated practice questions only when they have some", async () => {
    const without = await listPage();
    expect(without).not.toContain('name="includeGenerated"');
    expect(without).toContain('You have no generated practice questions for this course. <a href="/courses/course-a/practice/generated">Generate some</a>');
    mocks.getMockExamOptions.mockResolvedValue({ ...options, generated: 4 });
    const html = await listPage();
    expect(html).toContain('<input type="checkbox" name="includeGenerated"/> Include my generated practice questions (4 available)');
    expect(html).toContain("Up to half of the exam.");
  });
  it("shows a visitor what the page is for and a link to log in, and reads no exam", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const html = await listPage();
    expect(mocks.getMockExamOptions).toHaveBeenCalledWith("course-a", undefined);
    expect(mocks.listMyMockExams).not.toHaveBeenCalled();
    expect(html).not.toContain("<form");
    expect(html).toContain('<a href="/login?next=%2Fcourses%2Fcourse-a%2Fmock-exams">Log in</a> to generate a mock exam.');
  });
  it("lists the session student's own exams with their settings and state", async () => {
    mocks.listMyMockExams.mockResolvedValue([
      { id: "mock-2", length: 6, difficulty: "EASY", topics: ["TCP"], includeGenerated: true, status: "IN_PROGRESS", createdAt: new Date("2026-11-15T10:00:00Z"), submittedAt: null },
      { id: "mock-1", length: 10, difficulty: "MIXED", topics: [], includeGenerated: false, status: "SUBMITTED", createdAt: new Date("2026-11-14T10:00:00Z"), submittedAt: new Date() },
    ]);
    const html = await listPage();
    expect(mocks.listMyMockExams).toHaveBeenCalledWith("student-1", "course-a");
    expect(html).toContain('<a href="/courses/course-a/mock-exams/mock-2">6 questions · Easier · TCP · with generated questions</a>');
    expect(html).toContain("In progress · created 2026-11-15");
    expect(html).toContain('<a href="/courses/course-a/mock-exams/mock-1">10 questions · Mixed · All topics</a>');
    expect(html).toContain("Submitted · created 2026-11-14");
  });
  it("says so when the course has no questions, and is not found for an unknown course", async () => {
    mocks.getMockExamOptions.mockResolvedValue({ total: 0, topics: [], generated: 0 });
    const html = await listPage();
    expect(html).toContain("No questions have been extracted for this course yet");
    expect(html).not.toContain("<form");
    mocks.getCourseById.mockResolvedValue(null);
    await expect(listPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("the mock exam sitting page (US-45)", () => {
  it("asks for the session first and reads the exam for that student only", async () => {
    await examPage();
    expect(mocks.requireUser).toHaveBeenCalledWith("/courses/course-a/mock-exams/mock-1");
    expect(mocks.getMockExam).toHaveBeenCalledWith("student-1", "mock-1");
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    mocks.getMockExam.mockClear();
    await expect(examPage()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mocks.getMockExam).not.toHaveBeenCalled();
  });
  it("is not found for another student's exam, an exam of another course, and an unknown course", async () => {
    mocks.getMockExam.mockResolvedValue(null);
    await expect(examPage()).rejects.toThrow("NEXT_NOT_FOUND");
    mocks.getMockExam.mockResolvedValue(exam({ courseId: "course-b" }));
    await expect(examPage()).rejects.toThrow("NEXT_NOT_FOUND");
    mocks.getMockExam.mockResolvedValue(exam());
    mocks.getCourseById.mockResolvedValue(null);
    await expect(examPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("shows the settings, every question in order, and a box for each answer", async () => {
    const html = await examPage();
    expect(html).toContain("2 questions · Harder · TCP, DNS · with generated questions");
    expect(html.indexOf("Question 1 · TCP")).toBeLessThan(html.indexOf("Question 2 · DNS"));
    expect(html).toContain("Explain the handshake.\na) SYN\nb) ACK");
    expect(html).toContain('<textarea name="answer_mq-1" rows="6" maxLength="5000">My answer</textarea>');
    expect(html).toContain('<textarea name="answer_mq-2" rows="6" maxLength="5000"></textarea>');
    expect(html).toContain("Your answer to question 2");
    expect(html).toContain('<input type="hidden" name="mockExamId" value="mock-1"/>');
    expect(html).toMatch(/1 of 2 answers saved\./);
    expect(html).toContain('<button class="button" type="submit" value="save" name="intent">Save progress</button>');
    expect(html).toContain('<button class="button" type="submit" value="submit" name="intent">Submit exam</button>');
  });
  it("shows a past-paper question's evidence, and says a generated question appeared in no paper", async () => {
    const html = await examPage();
    expect(html).toMatch(/data-kind="past-paper"[\s\S]*Appeared in 2 of 5 papers: Final \(2024\), Midterm \(2023\)/);
    expect(html).toMatch(/data-kind="generated"[\s\S]*Generated practice question, based on Final 2025\. It did not appear in a past paper\./);
    expect(html).not.toContain("Appeared in 0 of");
  });
  it("locks a submitted exam: read-only answers and no buttons", async () => {
    mocks.getMockExam.mockResolvedValue(exam({ status: "SUBMITTED", submittedAt: new Date() }));
    const html = await examPage();
    expect(html.match(/<textarea[^>]*readOnly=""/g)).toHaveLength(2);
    // No Save or Submit; since US-46 the only button is "Make an alternative version", outside the sitting form.
    expect(html.match(/<button[^>]*>[^<]*<\/button>/g)).toEqual([expect.stringContaining(">Make an alternative version</button>")]);
    expect(html).toContain("Submitted. Your answers are locked.");
  });
  it("confirms a save and a submit, and explains a new exam the difficulty could not narrow", async () => {
    expect(notices(await examPage())).toEqual([]);
    expect(notices(await examPage({ saved: "1" }))).toEqual([["status", "Your answers were saved."]]);
    expect(notices(await examPage({ submitted: "1" }))).toEqual([["status", "Your exam was submitted."]]);
    expect(notices(await examPage({ same: "1" }))).toEqual([["status", "Your topics have just enough past-paper questions for this exam, so the difficulty could not choose between them. Any difficulty gives these questions."]]);
  });
  it("shows a refusal as an alert, alone, and never echoes a value from the URL", async () => {
    expect(notices(await examPage({ error: "already_submitted", saved: "1" }))).toEqual([["alert", "This exam was already submitted, so its answers can&#x27;t change."]]);
    expect(notices(await examPage({ error: "answer_too_long" }))).toEqual([["alert", "Keep each answer to 5000 characters or fewer."]]);
    const html = await examPage({ error: "<script>alert(1)</script>" });
    expect(notices(html)).toEqual([["alert", "Your answers could not be saved. Please try again."]]);
    expect(html).not.toContain("alert(1)");
  });
  it("escapes question text and answers", async () => {
    mocks.getMockExam.mockResolvedValue(exam({ questions: [{ ...pastPaper, text: "<b>bold</b>", answer: "</textarea><script>x</script>" }] }));
    const html = await examPage();
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("&lt;/textarea&gt;&lt;script&gt;x&lt;/script&gt;</textarea>");
    expect(html).not.toContain("<script>x");
  });
});

describe("the mock exam actions (US-45)", () => {
  const state = { status: "idle" as const };
  it("creates the exam for the session student with the settings of the form, and opens it", async () => {
    await expect(createMockExamAction(state, form({ courseId: "course-a", length: "6", difficulty: "HARD", topic: ["tcp", "dns"], includeGenerated: "on", userId: "student-2" })))
      .rejects.toThrow("NEXT_REDIRECT /courses/course-a/mock-exams/mock-1");
    expect(mocks.requireUser).toHaveBeenCalledWith("/courses/course-a/mock-exams");
    expect(mocks.createMockExam).toHaveBeenCalledWith("student-1", { courseId: "course-a", length: "6", difficulty: "HARD", topics: ["tcp", "dns"], includeGenerated: true });
    expect(mocks.redirect).toHaveBeenCalledWith("/courses/course-a/mock-exams/mock-1");
  });
  it("leaves generated questions out unless the box is ticked", async () => {
    await expect(createMockExamAction(state, form({ courseId: "course-a", length: "6", difficulty: "HARD", includeGenerated: "true" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.createMockExam.mock.calls[0][1]).toMatchObject({ includeGenerated: false, topics: [] });
  });
  it("tells the exam page when the difficulty could not choose", async () => {
    mocks.createMockExam.mockResolvedValue({ ok: true, id: "mock-1", difficultyApplied: false });
    await expect(createMockExamAction(state, form({ courseId: "course-a", length: "4", difficulty: "EASY" }))).rejects.toThrow("NEXT_REDIRECT /courses/course-a/mock-exams/mock-1?same=1");
  });
  it("gives a refusal back to the form with what was chosen, and creates nothing for a visitor", async () => {
    mocks.createMockExam.mockResolvedValue({ ok: false, error: "not_enough_questions", available: 4 });
    expect(await createMockExamAction(state, form({ courseId: "course-a", length: "9", difficulty: "EASY", topic: "tcp" }))).toEqual({
      status: "error", error: "not_enough_questions", available: 4, values: { length: "9", difficulty: "EASY", topics: ["tcp"], includeGenerated: false },
    });
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    mocks.createMockExam.mockClear();
    await expect(createMockExamAction(state, form({ courseId: "course-a", length: "9", difficulty: "EASY" }))).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mocks.createMockExam).not.toHaveBeenCalled();
  });
  it("saves the answers of the form for the session student, and submits only with the submit button", async () => {
    await expect(saveMockExamAction(form({ courseId: "course-a", mockExamId: "mock-1", "answer_mq-1": "one", "answer_mq-2": "", intent: "save", userId: "student-2", other: "x" })))
      .rejects.toThrow("NEXT_REDIRECT /courses/course-a/mock-exams/mock-1?saved=1");
    expect(mocks.requireUser).toHaveBeenCalledWith("/courses/course-a/mock-exams/mock-1");
    expect(mocks.saveMockExam).toHaveBeenCalledWith("student-1", "mock-1", { "mq-1": "one", "mq-2": "" }, false);
    mocks.saveMockExam.mockResolvedValue({ ok: true, submitted: true });
    await expect(saveMockExamAction(form({ courseId: "course-a", mockExamId: "mock-1", "answer_mq-1": "one", intent: "submit" }))).rejects.toThrow("?submitted=1");
    expect(mocks.saveMockExam).toHaveBeenLastCalledWith("student-1", "mock-1", { "mq-1": "one" }, true);
    // Any other intent is a save.
    await expect(saveMockExamAction(form({ courseId: "course-a", mockExamId: "mock-1", intent: "SUBMIT" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.saveMockExam).toHaveBeenLastCalledWith("student-1", "mock-1", {}, false);
  });
  it("comes back with the refusal's code", async () => {
    mocks.saveMockExam.mockResolvedValue({ ok: false, error: "already_submitted" });
    await expect(saveMockExamAction(form({ courseId: "course-a", mockExamId: "mock-1", intent: "save" }))).rejects.toThrow("NEXT_REDIRECT /courses/course-a/mock-exams/mock-1?error=already_submitted");
  });
});
