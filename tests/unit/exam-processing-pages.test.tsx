import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), getRuns: vi.fn(), retry: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/exam-processing", () => ({
  getExamProcessingRuns: mocks.getRuns,
  retryFailedExam: mocks.retry,
  canRetryRun: (run: { status: string }) => run.status === "FAILED",
  processingReason: (reason: string) => reason === "no_text" ? "No extractable text was found in this PDF." : "Processing failed unexpectedly.",
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
import ProcessingPage from "@/app/admin/processing/page";
import { retryExamAction } from "@/lib/exam-processing-actions";

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.getRuns.mockResolvedValue([]);
});

describe("admin exam processing page", () => {
  it("passes the displayed run ID to the retry service to reject a stale form", async () => {
    const form = new FormData();
    form.set("fileId", "file-a");
    form.set("runId", "old-run");
    mocks.retry.mockResolvedValue({ ok: false, reason: "not_failed" });
    await retryExamAction(form);
    expect(mocks.retry).toHaveBeenCalledWith("file-a", "old-run");
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/processing?error=not_failed");
  });
  it("shows the latest failed stage, reason, and retry control", async () => {
    mocks.getRuns.mockResolvedValue([{ id: "file-a", title: "Final", course: { code: "EECE350" },
      processingRuns: [{ id: "run-a", status: "FAILED", stage: "EXTRACTION", reason: "no_text" }] }]);
    const html = renderToStaticMarkup(await ProcessingPage({ searchParams: Promise.resolve({}) }));
    expect(mocks.requireAdmin).toHaveBeenCalledWith("/admin/processing");
    expect(html).toContain("Text extraction");
    expect(html).toContain("No extractable text was found in this PDF.");
    expect(html).toContain('name="runId" value="run-a"');
    expect(html).toContain("Retry");
  });

  it("checks admin access before retrying", async () => {
    const form = new FormData();
    form.set("fileId", "file-a");
    mocks.retry.mockResolvedValue({ ok: true, runId: "run-b" });
    await retryExamAction(form);
    expect(mocks.requireAdmin).toHaveBeenCalledWith("/admin/processing");
    expect(mocks.retry).toHaveBeenCalledWith("file-a");
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/processing?retried=1");
  });

  it("reports that a retry ran even when the PDF still has no text", async () => {
    const form = new FormData();
    form.set("fileId", "file-a");
    mocks.retry.mockResolvedValue({ ok: false, runId: "run-b", reason: "no_text" });
    await retryExamAction(form);
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/processing?retried=1");
  });

  it("never calls the retry service when the admin guard rejects the request", async () => {
    mocks.requireAdmin.mockRejectedValue(new Error("access denied"));
    await expect(retryExamAction(new FormData())).rejects.toThrow("access denied");
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("handles a run disappearing between the file and relation reads", async () => {
    mocks.getRuns.mockResolvedValue([{ id: "file-a", title: "Final", course: { code: "EECE350" }, processingRuns: [] }]);
    const html = renderToStaticMarkup(await ProcessingPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("No exams have been processed yet.");
  });
});
