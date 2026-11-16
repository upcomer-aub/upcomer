import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// US-51: the walkthrough page, with the service mocked (no database, no AI). A stored walkthrough, one not made yet, every
// error notice, the unverified badges and count, the AI-generated label, not found, and a visitor sent to log in.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), getCourseById: vi.fn(), getWalkthroughPage: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser, getCurrentUser: vi.fn() }));
vi.mock("@/lib/courses", () => ({ getCourseById: mocks.getCourseById }));
vi.mock("@/lib/walkthroughs", () => ({ getWalkthroughPage: mocks.getWalkthroughPage }));
vi.mock("@/lib/walkthrough-actions", () => ({ generateWalkthroughAction: vi.fn() }));
import WalkthroughPage from "@/app/courses/[courseId]/questions/[questionId]/walkthrough/page";
import { SOURCE_LABELS } from "@/components/source-label";
import { walkthroughMessage, type WalkthroughStep } from "@/lib/walkthrough-rules";

const course = { id: "course-a", code: "EECE350", name: "Computer Networks", faculty: { name: "Engineering" }, professors: [] };
const question = {
  id: "q-1", courseId: "course-a", text: "Explain the TCP three way handshake.\n(a) Name the segments.", textHash: "h", topic: "TCP",
  paperTitle: "Final", year: 2024, courseLabel: "EECE350 Computer Networks",
};
const steps: WalkthroughStep[] = [
  { title: "Read what is asked", explanation: "The question asks how a connection opens.", basis: "question", quote: "the TCP three way handshake", verified: true, unverifiedReason: null },
  { title: "Recall <b>SYN</b>", explanation: "Use <script>alert(1)</script> & the three segments.", basis: "method", quote: null, verified: false, unverifiedReason: "method" },
  { title: "Assume no loss", explanation: "Nothing is lost on the way.", basis: "assumption", quote: null, verified: false, unverifiedReason: "assumption" },
];
const stored = (over: Partial<{ steps: WalkthroughStep[] }> = {}) => ({ question, walkthrough: { id: "w-1", steps, createdAt: new Date("2026-11-16T08:30:00Z"), ...over } });
const page = (query: Record<string, string> = {}) =>
  WalkthroughPage({ params: Promise.resolve({ courseId: course.id, questionId: "q-1" }), searchParams: Promise.resolve(query) }).then(renderToStaticMarkup);
const notices = (html: string) => [...html.matchAll(/<p class="notice[^"]*" role="(status|alert)">(.*?)<\/p>/g)].map(match => [match[1], match[2]]);
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
  mocks.requireUser.mockReset().mockResolvedValue({ id: "student-1", role: "STUDENT" });
  mocks.getCourseById.mockReset().mockResolvedValue(course);
  mocks.getWalkthroughPage.mockReset().mockResolvedValue(stored());
});

