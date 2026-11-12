import { beforeEach, describe, expect, it, vi } from "vitest";

// The advice feed service (US-38) with the database mocked: what it asks for, and what it hands to the page.

const { advice } = vi.hoisted(() => ({ advice: { count: vi.fn(), findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: { advice } }));
import { getCourseAdvice, toAdviceItem, visibleCourseAdvice } from "@/lib/advice";
import { ADVICE_PAGE_SIZE, ANONYMOUS_AUTHOR } from "@/lib/advice-rules";

let errors: ReturnType<typeof vi.spyOn>;
const logged = () => errors.mock.calls.map(call => JSON.parse(String(call[0])));

const createdAt = new Date("2026-11-10T09:00:00Z");
const row = (overrides: Record<string, unknown> = {}) => ({
  id: "advice-1", body: "Do every past final twice.", anonymous: false, scope: "COURSE", topic: null, resourceUrl: null, editedAt: null, createdAt,
  author: { name: "Lea Tass" }, file: null, term: null, questionGroup: null, ...overrides,
}) as Parameters<typeof toAdviceItem>[0];

beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  advice.count.mockReset().mockResolvedValue(1);
  advice.findMany.mockReset().mockResolvedValue([row()]);
});

describe("visibleCourseAdvice", () => {
  it("keeps the course's visible advice and leaves out targets of another course", () => {
    expect(visibleCourseAdvice("course-a")).toEqual({
      courseId: "course-a",
      status: "VISIBLE",
      NOT: [{ file: { is: { courseId: { not: "course-a" } } } }, { questionGroup: { is: { courseId: { not: "course-a" } } } }],
    });
  });
});

describe("toAdviceItem", () => {
  it("shows the author's name and the advice", () => {
    expect(toAdviceItem(row())).toEqual({
      id: "advice-1", body: "Do every past final twice.", author: "Lea Tass", anonymous: false,
      about: { scope: "COURSE", targetGone: false }, resourceUrl: null, createdAt, edited: false,
    });
  });
  it("never carries an anonymous author's name", () => {
    const item = toAdviceItem(row({ anonymous: true }));
    expect(item.author).toBe(ANONYMOUS_AUTHOR);
    expect(JSON.stringify(item)).not.toContain("Lea Tass");
  });
  it("names a published exam paper, and treats an unpublished or material file as gone", () => {
    const file = { id: "file-1", title: "Final 2024", category: "EXAM", status: "PUBLISHED" };
    expect(toAdviceItem(row({ scope: "EXAM", file })).about).toEqual({ scope: "EXAM", label: "Final 2024", fileId: "file-1" });
    for (const other of [{ ...file, status: "PENDING" }, { ...file, status: "REJECTED" }, { ...file, category: "MATERIAL" }]) {
      const item = toAdviceItem(row({ scope: "EXAM", file: other }));
      expect(item.about).toEqual({ scope: "COURSE", targetGone: true });
      expect(JSON.stringify(item)).not.toContain("Final 2024");
    }
  });
  it("shows only an https resource and marks edited advice", () => {
    expect(toAdviceItem(row({ resourceUrl: "https://example.com/notes" })).resourceUrl).toBe("https://example.com/notes");
    expect(toAdviceItem(row({ resourceUrl: "javascript:alert(1)" })).resourceUrl).toBeNull();
    expect(toAdviceItem(row({ editedAt: new Date() })).edited).toBe(true);
  });
});

describe("getCourseAdvice", () => {
  it("reads one page of the course's visible advice, newest first", async () => {
    advice.count.mockResolvedValue(45);
    const feed = await getCourseAdvice("course-a", "2");
    expect(feed).toMatchObject({ total: 45, page: 2, totalPages: 3 });
    expect(advice.count).toHaveBeenCalledWith({ where: visibleCourseAdvice("course-a") });
    expect(advice.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: visibleCourseAdvice("course-a"), orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: ADVICE_PAGE_SIZE, take: ADVICE_PAGE_SIZE,
    }));
  });
  it("sends a page past the end to the last page", async () => {
    advice.count.mockResolvedValue(21);
    expect(await getCourseAdvice("course-a", 9)).toMatchObject({ page: 2, totalPages: 2 });
    expect(advice.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: ADVICE_PAGE_SIZE }));
  });
  it("does not read rows when the course has no advice", async () => {
    advice.count.mockResolvedValue(0);
    expect(await getCourseAdvice("course-a")).toEqual({ items: [], total: 0, page: 1, totalPages: 1 });
    expect(advice.findMany).not.toHaveBeenCalled();
  });
  it("logs a failed read with the course and error type only, and rethrows it", async () => {
    advice.findMany.mockRejectedValue(Object.assign(new Error("connection lost"), { name: "PrismaClientKnownRequestError" }));
    await expect(getCourseAdvice("course-a")).rejects.toThrow("connection lost");
    expect(logged()).toContainEqual(expect.objectContaining({ event: "advice_feed_retrieval_failed", courseId: "course-a", errorType: "PrismaClientKnownRequestError" }));
    expect(JSON.stringify(logged())).not.toContain("connection lost");
  });
});
