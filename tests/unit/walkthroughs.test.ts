import { beforeEach, describe, expect, it, vi } from "vitest";

// US-51: the walkthrough service and action, with the database and the AI client mocked. No test here reaches DeepSeek or a
// database. The real database is in tests/integration/walkthroughs.test.ts.

const db = vi.hoisted(() => ({
  question: { findFirst: vi.fn() },
  questionWalkthrough: { findUnique: vi.fn(), createMany: vi.fn() },
}));
const ai = vi.hoisted(() => ({ chatCompletion: vi.fn(), isAiConfigured: vi.fn() }));
const logError = vi.hoisted(() => vi.fn());
const nav = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); }),
  requireUser: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/ai-client", () => ai);
vi.mock("@/lib/logger", () => ({ logError, errorCode: (error: unknown) => (error as { code?: string } | null)?.code }));
vi.mock("next/navigation", () => ({ redirect: nav.redirect, notFound: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: nav.requireUser, getCurrentUser: vi.fn() }));

import { generateWalkthrough, getWalkthroughPage, questionTextHash, resetWalkthroughCalls } from "@/lib/walkthroughs";
import { generateWalkthroughAction } from "@/lib/walkthrough-actions";
import { WALKTHROUGH_PROMPT_VERSION, WALKTHROUGH_QUESTION_MAX_LENGTH } from "@/lib/walkthrough-rules";
import { resetRateLimits } from "@/lib/rate-limit";

const QUESTION_TEXT = "Q2. Explain how the TCP three way handshake establishes a connection (6 points)";
const SECRET_ANSWER_TEXT = "UNIQUE-ANSWER-TEXT-7731";
const questionRow = (over: Record<string, unknown> = {}) => ({
  id: "q-1", text: QUESTION_TEXT,
  file: { courseId: "course-1", title: "Final 2024", year: 2024, topic: "TCP", course: { code: "EECE350", name: "Networks" } },
  ...over,
});
const validAnswer = JSON.stringify({ steps: [
  { title: "Read what is asked", explanation: `Focus on the handshake. ${SECRET_ANSWER_TEXT}`, basis: "question", quote: "the TCP three way handshake establishes a connection" },
  { title: "Recall SYN, SYN-ACK, ACK", explanation: "List the three segments in order.", basis: "method", quote: "" },
] });
const aiOk = (content = validAnswer) => ({ ok: true, content, model: "deepseek-flash" });
const storedSteps = [
  { title: "Step one", explanation: "Do this.", basis: "method", quote: null, verified: false, unverifiedReason: "method" },
  { title: "Step two", explanation: "Then this.", basis: "question", quote: "three way handshake establishes", verified: true, unverifiedReason: null },
];
const events = () => logError.mock.calls.map(([event, context]) => ({ event, ...context }));
const generate = (userId = "student-1", courseId = "course-1", questionId = "q-1") => generateWalkthrough(userId, courseId, questionId);

beforeEach(() => {
  resetRateLimits();
  resetWalkthroughCalls();
  delete process.env.WALKTHROUGH_RATE_LIMIT_PER_HOUR;
  logError.mockReset();
  db.question.findFirst.mockReset().mockResolvedValue(questionRow());
  db.questionWalkthrough.findUnique.mockReset().mockResolvedValue(null);
  db.questionWalkthrough.createMany.mockReset().mockResolvedValue({ count: 1 });
  ai.chatCompletion.mockReset().mockResolvedValue(aiOk());
  ai.isAiConfigured.mockReset().mockReturnValue(true);
  nav.redirect.mockClear();
  nav.requireUser.mockReset().mockResolvedValue({ id: "student-1", role: "STUDENT" });
});

