import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { configureLogger } from "@/lib/logger";
import { rebuildQuestionBank } from "@/lib/question-bank";
import { questionTextHash } from "@/lib/walkthroughs";
import { WALKTHROUGH_PROMPT_VERSION } from "@/lib/walkthrough-rules";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-51: the step-by-step walkthrough page, end to end, with NO DeepSeek key (option A): nothing here ever calls DeepSeek.
// One course with two published past-paper questions and one on a pending paper, and one student. A walkthrough for the
// first question is stored directly in the database (as if generated earlier); the second has none, so pressing Generate
// gives the "not available" notice and a Try again button. Also: the visitor is sent to log in and back, not-found cases,
// the Upcomer Exam link, and 375 px in light and dark mode. Everything is deleted at the end; the course takes its papers,
// questions and walkthroughs with it.

// Load .env the way the other specs do (it never overrides a variable that is already set, even to ""). If a DeepSeek key
// is set for this run, the server would have it too and Generate would make a real call, so that test is skipped.
try {
  process.loadEnvFile?.(".env");
} catch {
  // No .env file; rely on the environment.
}
const aiKeySet = Boolean(process.env.DEEPSEEK_API_KEY?.trim());

const stamp = String(Date.now()).slice(-8);
const courseId = `qa-walk-${stamp}`;
const password = "password123";
const student = { id: `qa-wk-s-${stamp}`, email: `qa-wk-s-${stamp}@mail.aub.edu`, name: "Walkthrough Student" };
const STORED = `Explain how the TCP three way handshake establishes a connection ${stamp}.`;
const FRESH = `Describe how TCP flow control uses the receive window ${stamp}.`;
const PENDING = `Explain slow start in TCP congestion control ${stamp}.`;
const ids = { stored: `${courseId}-q1`, fresh: `${courseId}-q2`, pending: `${courseId}-q3` };
const walkthroughUrl = (questionId: string, course = courseId) => `/courses/${course}/questions/${questionId}/walkthrough`;
const steps = [
  { title: "Read what is asked", explanation: "The question asks how a TCP connection is opened.", basis: "question", quote: "the TCP three way handshake establishes a connection", verified: true, unverifiedReason: null },
  { title: "Recall the three segments", explanation: "SYN, then SYN-ACK, then ACK. Shown as text: <b>bold</b>", basis: "method", quote: null, verified: false, unverifiedReason: "method" },
  { title: "State what is assumed", explanation: "No segment is lost.", basis: "assumption", quote: null, verified: false, unverifiedReason: "assumption" },
];

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  configureLogger({ persist: false });
  await db.user.create({ data: { ...student, passwordHash: await bcrypt.hash(password, 10) } });
  await db.course.create({ data: { id: courseId, code: `QW${stamp}`, name: `Walkthrough Course ${stamp}`, facultyId: "faculty-eng" } });
  const paper = { year: 2025, topic: "TCP", examType: "FINAL" as const, category: "EXAM" as const, originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf" };
  await db.courseFile.create({ data: { ...paper, id: `${courseId}-paper`, courseId, title: `TCP final ${stamp}`, questions: { create: [{ id: ids.stored, number: 1, text: STORED }, { id: ids.fresh, number: 2, text: FRESH }] } } });
  await db.courseFile.create({ data: { ...paper, id: `${courseId}-pending`, courseId, title: `Pending ${stamp}`, status: "PENDING", questions: { create: [{ id: ids.pending, number: 1, text: PENDING }] } } });
  expect(await rebuildQuestionBank(courseId)).toMatchObject({ ok: true, groupCount: 2 });
  await db.questionWalkthrough.create({ data: { questionId: ids.stored, textHash: questionTextHash(STORED), promptVersion: WALKTHROUGH_PROMPT_VERSION, model: "e2e-stored", steps } });
});
test.afterAll(async () => {
  try {
    await db.$transaction([
      db.course.deleteMany({ where: { id: courseId } }),
      db.session.deleteMany({ where: { userId: student.id } }),
      db.user.deleteMany({ where: { id: student.id } }),
      db.logEntry.deleteMany({ where: { event: { startsWith: "walkthrough_" }, context: { path: ["courseId"], equals: courseId } } }),
    ]);
  } finally {
    await db.$disconnect();
  }
});

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(student.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/my-courses$/);
}
const main = (page: Page) => page.locator("main");

test("a visitor is sent to log in and comes back to the walkthrough", async ({ page }) => {
  await page.goto(walkthroughUrl(ids.stored));
  await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(walkthroughUrl(ids.stored)).replace(/[.?]/g, "\\$&")}$`));
  await page.getByLabel("Email").fill(student.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(new RegExp(`${walkthroughUrl(ids.stored)}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Step-by-step walkthrough" })).toBeVisible();
});

