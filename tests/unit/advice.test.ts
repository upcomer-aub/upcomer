import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  course: { findUnique: vi.fn() },
  courseFile: { findFirst: vi.fn(), findMany: vi.fn() },
  questionGroup: { findFirst: vi.fn() },
  advice: { create: vi.fn(), count: vi.fn(), findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(), errorCode: (error: unknown) => (error as { code?: string } | null)?.code }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(() => ({ ok: true })), limitFromEnv: (_name: string, fallback: number) => fallback }));

import { checkRateLimit } from "@/lib/rate-limit";
import { publishAdvice, resetAdviceCache, searchAdvice, toPublicAdvice, type AdviceRow, type PublishInput } from "@/lib/advice";

const COURSE = { id: "course-1", code: "CS101" };

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  courseId: COURSE.id, scopeKind: "COURSE", scopeValue: "", title: "Start the labs early", body: "The labs take longer than they look.",
  resourceUrl: "", resourceTitle: "", isAnonymous: false, ...over,
});

const row = (over: Partial<AdviceRow> = {}): AdviceRow => ({
  id: "advice-1", courseId: COURSE.id, authorId: "author-secret-id", isAnonymous: false, scopeKind: "COURSE", scopeLabel: "CS101",
  fileId: null, termId: null, groupId: null, topic: null, title: "Title", body: "Body", resourceUrl: null, resourceTitle: null,
  createdAt: new Date("2026-11-02T10:00:00Z"), author: { name: "Real Author Name" }, ...over,
});

beforeEach(() => {
  resetAdviceCache();
  vi.clearAllMocks();
  db.course.findUnique.mockResolvedValue(COURSE);
  db.advice.create.mockResolvedValue({ id: "advice-1" });
  db.advice.count.mockResolvedValue(0);
  db.advice.findMany.mockResolvedValue([]);
});

describe("publishAdvice: scope (US-34)", () => {
  it("publishes course-wide advice for the session user", async () => {
    const result = await publishAdvice("user-1", input());
    expect(result).toEqual({ ok: true, id: "advice-1" });
    expect(db.advice.create.mock.calls[0][0].data).toMatchObject({ courseId: COURSE.id, authorId: "user-1", scopeKind: "COURSE", scopeLabel: "CS101", isAnonymous: false });
  });

  it("refuses an exam paper that is not a published exam of this course", async () => {
    db.courseFile.findFirst.mockResolvedValue(null);
    const result = await publishAdvice("user-1", input({ scopeKind: "EXAM", scopeValue: "paper-of-another-course" }));
    expect(result).toEqual({ ok: false, error: "scope_invalid" });
    expect(db.courseFile.findFirst.mock.calls[0][0].where).toMatchObject({ id: "paper-of-another-course", courseId: COURSE.id });
    expect(db.advice.create).not.toHaveBeenCalled();
  });

  it("refuses a session, question, or exam with no target", async () => {
    for (const scopeKind of ["EXAM", "SESSION", "QUESTION", "TOPIC"]) {
      expect(await publishAdvice("user-1", input({ scopeKind, scopeValue: "  " }))).toEqual({ ok: false, error: "scope_invalid" });
    }
    expect(db.advice.create).not.toHaveBeenCalled();
  });

  it("refuses an unknown scope kind", async () => {
    expect(await publishAdvice("user-1", input({ scopeKind: "PROFESSOR" }))).toEqual({ ok: false, error: "scope_invalid" });
  });

  it("refuses a question group of another course", async () => {
    db.questionGroup.findFirst.mockResolvedValue(null);
    expect(await publishAdvice("user-1", input({ scopeKind: "QUESTION", scopeValue: "group-x" }))).toEqual({ ok: false, error: "scope_invalid" });
    expect(db.questionGroup.findFirst.mock.calls[0][0].where).toMatchObject({ id: "group-x", courseId: COURSE.id });
  });

  it("saves an exam scope with the paper's title as its label", async () => {
    db.courseFile.findFirst.mockResolvedValue({ id: "paper-1", title: "Final 2025" });
    await publishAdvice("user-1", input({ scopeKind: "EXAM", scopeValue: "paper-1" }));
    expect(db.advice.create.mock.calls[0][0].data).toMatchObject({ scopeKind: "EXAM", fileId: "paper-1", scopeLabel: "Final 2025" });
  });

  it("saves a topic scope only when the course has that topic, ignoring case and spacing", async () => {
    db.courseFile.findMany.mockResolvedValue([{ topic: "  TCP   Basics " }, { topic: "Routing" }]);
    await publishAdvice("user-1", input({ scopeKind: "TOPIC", scopeValue: "tcp basics" }));
    expect(db.advice.create.mock.calls[0][0].data).toMatchObject({ scopeKind: "TOPIC", topicKey: "tcp basics", topic: "TCP Basics" });
    db.advice.create.mockClear();
    expect(await publishAdvice("user-1", input({ scopeKind: "TOPIC", scopeValue: "quantum" }))).toEqual({ ok: false, error: "scope_invalid" });
    expect(db.advice.create).not.toHaveBeenCalled();
  });

  it("refuses a course that does not exist", async () => {
    db.course.findUnique.mockResolvedValue(null);
    expect(await publishAdvice("user-1", input())).toEqual({ ok: false, error: "course_not_found" });
  });

  it("treats a scope deleted between the check and the save as invalid", async () => {
    db.advice.create.mockRejectedValue({ code: "P2003" });
    expect(await publishAdvice("user-1", input())).toEqual({ ok: false, error: "scope_invalid" });
  });
});