describe("which questions are accepted (US-51)", () => {
  it("reads only a question of a published exam paper of the course", async () => {
    await generate();
    expect(db.question.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "q-1", file: { courseId: "course-1", category: "EXAM", status: "PUBLISHED" } },
    }));
  });

  it("refuses a question of another course, or of an unpublished paper, as not found, without calling the AI", async () => {
    // The query's course and published filters exclude it, so the database returns nothing.
    db.question.findFirst.mockResolvedValue(null);
    expect(await generate("student-1", "other-course")).toEqual({ ok: false, error: "not_found" });
    expect(await generate("student-1", "course-1", "q-on-pending-paper")).toEqual({ ok: false, error: "not_found" });
    expect(ai.chatCompletion).not.toHaveBeenCalled();
    expect(db.questionWalkthrough.createMany).not.toHaveBeenCalled();
    expect(events()).toEqual([
      { event: "walkthrough_refused", userId: "student-1", courseId: "other-course", questionId: "q-1", reason: "not_found" },
      { event: "walkthrough_refused", userId: "student-1", courseId: "course-1", questionId: "q-on-pending-paper", reason: "not_found" },
    ]);
  });

  it("refuses empty IDs without reading", async () => {
    expect(await generate("student-1", "", "")).toEqual({ ok: false, error: "not_found" });
    expect(db.question.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a question that is too long, without calling the AI or counting it", async () => {
    db.question.findFirst.mockResolvedValue(questionRow({ text: "word ".repeat(WALKTHROUGH_QUESTION_MAX_LENGTH) }));
    expect(await generate()).toEqual({ ok: false, error: "question_too_long" });
    expect(ai.chatCompletion).not.toHaveBeenCalled();
  });

  it("the page read returns null for a question it does not accept", async () => {
    db.question.findFirst.mockResolvedValue(null);
    expect(await getWalkthroughPage("student-1", "course-1", "q-1")).toBeNull();
  });
});

describe("stored walkthroughs (US-51)", () => {
  it("returns a stored walkthrough without calling the AI or counting toward the limit", async () => {
    process.env.WALKTHROUGH_RATE_LIMIT_PER_HOUR = "1";
    db.questionWalkthrough.findUnique.mockResolvedValue({ id: "w-1", steps: storedSteps, createdAt: new Date() });
    for (let i = 0; i < 5; i++) expect(await generate()).toEqual({ ok: true, stored: true });
    expect(ai.chatCompletion).not.toHaveBeenCalled();
    expect(db.questionWalkthrough.createMany).not.toHaveBeenCalled();
    // The limit of 1 is untouched: a real call still works afterwards.
    db.questionWalkthrough.findUnique.mockResolvedValue(null);
    expect(await generate()).toEqual({ ok: true, stored: false });
  });

  it("looks the walkthrough up by question, text hash and prompt version", async () => {
    await getWalkthroughPage("student-1", "course-1", "q-1");
    expect(db.questionWalkthrough.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { questionId_textHash_promptVersion: { questionId: "q-1", textHash: questionTextHash(QUESTION_TEXT), promptVersion: WALKTHROUGH_PROMPT_VERSION } },
    }));
  });

  it("the page shows the stored steps, and never counts as a call", async () => {
    process.env.WALKTHROUGH_RATE_LIMIT_PER_HOUR = "1";
    db.questionWalkthrough.findUnique.mockResolvedValue({ id: "w-1", steps: storedSteps, createdAt: new Date(0) });
    for (let i = 0; i < 3; i++) {
      const page = await getWalkthroughPage("student-1", "course-1", "q-1");
      expect(page?.walkthrough?.steps).toEqual(storedSteps);
      expect(page?.question).toMatchObject({ id: "q-1", text: "Explain how the TCP three way handshake establishes a connection", paperTitle: "Final 2024", topic: "TCP" });
    }
    expect(ai.chatCompletion).not.toHaveBeenCalled();
  });

  it("does not show a stored row whose steps are not the expected shape, and logs only IDs", async () => {
    db.questionWalkthrough.findUnique.mockResolvedValue({ id: "w-bad", steps: [{ title: "x" }], createdAt: new Date() });
    const page = await getWalkthroughPage("student-1", "course-1", "q-1");
    expect(page?.walkthrough).toBeNull();
    expect(events()).toEqual([{ event: "walkthrough_retrieval_failed", questionId: "q-1", courseId: "course-1", walkthroughId: "w-bad", reason: "invalid_stored_steps" }]);
  });

  it("a failed page read is logged and rethrown", async () => {
    db.question.findFirst.mockRejectedValue(Object.assign(new Error("db down"), { code: "P1001" }));
    await expect(getWalkthroughPage("student-1", "course-1", "q-1")).rejects.toThrow("db down");
    expect(events()).toEqual([{ event: "walkthrough_retrieval_failed", userId: "student-1", courseId: "course-1", questionId: "q-1", errorType: "Error", errorCode: "P1001" }]);
  });
});

