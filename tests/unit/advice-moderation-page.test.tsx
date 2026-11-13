import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The admin queue of reported advice (US-77): admins only, each advice as students see it with its reports, and the two
// decisions.

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(), getAdviceReportQueue: vi.fn(),
}));
vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/advice-moderation", () => ({ getAdviceReportQueue: mocks.getAdviceReportQueue }));
vi.mock("@/lib/advice-moderation-actions", () => ({ moderateAdviceAction: vi.fn() }));
import AdviceReportsPage from "@/app/admin/advice-reports/page";

const at = (minute: number) => new Date(`2026-11-12T08:${String(minute).padStart(2, "0")}:00Z`);
const course = { id: "course-a", code: "EECE350", name: "Computer Networks" };
const entry = (overrides: Record<string, unknown> = {}) => ({
  advice: {
    id: "advice-1", body: "The TA is <b>useless</b>.", author: "Anonymous student", anonymous: true, about: { scope: "COURSE", targetGone: false },
    resourceUrl: null, createdAt: at(0), edited: false,
  },
  course, shown: true, firstReportedAt: at(5),
  reasons: [{ reason: "OFFENSIVE", count: 2 }, { reason: "SPAM", count: 1 }],
  reports: [
    { id: "r1", reason: "OFFENSIVE", note: "Insults a TA.", createdAt: at(5) },
    { id: "r2", reason: "OFFENSIVE", note: null, createdAt: at(6) },
    { id: "r3", reason: "SPAM", note: null, createdAt: at(7) },
  ],
  ...overrides,
});
const queue = (items: unknown[], extra: Record<string, number> = {}) => ({ items, total: items.length, reportCount: 3, page: 1, totalPages: 1, ...extra });
const page = (searchParams: Record<string, string> = {}) => AdviceReportsPage({ searchParams: Promise.resolve(searchParams) }).then(renderToStaticMarkup);

beforeEach(() => {
  mocks.requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", role: "ADMIN" });
  mocks.getAdviceReportQueue.mockReset().mockResolvedValue(queue([entry()]));
});

describe("the advice reports page (US-77)", () => {
  it("is for admins only: anyone else is stopped before the queue is read", async () => {
    mocks.requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.requireAdmin).toHaveBeenCalledWith("/admin/advice-reports");
    expect(mocks.getAdviceReportQueue).not.toHaveBeenCalled();
  });
  it("shows each reported advice as students see it, with its reasons, notes, and both decisions", async () => {
    const html = await page();
    expect(html).toContain("<h1>Advice Reports</h1>");
    expect(html).toContain("1 advice with 3 open reports.");
    expect(html).toContain("EECE350");
    expect(html).toContain("The TA is &lt;b&gt;useless&lt;/b&gt;.");
    expect(html).toContain("By Anonymous student");
    expect(html).toContain("Reported by 3 students, first on 2026-11-12 08:05 UTC · Offensive ×2 · Spam or off-topic");
    expect(html).toContain("Insults a TA.");
    expect(html).toContain('name="decision" value="remove"');
    expect(html).toContain('name="decision" value="keep"');
    expect(html).toContain(">Remove advice</button>");
    expect(html).toContain(">Keep advice</button>");
    expect(html).toContain('href="/courses/course-a/advice"');
  });
  it("offers only to close the reports of advice its author already deleted", async () => {
    mocks.getAdviceReportQueue.mockResolvedValue(queue([entry({ shown: false })]));
    const html = await page();
    expect(html).toContain("Its author already deleted this advice");
    expect(html).toContain(">Close reports</button>");
    expect(html).not.toContain("Keep advice");
    expect(html).not.toContain('value="keep"');
  });
  it("shows the outcome of a decision, and a refusal by its message only", async () => {
    expect(await page({ removed: "1" })).toContain("The advice was removed. Students no longer see it, and its reports are resolved.");
    expect(await page({ kept: "1" })).toContain("The advice was kept, and its reports are dismissed.");
    expect(await page({ error: "not_found" })).toContain("Another admin may have decided on it already.");
    const typed = await page({ error: "<img src=x>" });
    expect(typed).toContain("Your decision could not be saved. Please try again.");
    expect(typed).not.toContain("<img src=x>");
  });
  it("says so when nothing is reported, and pages a long queue", async () => {
    mocks.getAdviceReportQueue.mockResolvedValue(queue([]));
    expect(await page()).toContain("No advice is reported.");
    mocks.getAdviceReportQueue.mockResolvedValue(queue([entry()], { total: 45, page: 2, totalPages: 3 }));
    const html = await page({ page: "2" });
    expect(mocks.getAdviceReportQueue).toHaveBeenLastCalledWith("2");
    expect(html).toContain('href="/admin/advice-reports?page=1"');
    expect(html).toContain('href="/admin/advice-reports?page=3"');
    expect(html).toContain('name="page" value="2"');
  });
});