describe("publishAdvice: text, links, limits", () => {
  it("refuses an empty title or text and too-long ones, before touching the database", async () => {
    expect(await publishAdvice("user-1", input({ title: "   " }))).toEqual({ ok: false, error: "title_required" });
    expect(await publishAdvice("user-1", input({ title: "x".repeat(121) }))).toEqual({ ok: false, error: "title_too_long" });
    expect(await publishAdvice("user-1", input({ body: "" }))).toEqual({ ok: false, error: "body_required" });
    expect(await publishAdvice("user-1", input({ body: "x".repeat(2001) }))).toEqual({ ok: false, error: "body_too_long" });
    expect(db.course.findUnique).not.toHaveBeenCalled();
  });

  it("saves a valid https link with its name (US-35)", async () => {
    await publishAdvice("user-1", input({ resourceUrl: "https://example.com/guide", resourceTitle: "  Study   guide " }));
    expect(db.advice.create.mock.calls[0][0].data).toMatchObject({ resourceUrl: "https://example.com/guide", resourceTitle: "Study guide" });
  });

  it("refuses unsafe schemes and saves nothing", async () => {
    for (const resourceUrl of ["javascript:alert(1)", "data:text/html,x", "http://example.com"]) {
      expect(await publishAdvice("user-1", input({ resourceUrl }))).toEqual({ ok: false, error: "link_invalid" });
    }
    expect(db.course.findUnique).not.toHaveBeenCalled();
    expect(db.advice.create).not.toHaveBeenCalled();
  });

  it("drops the link name when there is no link", async () => {
    await publishAdvice("user-1", input({ resourceTitle: "Orphan name" }));
    expect(db.advice.create.mock.calls[0][0].data).toMatchObject({ resourceUrl: null, resourceTitle: null });
  });

  it("stops a student who publishes too much", async () => {
    vi.mocked(checkRateLimit).mockReturnValueOnce({ ok: false, retryAfterSeconds: 30 } as ReturnType<typeof checkRateLimit>);
    expect(await publishAdvice("user-1", input())).toEqual({ ok: false, error: "rate_limited" });
    expect(db.advice.create).not.toHaveBeenCalled();
  });

  it("stores the author even for anonymous advice, so admins can handle abuse", async () => {
    await publishAdvice("user-1", input({ isAnonymous: true }));
    expect(db.advice.create.mock.calls[0][0].data).toMatchObject({ authorId: "user-1", isAnonymous: true });
  });
});

describe("toPublicAdvice: anonymity (US-37)", () => {
  it("hides the author's name and ID for anonymous advice", () => {
    const json = JSON.stringify(toPublicAdvice(row({ isAnonymous: true }), "someone-else"));
    expect(json).not.toContain("Real Author Name");
    expect(json).not.toContain("author-secret-id");
    expect(json).toContain("Anonymous student");
  });

  it("never includes the author ID, even for named advice", () => {
    const advice = toPublicAdvice(row(), "someone-else");
    expect(JSON.stringify(advice)).not.toContain("author-secret-id");
    expect(advice.authorLabel).toBe("Real Author Name");
  });

  it("tells only the author that a post is theirs, and keeps it anonymous for them too", () => {
    expect(toPublicAdvice(row({ isAnonymous: true }), "author-secret-id")).toMatchObject({ isMine: true, authorLabel: "Anonymous student" });
    expect(toPublicAdvice(row(), "someone-else").isMine).toBe(false);
    expect(toPublicAdvice(row(), null).isMine).toBe(false);
  });

  it("labels advice whose author's account was deleted", () => {
    expect(toPublicAdvice(row({ authorId: null, author: null }), "u").authorLabel).toBe("Former student");
  });
});

describe("searchAdvice (US-39)", () => {
  const whereOfFindMany = () => db.advice.findMany.mock.calls[0][0].where;

  it("always limits results to the course and to visible advice", async () => {
    await searchAdvice(COURSE.id, "user-1");
    expect(whereOfFindMany()).toMatchObject({ courseId: COURSE.id, status: "VISIBLE" });
  });

  it("keeps the course in the query when filtering by an exam or session of another course", async () => {
    await searchAdvice(COURSE.id, "user-1", { examId: "paper-of-another-course", termId: "term-x" });
    expect(whereOfFindMany()).toMatchObject({ courseId: COURSE.id, status: "VISIBLE", fileId: "paper-of-another-course", termId: "term-x" });
  });

  it("matches text in the title, body, and topic, and never searches the author", async () => {
    await searchAdvice(COURSE.id, "user-1", { query: "  labs " });
    const fields = whereOfFindMany().OR.map((clause: Record<string, unknown>) => Object.keys(clause)[0]);
    expect(fields).toEqual(["title", "body", "topic"]);
    expect(JSON.stringify(whereOfFindMany())).not.toMatch(/author/i);
  });

  it("filters by topic ignoring case and spacing", async () => {
    await searchAdvice(COURSE.id, "user-1", { topic: "  TCP   Basics " });
    expect(whereOfFindMany()).toMatchObject({ topicKey: "tcp basics" });
  });

  it("returns public advice without author IDs or anonymous names", async () => {
    db.advice.count.mockResolvedValue(1);
    db.advice.findMany.mockResolvedValue([row({ isAnonymous: true })]);
    const page = await searchAdvice(COURSE.id, "user-1");
    const json = JSON.stringify(page);
    expect(page.total).toBe(1);
    expect(json).not.toContain("author-secret-id");
    expect(json).not.toContain("Real Author Name");
  });

  it("falls back to a valid page", async () => {
    db.advice.count.mockResolvedValue(45);
    const page = await searchAdvice(COURSE.id, "user-1", { page: 99 });
    expect(page).toMatchObject({ page: 3, totalPages: 3 });
    expect(db.advice.findMany.mock.calls[0][0]).toMatchObject({ skip: 40, take: 20 });
    expect((await searchAdvice(COURSE.id, "user-1", { page: -4 })).page).toBe(1);
  });
});