describe("the text hash (US-51)", () => {
  it("changes whenever the question text changes, even by one character or a space", () => {
    const base = questionTextHash(QUESTION_TEXT);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(questionTextHash(QUESTION_TEXT)).toBe(base);
    expect(questionTextHash(`${QUESTION_TEXT}.`)).not.toBe(base);
    expect(questionTextHash(QUESTION_TEXT.replace("TCP", "UDP"))).not.toBe(base);
    expect(questionTextHash(QUESTION_TEXT.replace(" ", "  "))).not.toBe(base);
  });

  it("a corrected question text is looked up and stored under its new hash", async () => {
    db.question.findFirst.mockResolvedValue(questionRow({ text: "Explain how the UDP checksum is computed over the header and data" }));
    await generate();
    const stored = db.questionWalkthrough.createMany.mock.calls.at(-1)?.[0].data[0];
    expect(stored.textHash).toBe(questionTextHash("Explain how the UDP checksum is computed over the header and data"));
    expect(stored.textHash).not.toBe(questionTextHash(QUESTION_TEXT));
  });
});

describe("making a walkthrough (US-51)", () => {
  it("calls the AI once with the question as data, then stores only the checked steps", async () => {
    expect(await generate()).toEqual({ ok: true, stored: false });
    expect(ai.chatCompletion).toHaveBeenCalledTimes(1);
    const [messages] = ai.chatCompletion.mock.calls[0];
    expect(messages[1].content).toContain(JSON.stringify("Explain how the TCP three way handshake establishes a connection"));
    expect(db.questionWalkthrough.createMany).toHaveBeenCalledWith({
      data: [{
        questionId: "q-1", textHash: questionTextHash(QUESTION_TEXT), promptVersion: WALKTHROUGH_PROMPT_VERSION, model: "deepseek-flash",
        steps: [
          { title: "Read what is asked", explanation: `Focus on the handshake. ${SECRET_ANSWER_TEXT}`, basis: "question", quote: "the TCP three way handshake establishes a connection", verified: true, unverifiedReason: null },
          { title: "Recall SYN, SYN-ACK, ACK", explanation: "List the three segments in order.", basis: "method", quote: null, verified: false, unverifiedReason: "method" },
        ],
      }],
      skipDuplicates: true,
    });
  });

  it("logs IDs and counts only, never the question, the prompt or the answer", async () => {
    await generate();
    const [generated] = events();
    expect(generated).toEqual({ event: "walkthrough_generated", userId: "student-1", courseId: "course-1", questionId: "q-1", steps: "2", verifiedSteps: "1", durationMs: expect.stringMatching(/^\d+$/) });
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).not.toContain("handshake");
    expect(logged).not.toContain(SECRET_ANSWER_TEXT);
    expect(logged).not.toContain("PAST_EXAM_DATA");
  });

  it.each([
    ["timeout", { error: "timeout" }, "timeout"],
    ["network failure", { error: "network_error" }, "unavailable"],
    ["HTTP error", { error: "http_error", status: 503 }, "unavailable"],
    ["malformed response", { error: "malformed" }, "invalid_output"],
    ["empty answer", { error: "empty" }, "invalid_output"],
    ["cut-off answer", { error: "truncated" }, "invalid_output"],
    ["not configured at call time", { error: "not_configured" }, "not_configured"],
  ])("an AI %s is reported, logged, and nothing is stored", async (_name, failure, expected) => {
    ai.chatCompletion.mockResolvedValue({ ok: false, ...failure });
    expect(await generate()).toEqual({ ok: false, error: expected });
    expect(db.questionWalkthrough.createMany).not.toHaveBeenCalled();
    expect(events()).toEqual([{
      event: "walkthrough_failed", userId: "student-1", courseId: "course-1", questionId: "q-1", step: "ai", reason: expected,
      aiError: failure.error, parseError: undefined, status: "status" in failure ? String(failure.status) : undefined, durationMs: expect.any(String),
    }]);
  });

  it.each([
    ["not JSON", "Here you go: step 1...", "not_json"],
    ["missing field", JSON.stringify({ steps: [{ title: "a", explanation: "b", basis: "method" }, { title: "c", explanation: "d", basis: "method", quote: "" }] }), "invalid_shape"],
    ["extra field", JSON.stringify({ steps: [], note: "x" }), "invalid_shape"],
    ["too many steps", JSON.stringify({ steps: Array.from({ length: 9 }, () => ({ title: "a", explanation: "b", basis: "method", quote: "" })) }), "step_count"],
  ])("invalid output (%s) is never stored and the student can try again", async (_name, content, parseError) => {
    ai.chatCompletion.mockResolvedValueOnce(aiOk(content));
    expect(await generate()).toEqual({ ok: false, error: "invalid_output" });
    expect(db.questionWalkthrough.createMany).not.toHaveBeenCalled();
    expect(events()[0]).toMatchObject({ event: "walkthrough_failed", step: "ai", reason: "invalid_output", parseError });
    expect(JSON.stringify(logError.mock.calls)).not.toContain(content.slice(0, 20));
    // Trying again makes a new call (nothing was stored), which can succeed.
    expect(await generate()).toEqual({ ok: true, stored: false });
    expect(ai.chatCompletion).toHaveBeenCalledTimes(2);
    expect(db.questionWalkthrough.createMany).toHaveBeenCalledTimes(1);
  });

  it("refuses when the AI is not configured, without calling it or counting it", async () => {
    process.env.WALKTHROUGH_RATE_LIMIT_PER_HOUR = "1";
    ai.isAiConfigured.mockReturnValue(false);
    expect(await generate()).toEqual({ ok: false, error: "not_configured" });
    expect(await generate()).toEqual({ ok: false, error: "not_configured" });
    expect(ai.chatCompletion).not.toHaveBeenCalled();
    ai.isAiConfigured.mockReturnValue(true);
    expect(await generate()).toEqual({ ok: true, stored: false });
  });

  it("a failed save is logged by error type and reported; a deleted question is not found", async () => {
    db.questionWalkthrough.createMany.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "P1008" }));
    expect(await generate()).toEqual({ ok: false, error: "unexpected" });
    expect(events()[0]).toEqual({ event: "walkthrough_failed", userId: "student-1", courseId: "course-1", questionId: "q-1", step: "store", errorType: "Error", errorCode: "P1008" });
    logError.mockReset();
    db.questionWalkthrough.createMany.mockRejectedValueOnce(Object.assign(new Error("fk"), { code: "P2003" }));
    expect(await generate()).toEqual({ ok: false, error: "not_found" });
    expect(events()).toEqual([{ event: "walkthrough_refused", userId: "student-1", courseId: "course-1", questionId: "q-1", reason: "not_found" }]);
  });

  it("a failed read before the call is reported as unexpected without calling the AI", async () => {
    db.questionWalkthrough.findUnique.mockRejectedValue(new TypeError("bad"));
    expect(await generate()).toEqual({ ok: false, error: "unexpected" });
    expect(ai.chatCompletion).not.toHaveBeenCalled();
    expect(events()).toEqual([{ event: "walkthrough_failed", userId: "student-1", courseId: "course-1", questionId: "q-1", step: "read", errorType: "TypeError", errorCode: undefined }]);
  });
});

