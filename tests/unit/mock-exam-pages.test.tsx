import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The mock exam pages and their actions (US-45): the form with its settings, the student's own exams, the sitting flow,
// the notices, and who may see what.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), getCurrentUser: vi.fn(), getCourseById: vi.fn(),
  getMockExamOptions: vi.fn(), listMyMockExams: vi.fn(), getMockExam: vi.fn(), createMockExam: vi.fn(), saveMockExam: vi.fn(),
  startMockExam: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser, getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/mock-exams", () => ({
  getMockExamOptions: mocks.getMockExamOptions, listMyMockExams: mocks.listMyMockExams, getMockExam: mocks.getMockExam,
  createMockExam: mocks.createMockExam, saveMockExam: mocks.saveMockExam, startMockExam: mocks.startMockExam,
}));
import MockExamPage from "@/app/courses/[courseId]/mock-exams/[mockExamId]/page";
import { autosaveMockExamAction, createMockExamAction, saveMockExamAction, startMockExamAction } from "@/app/courses/[courseId]/mock-exams/actions";
import MockExamsPage from "@/app/courses/[courseId]/mock-exams/page";

const course = { id: "course-a", code: "EECE350", name: "Computer Networks", faculty: { name: "Engineering" }, professors: [] };
const student = { id: "student-1", role: "STUDENT" };
const options = { total: 12, topics: [{ key: "dns", label: "DNS", count: 1 }, { key: "tcp", label: "TCP", count: 5 }], generated: 0 };
const untimedRow = { timeLimitMinutes: null, startedAt: null, timedOut: false };
const listPage = () => MockExamsPage({ params: Promise.resolve({ courseId: course.id }) }).then(renderToStaticMarkup);
const pastPaper = { id: "mq-1", position: 1, topic: "TCP", text: "Explain the handshake.\na) SYN\nb) ACK", paperCount: 2, totalPapers: 5, sourcePapers: ["Final (2024)", "Midterm (2023)"], answer: "My answer" };
const generated = { id: "mq-2", position: 2, topic: "DNS", text: "Plan a solution for the resolver task.", paperCount: 0, totalPapers: 5, sourcePapers: ["Final 2025"], answer: null };
const exam = (over: Record<string, unknown> = {}) => ({
  id: "mock-1", courseId: course.id, length: 2, requestedLength: 2, difficulty: "HARD", topics: ["TCP", "DNS"], includeGenerated: true,
  mixBasis: null, weakTopics: [] as string[], status: "IN_PROGRESS", timeLimitMinutes: null, startedAt: null, deadlineAt: null, timedOut: false, locked: false, remainingMs: null,
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
      { id: "mock-2", length: 6, difficulty: "EASY", topics: ["TCP"], includeGenerated: true, status: "IN_PROGRESS", createdAt: new Date("2026-11-15T10:00:00Z"), submittedAt: null, ...untimedRow },
      { id: "mock-1", length: 10, difficulty: "MIXED", topics: [], includeGenerated: false, status: "SUBMITTED", createdAt: new Date("2026-11-14T10:00:00Z"), submittedAt: new Date(), ...untimedRow },
    ]);
    const html = await listPage();
    expect(mocks.listMyMockExams).toHaveBeenCalledWith("student-1", "course-a");
    expect(html).toContain('<a href="/courses/course-a/mock-exams/mock-2">6 questions · Easier · TCP · with generated questions</a>');
    expect(html).toContain("In progress · created 2026-11-15");
    expect(html).toContain('<a href="/courses/course-a/mock-exams/mock-1">10 questions · Mixed · All topics</a>');
    expect(html).toContain("Submitted · created 2026-11-14");
    expect(html).not.toContain("Timed");
  });
  it("offers a time limit that is off by default, with a suggestion for the length (US-48)", async () => {
    const html = await listPage();
    expect(html).toMatch(/<select name="timeLimit"><option value="" selected="">No time limit<\/option><option value="10">10 minutes<\/option>/);
    expect(html).toContain('<option value="180">3 hours</option>');
    expect(html).toContain("Suggested for 10 questions: 30 minutes (about 3 minutes a question).");
    expect(html).toContain("the timer starts when you press Start, keeps running if you leave, and submits your answers when it ends");
  });
  it("says which exams are timed, and which ran out of time or were not started", async () => {
    const row = (id: string, over: Record<string, unknown>) =>
      ({ id, length: 5, difficulty: "MIXED", topics: [], includeGenerated: false, status: "IN_PROGRESS", createdAt: new Date("2026-11-15T10:00:00Z"), submittedAt: null, ...untimedRow, ...over });
    mocks.listMyMockExams.mockResolvedValue([
      row("m1", { timeLimitMinutes: 30 }), row("m2", { timeLimitMinutes: 60, startedAt: new Date() }),
      row("m3", { timeLimitMinutes: 10, startedAt: new Date(), status: "SUBMITTED", timedOut: true }), row("m4", { timeLimitMinutes: 10, startedAt: new Date(), status: "SUBMITTED" }),
    ]);
    const html = await listPage();
    expect(html).toMatch(/mock-exams\/m1">5 questions · Mixed · All topics · Timed, 30 minutes<\/a><p class="muted">Not started · created/);
    expect(html).toMatch(/mock-exams\/m2">5 questions · Mixed · All topics · Timed, 1 hour<\/a><p class="muted">In progress · created/);
    expect(html).toMatch(/mock-exams\/m3">[^<]*<\/a><p class="muted">Time is up · created/);
    expect(html).toMatch(/mock-exams\/m4">[^<]*<\/a><p class="muted">Submitted · created/);
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
    expect(html).not.toContain("<button");
    expect(html).toContain("Submitted. Your answers are locked.");
  });
  it("confirms a save and a submit, and explains a new exam the difficulty could not narrow", async () => {
    expect(notices(await examPage())).toEqual([]);
    expect(notices(await examPage({ saved: "1" }))).toEqual([["status", "Your answers were saved."]]);
    expect(notices(await examPage({ submitted: "1" }))).toEqual([["status", "Your exam was submitted."]]);
    expect(notices(await examPage({ same: "1" }))).toEqual([["status", "Your topics have just enough past-paper questions for this exam, so the difficulty could not choose between them. Any difficulty gives these questions."]]);
  });
  it("says every time it is opened that the exam is shorter than asked, and why (US-45)", async () => {
    mocks.getMockExam.mockResolvedValue(exam({ requestedLength: 10, includeGenerated: false }));
    const message = "You asked for 10 questions, but your topics have only 2 that fit, so this exam has 2.";
    expect(notices(await examPage({ same: "1" }))).toEqual([["status", message]]);
    expect(notices(await examPage({ saved: "1" }))).toEqual([["status", message], ["status", "Your answers were saved."]]);
    mocks.getMockExam.mockResolvedValue(exam({ requestedLength: 10 }));
    expect(notices(await examPage())).toEqual([["status", "You asked for 10 questions, but your topics have only 2 that fit (past papers and your generated practice questions of this difficulty), so this exam has 2."]]);
    // An exam of the length asked for, or one made before the requested length was kept, says nothing.
    mocks.getMockExam.mockResolvedValue(exam({ requestedLength: null }));
    expect(notices(await examPage())).toEqual([]);
  });
  it("says why the exam has its mix of topics, without claiming mastery (US-47)", async () => {
    const mixLine = async (over: Record<string, unknown>) => {
      mocks.getMockExam.mockResolvedValue(exam(over));
      return (await examPage()).match(/<p class="muted" data-testid="mock-mix">(.*?)<\/p>/)?.[1] ?? null;
    };
    expect(await mixLine({ mixBasis: "PROFILE", weakTopics: ["Routing", "DNS"] })).toBe("Weighted toward your weaker topics: Routing, DNS, and toward the topics that come up most in past papers.");
    expect(await mixLine({ mixBasis: "PROFILE", weakTopics: ["DNS"] })).toBe("Weighted toward your weaker topic: DNS, and toward the topics that come up most in past papers.");
    expect(await mixLine({ mixBasis: "PROFILE" })).toBe("Weighted by your ratings and practice results and by how often each topic comes up in past papers.");
    expect(await mixLine({ mixBasis: "NO_PROFILE" })).toBe("You have no ratings or practice results in this course yet, so the mix follows how often each topic comes up in past papers.");
    expect(await mixLine({ mixBasis: "PROFILE_UNAVAILABLE" })).toBe("Your ratings could not be read, so the mix follows how often each topic comes up in past papers.");
    expect(await mixLine({ mixBasis: null })).toBeNull();
    const html = await examPage();
    expect(html).not.toMatch(/master|you know|strong at/i);
    // Topic names are escaped like any text.
    expect(await mixLine({ mixBasis: "PROFILE", weakTopics: ["<b>DNS</b>"] })).toContain("&lt;b&gt;DNS&lt;/b&gt;");
  });
  it("shows a refusal as an alert, alone, and never echoes a value from the URL", async () => {
    expect(notices(await examPage({ error: "already_submitted", saved: "1" }))).toEqual([["alert", "This exam was already submitted, so its answers can&#x27;t change."]]);
    expect(notices(await examPage({ error: "answer_too_long" }))).toEqual([["alert", "Keep each answer to 5000 characters or fewer."]]);
    const html = await examPage({ error: "<script>alert(1)</script>" });
    expect(notices(html)).toEqual([["alert", "Your answers could not be saved. Please try again."]]);
    expect(html).not.toContain("alert(1)");
  });
  describe("a timed exam (US-48)", () => {
    const running = { timeLimitMinutes: 30, startedAt: new Date("2026-11-16T10:00:00Z"), deadlineAt: new Date("2026-11-16T10:30:00Z"), remainingMs: 754_000 };
    it("sends no question to the browser before it is started: only the start page", async () => {
      // What getMockExam returns for an unstarted timed exam: no questions at all.
      mocks.getMockExam.mockResolvedValue(exam({ timeLimitMinutes: 30, locked: true, questions: [], length: 2 }));
      const html = await examPage();
      expect(html).toContain("2 questions · Harder · TCP, DNS · with generated questions · Timed, 30 minutes");
      expect(html).toContain("You have 30 minutes for 2 questions. The questions appear when you press Start.");
      expect(html).toContain("keeps running if you close the page or log out");
      expect(html).toMatch(/<form class="card"[^>]*data-testid="mock-start"/);
      expect(html).toContain('<button class="button" type="submit">Start exam</button>');
      expect(html).toContain('<input type="hidden" name="mockExamId" value="mock-1"/>');
      // No question, no answer box, no countdown.
      expect(html).not.toContain("Explain the handshake");
      expect(html).not.toContain("Plan a solution");
      expect(html).not.toContain("<textarea");
      expect(html).not.toContain("question-list");
      expect(html).not.toContain("Appeared in");
      expect(html).not.toContain('role="timer"');
    });
    it("does not rely on the service alone: a locked exam shows no question even if some were passed", async () => {
      mocks.getMockExam.mockResolvedValue(exam({ timeLimitMinutes: 30, locked: true }));
      const html = await examPage();
      expect(html).not.toContain("Explain the handshake");
      expect(html).not.toContain("Plan a solution");
      expect(html).not.toContain("<textarea");
    });
    it("shows the countdown from the server's time left above the questions, and still a plain form", async () => {
      mocks.getMockExam.mockResolvedValue(exam(running));
      const html = await examPage();
      expect(html).toMatch(/<p class="[^"]*" role="timer" aria-live="off"><span>Time left<\/span> <strong data-testid="mock-timer">12:34<\/strong><\/p>/);
      expect(html).toMatch(/data-level="normal"/);
      expect(html.indexOf('role="timer"')).toBeLessThan(html.indexOf("Question 1 · TCP"));
      // The warnings have their own quiet live region; the countdown itself is not announced.
      expect(html).toMatch(/<p class="[^"]*" role="status" aria-live="polite" data-testid="mock-timer-announcement"><\/p>/);
      expect(html).toContain("<noscript><p class=\"muted\">The timer doesn&#x27;t count down without JavaScript, but the exam still ends on time.</p></noscript>");
      expect(html).toContain("All changes saved.");
      expect(html).toContain('<button class="button" type="submit" value="save" name="intent">Save progress</button>');
      expect(html).toContain('<button class="button" type="submit" value="submit" name="intent">Submit exam</button>');
      expect(html).toContain("Explain the handshake.");
    });
    it("styles the countdown as a warning at five minutes and as urgent at one", async () => {
      mocks.getMockExam.mockResolvedValue(exam({ ...running, remainingMs: 299_000 }));
      expect(await examPage()).toMatch(/data-level="warning"[\s\S]*4:59/);
      mocks.getMockExam.mockResolvedValue(exam({ ...running, remainingMs: 59_000 }));
      expect(await examPage()).toMatch(/data-level="urgent"[\s\S]*0:59/);
    });
    it("shows no countdown on an untimed exam or a submitted one", async () => {
      expect(await examPage()).not.toContain('role="timer"');
      mocks.getMockExam.mockResolvedValue(exam({ ...running, remainingMs: null, status: "SUBMITTED", submittedAt: new Date() }));
      expect(await examPage()).not.toContain('role="timer"');
    });
    it("says that time ran out, every time, and differently from a normal submit", async () => {
      const timeUp = "Time is up — your answers were submitted automatically.";
      mocks.getMockExam.mockResolvedValue(exam({ ...running, remainingMs: null, status: "SUBMITTED", submittedAt: running.deadlineAt, timedOut: true }));
      for (const query of [{}, { submitted: "1" }, { saved: "1" }, { error: "time_up" }, { same: "1" }] as Array<Record<string, string>>) {
        expect(notices(await examPage(query)).map(([role, text]) => [role, text])).toEqual([]);
        const html = await examPage(query);
        expect(html).toContain(`<p class="notice" role="status" data-testid="mock-time-up">${timeUp}</p>`);
        expect(html).not.toContain("Your exam was submitted.");
        expect(html).not.toContain('role="alert"');
      }
      const html = await examPage();
      expect(html).toContain("Time ran out, so the answers saved by then were submitted. They are locked.");
      expect(html.match(/<textarea[^>]*readOnly=""/g)).toHaveLength(2);
      expect(html).not.toContain("<button");
      // A normal submit of a timed exam keeps the normal wording.
      mocks.getMockExam.mockResolvedValue(exam({ ...running, remainingMs: null, status: "SUBMITTED", submittedAt: new Date() }));
      const normal = await examPage({ submitted: "1" });
      expect(normal).toContain("Your exam was submitted.");
      expect(normal).not.toContain(timeUp);
      expect(normal).toContain("Submitted. Your answers are locked.");
    });
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
    expect(mocks.createMockExam).toHaveBeenCalledWith("student-1", { courseId: "course-a", length: "6", difficulty: "HARD", topics: ["tcp", "dns"], includeGenerated: true, timeLimit: "" });
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
      status: "error", error: "not_enough_questions", available: 4, values: { length: "9", difficulty: "EASY", topics: ["tcp"], includeGenerated: false, timeLimit: "" },
    });
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    mocks.createMockExam.mockClear();
    await expect(createMockExamAction(state, form({ courseId: "course-a", length: "9", difficulty: "EASY" }))).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mocks.createMockExam).not.toHaveBeenCalled();
  });
  it("passes the chosen time limit, and keeps it after a refusal (US-48)", async () => {
    await expect(createMockExamAction(state, form({ courseId: "course-a", length: "6", difficulty: "HARD", timeLimit: "45" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.createMockExam.mock.calls[0][1]).toMatchObject({ timeLimit: "45" });
    mocks.createMockExam.mockResolvedValue({ ok: false, error: "time_limit_invalid" });
    expect(await createMockExamAction(state, form({ courseId: "course-a", length: "6", difficulty: "HARD", timeLimit: "7" }))).toMatchObject({ status: "error", error: "time_limit_invalid", values: { timeLimit: "7" } });
  });
  it("starts the session student's timed exam and comes back to it (US-48)", async () => {
    mocks.startMockExam.mockResolvedValue({ ok: true, started: true });
    await expect(startMockExamAction(form({ courseId: "course-a", mockExamId: "mock-1", userId: "student-2" }))).rejects.toThrow("NEXT_REDIRECT /courses/course-a/mock-exams/mock-1");
    expect(mocks.requireUser).toHaveBeenCalledWith("/courses/course-a/mock-exams/mock-1");
    expect(mocks.startMockExam).toHaveBeenCalledWith("student-1", "mock-1");
    mocks.startMockExam.mockResolvedValue({ ok: false, error: "not_found" });
    await expect(startMockExamAction(form({ courseId: "course-a", mockExamId: "nope" }))).rejects.toThrow("?error=not_found");
    mocks.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    mocks.startMockExam.mockClear();
    await expect(startMockExamAction(form({ courseId: "course-a", mockExamId: "mock-1" }))).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mocks.startMockExam).not.toHaveBeenCalled();
  });
  it("autosaves for the session student and answers with the server's time left only (US-48)", async () => {
    mocks.getCurrentUser.mockResolvedValue(student);
    mocks.saveMockExam.mockResolvedValue({ ok: true, submitted: false, remainingMs: 61_000 });
    expect(await autosaveMockExamAction(form({ courseId: "course-a", mockExamId: "mock-1", "answer_mq-1": "typed", intent: "save", userId: "student-2" })))
      .toEqual({ ok: true, remainingMs: 61_000, timedOut: false });
    expect(mocks.saveMockExam).toHaveBeenLastCalledWith("student-1", "mock-1", { "mq-1": "typed" }, "save");
    // The final save at zero.
    mocks.saveMockExam.mockResolvedValue({ ok: true, submitted: true, timedOut: true, remainingMs: 0 });
    expect(await autosaveMockExamAction(form({ courseId: "course-a", mockExamId: "mock-1", "answer_mq-1": "last", intent: "finish" }))).toEqual({ ok: true, remainingMs: 0, timedOut: true });
    expect(mocks.saveMockExam).toHaveBeenLastCalledWith("student-1", "mock-1", { "mq-1": "last" }, "finish");
    // It can never submit as the student: any other intent is a save.
    await autosaveMockExamAction(form({ courseId: "course-a", mockExamId: "mock-1", intent: "submit" }));
    expect(mocks.saveMockExam).toHaveBeenLastCalledWith("student-1", "mock-1", {}, "save");
    // A refusal comes back as its code; nothing is redirected, so the typed answers stay on the page.
    mocks.saveMockExam.mockResolvedValue({ ok: false, error: "time_up" });
    expect(await autosaveMockExamAction(form({ courseId: "course-a", mockExamId: "mock-1", intent: "save" }))).toEqual({ ok: false, error: "time_up" });
    mocks.saveMockExam.mockResolvedValue({ ok: false, error: "not_started" });
    expect(await autosaveMockExamAction(form({ courseId: "course-a", mockExamId: "mock-1", intent: "save" }))).toEqual({ ok: false, error: "not_started" });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
  it("saves nothing for a visitor's autosave, and says the session ended", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.saveMockExam.mockClear();
    expect(await autosaveMockExamAction(form({ courseId: "course-a", mockExamId: "mock-1", "answer_mq-1": "typed", intent: "finish" }))).toEqual({ ok: false, error: "signed_out" });
    expect(mocks.saveMockExam).not.toHaveBeenCalled();
  });
  it("comes back to the exam page, not to an error, when a plain save arrives after time ran out", async () => {
    mocks.saveMockExam.mockResolvedValue({ ok: false, error: "time_up" });
    await expect(saveMockExamAction(form({ courseId: "course-a", mockExamId: "mock-1", "answer_mq-1": "late", intent: "save" })))
      .rejects.toThrow("NEXT_REDIRECT /courses/course-a/mock-exams/mock-1?error=time_up");
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