describe("walkthrough page: access (US-51)", () => {
  it("sends a visitor to log in and back, without reading anything", async () => {
    mocks.requireUser.mockImplementation(async (route: string) => mocks.redirect(`/login?next=${encodeURIComponent(route)}`));
    await expect(page()).rejects.toThrow("NEXT_REDIRECT /login?next=%2Fcourses%2Fcourse-a%2Fquestions%2Fq-1%2Fwalkthrough");
    expect(mocks.getWalkthroughPage).not.toHaveBeenCalled();
  });

  it("reads the question for the session student, in this course", async () => {
    await page();
    expect(mocks.getWalkthroughPage).toHaveBeenCalledWith("student-1", "course-a", "q-1");
  });

  it("is not found for a question the service does not accept, or an unknown course", async () => {
    mocks.getWalkthroughPage.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    mocks.getWalkthroughPage.mockResolvedValue(stored());
    mocks.getCourseById.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("walkthrough page: a stored walkthrough (US-51)", () => {
  it("shows the question, the AI-generated label, and the steps in an ordered list", async () => {
    const html = await page();
    expect(html).toContain("<h1>Step-by-step walkthrough</h1>");
    expect(html).toContain('data-source="ai">AI-generated</span>');
    expect(html).toContain(escape(SOURCE_LABELS.ai.note));
    expect(SOURCE_LABELS.ai.note).toMatch(/may contain mistakes/);
    expect(SOURCE_LABELS.ai.note).toMatch(/not an official answer/);
    expect(html).toContain("The question · Final (2024) · TCP");
    expect(html).toContain("Explain the TCP three way handshake.\n(a) Name the segments.");
    expect(html).toMatch(/<ol[^>]*>(<li[^>]*>[\s\S]*?<\/li>){3}<\/ol>/);
    expect(html.indexOf("Step 1:")).toBeLessThan(html.indexOf("Step 2:"));
    expect(html).toContain('<time dateTime="2026-11-16T08:30:00.000Z">2026-11-16 08:30 UTC</time>');
    // Nothing to generate.
    expect(html).not.toContain("Generate walkthrough");
    expect(html).not.toContain("Try again");
  });

  it("marks each step in words: quoted from the question, or unverified with its reason", async () => {
    const html = await page();
    expect(html.match(/>Quoted from the question</g)).toHaveLength(1);
    expect(html.match(/>Unverified</g)).toHaveLength(2);
    expect(html).toContain("General method, not taken from the question");
    expect(html).toContain("Assumption: the question does not give this");
    expect(html).toContain("From the question: </span>the TCP three way handshake</blockquote>");
    expect(html.match(/<blockquote/g)).toHaveLength(1);
  });

  it("states how many steps are unverified and that there is no answer key", async () => {
    const html = await page();
    expect(html).toContain("3 steps. 2 of 3 steps are unverified: they do not come from the question&#x27;s own words.");
    expect(html).toContain("There is no official answer key for this question, so no step has been checked against a correct answer.");
    mocks.getWalkthroughPage.mockResolvedValue(stored({ steps: [steps[0], steps[1]] }));
    expect(await page()).toContain("2 steps. 1 of 2 steps is unverified: it does not come from");
    mocks.getWalkthroughPage.mockResolvedValue(stored({ steps: [steps[0], steps[0]] }));
    const allQuoted = await page();
    expect(allQuoted).toContain("2 steps. Every step quotes the question.");
    expect(allQuoted).toContain("There is no official answer key");
  });

  it("shows anything the model wrote as plain text, never as HTML", async () => {
    const html = await page();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>SYN</b>");
    expect(html).toContain("Recall &lt;b&gt;SYN&lt;/b&gt;");
    expect(html).toContain("Use &lt;script&gt;alert(1)&lt;/script&gt; &amp; the three segments.");
  });

  it("ignores an error in the address once a walkthrough is stored", async () => {
    const html = await page({ error: "timeout" });
    expect(notices(html)).toEqual([]);
  });
});

describe("walkthrough page: not made yet (US-51)", () => {
  beforeEach(() => mocks.getWalkthroughPage.mockResolvedValue({ question, walkthrough: null }));

  it("offers a plain form to generate it, with the question's IDs only and a note that it takes a moment", async () => {
    const html = await page();
    expect(html).toContain("No walkthrough has been made for this question yet.");
    expect(html).toContain('<button class="button" type="submit" aria-describedby="generate-note">Generate walkthrough</button>');
    expect(html).toContain('<input type="hidden" name="courseId" value="course-a"/>');
    expect(html).toContain('<input type="hidden" name="questionId" value="q-1"/>');
    expect(html).toContain('id="generate-note">Preparing a walkthrough can take up to a minute.');
    expect(html).not.toContain("student-1");
    expect(html).not.toContain("<ol");
    expect(notices(html)).toEqual([]);
    // The label is shown before anything is generated, too.
    expect(html).toContain('data-source="ai">AI-generated</span>');
  });

  it.each(["not_configured", "rate_limited", "timeout", "unavailable", "invalid_output", "unexpected"])(
    "shows the friendly notice for %s with a Try again button", async error => {
      const html = await page({ error });
      expect(notices(html)).toEqual([["alert", escape(walkthroughMessage(error))]]);
      expect(html).toContain(">Try again</button>");
      expect(html).not.toContain("Generate walkthrough");
    },
  );

  it("names each reason in plain words", () => {
    expect(walkthroughMessage("not_configured")).toBe("Walkthroughs are not available right now. Please try again later.");
    expect(walkthroughMessage("rate_limited")).toBe("You have asked for many walkthroughs in the last hour. Please wait a while and try again.");
  });

  it.each(["question_too_long", "not_found"])("shows the notice for %s without a button", async error => {
    const html = await page({ error });
    expect(notices(html)).toEqual([["alert", escape(walkthroughMessage(error))]]);
    expect(html).not.toContain("<button");
  });

  it("shows a generic notice for an unknown reason, never the value itself", async () => {
    const html = await page({ error: "<img src=x onerror=alert(1)>" });
    expect(notices(html)).toEqual([["alert", escape(walkthroughMessage("unexpected"))]]);
    expect(html).not.toContain("onerror");
    expect(html).toContain(">Try again</button>");
  });
});