describe("the per-student limit (US-51)", () => {
  it("counts real AI calls per student, and refuses over the limit without calling", async () => {
    process.env.WALKTHROUGH_RATE_LIMIT_PER_HOUR = "2";
    // Failed calls are real calls, so they count.
    ai.chatCompletion.mockResolvedValue({ ok: false, error: "timeout" });
    await generate();
    await generate();
    expect(await generate()).toEqual({ ok: false, error: "rate_limited" });
    expect(ai.chatCompletion).toHaveBeenCalledTimes(2);
    expect(events().at(-1)).toEqual({ event: "walkthrough_rate_limited", userId: "student-1", courseId: "course-1", questionId: "q-1", retryAfterSeconds: expect.stringMatching(/^\d+$/) });
    // Another student has their own limit.
    ai.chatCompletion.mockResolvedValue(aiOk());
    expect(await generate("student-2")).toEqual({ ok: true, stored: false });
  });

  it("defaults to 10 calls per hour", async () => {
    ai.chatCompletion.mockResolvedValue({ ok: false, error: "empty" });
    for (let i = 0; i < 10; i++) expect(await generate()).toEqual({ ok: false, error: "invalid_output" });
    expect(await generate()).toEqual({ ok: false, error: "rate_limited" });
    expect(ai.chatCompletion).toHaveBeenCalledTimes(10);
  });
});

