import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { courseFile, processExamFile, requireAdmin, redirect } = vi.hoisted(() => ({
  courseFile: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  processExamFile: vi.fn(),
  requireAdmin: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`NEXT_REDIRECT ${location}`); }),
}));
vi.mock("@/lib/db", () => ({ db: { courseFile } }));
vi.mock("@/lib/exam-processing", () => ({ processExamFile }));
vi.mock("@/lib/auth", () => ({ requireAdmin }));
vi.mock("next/navigation", () => ({ redirect }));
import { publishSubmissionAction, rejectSubmissionAction } from "@/lib/submission-review-actions";
import { getReviewQueue, REVIEW_PAGE_SIZE, reviewSubmission } from "@/lib/submission-review";
import { reviewMessage } from "@/lib/submission-review-rules";
import { resetRateLimits } from "@/lib/rate-limit";
import { SLOW_OPERATION_MS } from "@/lib/timing";

let errors: ReturnType<typeof vi.spyOn>;
const logged = () => errors.mock.calls.map(call => JSON.parse(String(call[0])));
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const redirectedTo = async (run: Promise<unknown>) => {
  await expect(run).rejects.toThrow("NEXT_REDIRECT");
  return redirect.mock.calls.at(-1)?.[0];
};

beforeEach(() => {
  resetRateLimits();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  courseFile.count.mockReset().mockResolvedValue(0);
  courseFile.findMany.mockReset().mockResolvedValue([]);
  courseFile.findUnique.mockReset().mockResolvedValue({ id: "file-a", courseId: "course-a", category: "EXAM" });
  courseFile.updateMany.mockReset().mockResolvedValue({ count: 1 });
  processExamFile.mockReset().mockResolvedValue({ ok: true });
  requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", role: "ADMIN" });
  redirect.mockClear();
});
afterEach(() => {
  errors.mockRestore();
  vi.unstubAllEnvs();
});

describe("review queue pages", () => {
  it("asks for one page, oldest first, and does not query rows when nothing is waiting", async () => {
    expect(await getReviewQueue()).toEqual({ items: [], total: 0, page: 1, totalPages: 1 });
    expect(courseFile.findMany).not.toHaveBeenCalled();

    courseFile.count.mockResolvedValue(45);
    const queue = await getReviewQueue(2);
    expect(queue).toMatchObject({ total: 45, page: 2, totalPages: 3 });
    const query = courseFile.findMany.mock.calls[0][0];
    expect(query).toMatchObject({ where: { status: "PENDING" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: REVIEW_PAGE_SIZE, take: REVIEW_PAGE_SIZE });
  });
  it("falls back to the first or last page for an invalid or out-of-range page", async () => {
    courseFile.count.mockResolvedValue(45);
    for (const [requested, page] of [[0, 1], [-2, 1], [Number.NaN, 1], [1.5, 1], [99, 3]] as const) {
      courseFile.findMany.mockClear();
      expect((await getReviewQueue(requested)).page).toBe(page);
      expect(courseFile.findMany.mock.calls[0][0]).toMatchObject({ skip: (page - 1) * REVIEW_PAGE_SIZE });
    }
  });
  it("logs a failed count and rethrows", async () => {
    courseFile.count.mockRejectedValue(new TypeError("down"));
    await expect(getReviewQueue()).rejects.toThrow("down");
    expect(logged()).toContainEqual(expect.objectContaining({ event: "submission_retrieval_failed", entity: "pending_count", errorType: "TypeError" }));
  });
  it("logs a slow queue as slow_operation", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(SLOW_OPERATION_MS + 1);
    await getReviewQueue();
    now.mockRestore();
    expect(logged()).toContainEqual(expect.objectContaining({ event: "slow_operation", operation: "review_queue" }));
  });
});