test("a stored walkthrough: the question, the AI-generated label, ordered steps with their status in words", async ({ page }) => {
  await logIn(page);
  await page.goto(walkthroughUrl(ids.stored));
  await expect(main(page).getByText("AI-generated", { exact: true })).toBeVisible();
  await expect(main(page)).toContainText("It may contain mistakes and is not an official answer");
  await expect(main(page)).toContainText(STORED);
  const items = main(page).locator("ol > li");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0).getByRole("heading", { level: 3 })).toHaveText("Step 1: Read what is asked");
  await expect(items.nth(0)).toContainText("Quoted from the question");
  await expect(items.nth(0).locator("blockquote")).toContainText("the TCP three way handshake establishes a connection");
  await expect(items.nth(1)).toContainText("Unverified");
  await expect(items.nth(1)).toContainText("General method, not taken from the question");
  await expect(items.nth(1)).toContainText("Shown as text: <b>bold</b>");
  await expect(items.nth(2)).toContainText("Assumption: the question does not give this");
  await expect(main(page)).toContainText("3 steps. 2 of 3 steps are unverified");
  await expect(main(page)).toContainText("Steps were checked against the question text only, not against an answer key.");
  await expect(main(page).getByRole("button")).toHaveCount(0);
});

test("unknown, unpublished and other-course questions are not found", async ({ page }) => {
  await logIn(page);
  for (const url of [walkthroughUrl(`missing-${stamp}`), walkthroughUrl(ids.pending), walkthroughUrl(ids.stored, "course-eece350")]) {
    const response = await page.goto(url);
    expect(response?.status(), url).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "Not found" })).toBeVisible();
  }
});

test("each Upcomer Exam question links to its walkthrough", async ({ page }) => {
  await logIn(page);
  await page.goto(`/courses/${courseId}/exam`);
  const links = main(page).getByRole("link", { name: /^Step-by-step walkthrough of question \d+$/ });
  await expect(links).toHaveCount(2);
  await links.first().click();
  await expect(page).toHaveURL(/\/questions\/[^/]+\/walkthrough$/);
  await expect(page.getByRole("heading", { level: 1, name: "Step-by-step walkthrough" })).toBeVisible();
});

test("without a DeepSeek key, Generate shows the not-available notice and a Try again button, and stores nothing", async ({ page }) => {
  test.skip(aiKeySet, "A DeepSeek key is set for this run; Generate would make a real call. Run with DEEPSEEK_API_KEY=\"\".");
  await logIn(page);
  await page.goto(walkthroughUrl(ids.fresh));
  await expect(main(page)).toContainText("No walkthrough has been made for this question yet.");
  await expect(main(page)).toContainText("Preparing a walkthrough can take up to a minute.");
  await main(page).getByRole("button", { name: "Generate walkthrough" }).click();
  await expect(page).toHaveURL(new RegExp(`${walkthroughUrl(ids.fresh)}\\?error=not_configured$`));
  await expect(main(page).getByRole("alert")).toHaveText("Walkthroughs are not available right now. Please try again later.");
  const retry = main(page).getByRole("button", { name: "Try again" });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page).toHaveURL(new RegExp(`${walkthroughUrl(ids.fresh)}\\?error=not_configured$`));
  await expect(main(page).getByRole("alert")).toHaveText("Walkthroughs are not available right now. Please try again later.");
  expect(await db.questionWalkthrough.count({ where: { questionId: ids.fresh } })).toBe(0);
  // The refusal is in the events table with IDs and the reason only, never the question text.
  await expect.poll(() => db.logEntry.count({ where: { event: "walkthrough_refused", context: { path: ["questionId"], equals: ids.fresh } } })).toBeGreaterThan(0);
  const logged = await db.logEntry.findMany({ where: { event: { startsWith: "walkthrough_" }, context: { path: ["courseId"], equals: courseId } }, select: { context: true } });
  expect(logged.some(entry => (entry.context as { reason?: string }).reason === "not_configured")).toBe(true);
  expect(JSON.stringify(logged)).not.toContain("flow control");
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the walkthrough page fits a 375 px phone in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 375, height: 800 });
    await logIn(page);
    for (const questionId of [ids.stored, ids.fresh]) {
      await page.goto(walkthroughUrl(questionId));
      await expect(page.getByRole("heading", { level: 1, name: "Step-by-step walkthrough" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
  });
}