describe("two students at once (US-51)", () => {
  it("share one AI call and one stored row; only the first is counted", async () => {
    process.env.WALKTHROUGH_RATE_LIMIT_PER_HOUR = "1";
    let release!: (value: unknown) => void;
    ai.chatCompletion.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = generate("student-1");
    const second = generate("student-2");
    const third = generate("student-1"); // the same student clicking twice is also shared, and not refused by the limit of 1
    await vi.waitFor(() => expect(ai.chatCompletion).toHaveBeenCalledTimes(1));
    release(aiOk());
    expect(await first).toEqual({ ok: true, stored: false });
    expect(await second).toEqual({ ok: true, stored: true });
    expect(await third).toEqual({ ok: true, stored: true });
    expect(ai.chatCompletion).toHaveBeenCalledTimes(1);
    expect(db.questionWalkthrough.createMany).toHaveBeenCalledTimes(1);
    expect(events().filter(event => event.event === "walkthrough_generated")).toHaveLength(1);
    // student-2 used no call, so their own limit of 1 is still free.
    db.question.findFirst.mockResolvedValue(questionRow({ id: "q-2", text: "Describe how DNS caching reduces lookup time" }));
    ai.chatCompletion.mockResolvedValue(aiOk(JSON.stringify({ steps: [
      { title: "a", explanation: "b", basis: "method", quote: "" }, { title: "c", explanation: "d", basis: "assumption", quote: "" },
    ] })));
    expect(await generate("student-2", "course-1", "q-2")).toEqual({ ok: true, stored: false });
  });

  it("share a failure too, and the next click makes a new call", async () => {
    let release!: (value: unknown) => void;
    ai.chatCompletion.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = generate("student-1");
    const second = generate("student-2");
    await vi.waitFor(() => expect(ai.chatCompletion).toHaveBeenCalledTimes(1));
    release({ ok: false, error: "timeout" });
    expect(await first).toEqual({ ok: false, error: "timeout" });
    expect(await second).toEqual({ ok: false, error: "timeout" });
    expect(await generate("student-2")).toEqual({ ok: true, stored: false });
    expect(ai.chatCompletion).toHaveBeenCalledTimes(2);
  });

  it("calls separately for different questions", async () => {
    db.question.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => questionRow({ id: where.id }));
    await Promise.all([generate("student-1", "course-1", "q-1"), generate("student-2", "course-1", "q-2")]);
    expect(ai.chatCompletion).toHaveBeenCalledTimes(2);
  });
});

describe("generateWalkthroughAction (US-51)", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  };

  it("sends a visitor to log in and back, without generating anything", async () => {
    nav.requireUser.mockImplementation(async (route: string) => nav.redirect(`/login?next=${encodeURIComponent(route)}`));
    await expect(generateWalkthroughAction(form({ courseId: "course-1", questionId: "q-1" }))).rejects.toThrow("NEXT_REDIRECT /login?next=%2Fcourses%2Fcourse-1%2Fquestions%2Fq-1%2Fwalkthrough");
    expect(db.question.findFirst).not.toHaveBeenCalled();
    expect(ai.chatCompletion).not.toHaveBeenCalled();
  });

  it("uses the session student, never a user ID from the form, and comes back to the walkthrough", async () => {
    await expect(generateWalkthroughAction(form({ courseId: "course-1", questionId: "q-1", userId: "someone-else" }))).rejects.toThrow("NEXT_REDIRECT /courses/course-1/questions/q-1/walkthrough");
    expect(nav.requireUser).toHaveBeenCalledWith("/courses/course-1/questions/q-1/walkthrough");
    expect(events()[0]).toMatchObject({ event: "walkthrough_generated", userId: "student-1" });
  });

  it("comes back with only the reason code on a refusal", async () => {
    ai.chatCompletion.mockResolvedValue({ ok: false, error: "truncated" });
    await expect(generateWalkthroughAction(form({ courseId: "course-1", questionId: "q-1" }))).rejects.toThrow("NEXT_REDIRECT /courses/course-1/questions/q-1/walkthrough?error=invalid_output");
  });

  it("encodes the IDs in the address", async () => {
    db.question.findFirst.mockResolvedValue(null);
    await expect(generateWalkthroughAction(form({ courseId: "a/b", questionId: "q?x=1" }))).rejects.toThrow("NEXT_REDIRECT /courses/a%2Fb/questions/q%3Fx%3D1/walkthrough?error=not_found");
  });
});