describe("reviewing a submission", () => {
  it("publishes, regroups the exam's course, and records which admin did it", async () => {
    expect(await reviewSubmission("admin-1", "publish", "file-a")).toEqual({ ok: true });
    expect(courseFile.updateMany).toHaveBeenCalledWith({ where: { id: "file-a", status: "PENDING" }, data: expect.objectContaining({ status: "PUBLISHED" }) });
    expect(processExamFile).toHaveBeenCalledWith("file-a");
    expect(logged()).toContainEqual(expect.objectContaining({ event: "submission_reviewed", level: "info", fileId: "file-a", courseId: "course-a", operation: "publish", userId: "admin-1" }));
  });
  it("rejects with the trimmed reason and never logs it", async () => {
    expect(await reviewSubmission("admin-1", "reject", "file-a", "  Wrong course: this is EECE 351  ")).toEqual({ ok: true });
    expect(courseFile.updateMany).toHaveBeenCalledWith({ where: { id: "file-a", status: "PENDING" }, data: expect.objectContaining({ status: "REJECTED", rejectionReason: "Wrong course: this is EECE 351" }) });
    expect(processExamFile).not.toHaveBeenCalled();
    expect(JSON.stringify(logged())).not.toContain("Wrong course");
  });
  it("logs each refusal with its reason and returns it", async () => {
    expect(await reviewSubmission("admin-1", "reject", "file-a", "   ")).toEqual({ ok: false, error: "reason_required" });
    courseFile.updateMany.mockResolvedValue({ count: 0 });
    expect(await reviewSubmission("admin-1", "publish", "file-a")).toEqual({ ok: false, error: "not_pending" });
    courseFile.findUnique.mockResolvedValue(null);
    expect(await reviewSubmission("admin-1", "publish", "")).toEqual({ ok: false, error: "not_found" });
    expect(logged().filter(line => line.event === "submission_review_refused").map(line => [line.operation, line.reason, line.fileId])).toEqual([
      ["reject", "reason_required", "file-a"], ["publish", "not_pending", "file-a"], ["publish", "not_found", undefined],
    ]);
    expect(logged().some(line => line.event === "submission_reviewed")).toBe(false);
  });
  it("times every review in the log", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(SLOW_OPERATION_MS + 400);
    await reviewSubmission("admin-1", "publish", "file-a");
    now.mockRestore();
    expect(logged()).toContainEqual(expect.objectContaining({ event: "slow_operation", operation: "submission_publish", fileId: "file-a", userId: "admin-1", durationMs: String(SLOW_OPERATION_MS + 400) }));
  });
  it("refuses an admin past the per-minute limit without touching the database, and not another admin", async () => {
    vi.stubEnv("REVIEW_RATE_LIMIT_PER_MINUTE", "2");
    await reviewSubmission("admin-1", "publish", "file-a");
    await reviewSubmission("admin-1", "publish", "file-a");
    courseFile.updateMany.mockClear();
    expect(await reviewSubmission("admin-1", "reject", "file-a", "Too blurry")).toEqual({ ok: false, error: "rate_limited" });
    expect(courseFile.updateMany).not.toHaveBeenCalled();
    expect(logged()).toContainEqual(expect.objectContaining({ event: "submission_review_rate_limited", level: "warn", userId: "admin-1", retryAfterSeconds: expect.any(String) }));
    expect(await reviewSubmission("admin-2", "publish", "file-a")).toEqual({ ok: true });
  });
  it("lets a database failure through after the submission service logs it", async () => {
    courseFile.updateMany.mockRejectedValue(new TypeError("down"));
    await expect(reviewSubmission("admin-1", "publish", "file-a")).rejects.toThrow("down");
    expect(logged()).toContainEqual(expect.objectContaining({ event: "submission_review_failed", fileId: "file-a" }));
  });
});

describe("review actions", () => {
  it("check the admin before doing anything", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(publishSubmissionAction(form({ id: "file-a" }))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(rejectSubmissionAction(form({ id: "file-a", reason: "x" }))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(requireAdmin).toHaveBeenCalledWith("/admin/submissions");
    expect(courseFile.updateMany).not.toHaveBeenCalled();
  });
  it("return to the same queue page with the outcome, and never put the reason in the URL", async () => {
    expect(await redirectedTo(publishSubmissionAction(form({ id: "file-a", page: "3" })))).toBe("/admin/submissions?published=1&page=3");
    expect(await redirectedTo(rejectSubmissionAction(form({ id: "file-a", reason: "Blurry scan", page: "1" })))).toBe("/admin/submissions?rejected=1");
    expect(await redirectedTo(rejectSubmissionAction(form({ id: "file-a", reason: "" })))).toBe("/admin/submissions?error=reason_required");
    expect(await redirectedTo(publishSubmissionAction(form({ id: "file-a", page: "../x" })))).toBe("/admin/submissions?published=1");
    expect(redirect.mock.calls.flat().join(" ")).not.toContain("Blurry");
  });
});

describe("review messages", () => {
  it("explain every refusal and never echo an unknown value", () => {
    for (const error of ["not_found", "not_pending", "reason_required", "reason_too_long", "rate_limited"]) expect(reviewMessage(error)).not.toMatch(/went wrong/);
    expect(reviewMessage("reason_too_long")).toContain("500");
    expect(reviewMessage("<script>")).toBe("Something went wrong. Please try again.");
    expect(reviewMessage("toString")).toBe("Something went wrong. Please try again.");
  });
});

describe("edge and hostile inputs", () => {
  it("treat a missing, file-valued, or huge ID as an unknown submission", async () => {
    courseFile.updateMany.mockResolvedValue({ count: 0 });
    courseFile.findUnique.mockResolvedValue(null);
    const data = form({ reason: "x" });
    data.set("id", new File(["%PDF"], "id.pdf"));
    expect(await redirectedTo(rejectSubmissionAction(data))).toBe("/admin/submissions?error=not_found");
    expect(await redirectedTo(publishSubmissionAction(form({})))).toBe("/admin/submissions?error=not_found");
    expect(await redirectedTo(publishSubmissionAction(form({ id: "x".repeat(100_000) })))).toBe("/admin/submissions?error=not_found");
    // A huge ID is cut down in the log, never written whole.
    expect(logged().every(line => String(line.fileId ?? "").length <= 201)).toBe(true);
  });
  it("count the reason after trimming, at exactly 500 characters, including emoji and line breaks", async () => {
    expect(await reviewSubmission("admin-1", "reject", "file-a", `  ${"r".repeat(500)}  `)).toEqual({ ok: true });
    expect(await reviewSubmission("admin-1", "reject", "file-a", "r".repeat(501))).toEqual({ ok: false, error: "reason_too_long" });
    // An emoji is two UTF-16 units, the same count the browser's maxLength uses.
    expect(await reviewSubmission("admin-1", "reject", "file-a", "📄".repeat(250))).toEqual({ ok: true });
    expect(await reviewSubmission("admin-1", "reject", "file-a", "📄".repeat(251))).toEqual({ ok: false, error: "reason_too_long" });
    await reviewSubmission("admin-1", "reject", "file-a", "Page 2 is missing.\nPlease resubmit.");
    expect(courseFile.updateMany.mock.calls.at(-1)?.[0].data.rejectionReason).toBe("Page 2 is missing.\nPlease resubmit.");
  });
  it("refuse a reason made only of spaces, line breaks, or invisible characters the student could not read", async () => {
    const blanks = [" ", "\t\n\r", ...[[0xa0, 0xa0], [0x2003], [0x200b, 0x200b], [0x200d], [0x2060], [0x3164], [0x2800], [0xfeff]].map(codes => String.fromCodePoint(...codes))];
    for (const blank of blanks) {
      expect(await reviewSubmission("admin-1", "reject", "file-a", blank)).toEqual({ ok: false, error: "reason_required" });
    }
    expect(courseFile.updateMany).not.toHaveBeenCalled();
    // Any readable text is enough, in any script.
    const scripts = [[0x3f], [0x663], [0x62e, 0x637, 0x623], [0x9519, 0x8bef], [0x2717]].map(codes => String.fromCodePoint(...codes));
    for (const reason of scripts) expect(await reviewSubmission("admin-1", "reject", "file-a", reason)).toEqual({ ok: true });
  });
  it("count refused reviews toward the rate limit, so a flood of bad requests is stopped too", async () => {
    vi.stubEnv("REVIEW_RATE_LIMIT_PER_MINUTE", "3");
    for (let index = 0; index < 3; index++) await reviewSubmission("admin-1", "reject", "file-a", "");
    expect(await reviewSubmission("admin-1", "reject", "file-a", "")).toEqual({ ok: false, error: "rate_limited" });
  });
  it("show page 1 for a page value that is not a whole number", async () => {
    courseFile.count.mockResolvedValue(45);
    expect(await redirectedTo(publishSubmissionAction(form({ id: "file-a", page: "2.5" })))).toBe("/admin/submissions?published=1");
    expect(await redirectedTo(publishSubmissionAction(form({ id: "file-a", page: "-4" })))).toBe("/admin/submissions?published=1");
    expect(await redirectedTo(publishSubmissionAction(form({ id: "file-a", page: "2&admin=1" })))).toBe("/admin/submissions?published=1");
  });
});
