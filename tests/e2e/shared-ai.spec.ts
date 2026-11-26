import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { rebuildQuestionBank } from "@/lib/question-bank";
import { configureLogger } from "@/lib/logger";
import { draftRubric, envelope, fakeKey, fakePort, feedbackOutput, practiceOutput, practiceQuestion, requestData } from "../fixtures/shared-ai-provider";
import { logInAsAdmin } from "./fixtures";

const run = randomUUID().slice(0, 8);
const courseId = `shared-ai-${run}`;
const code = `AI${run}`;
const question = practiceQuestion(code, 0);
const password = "ai-browser-test";
const student = { id: `ai-student-${run}`, email: `ai-student-${run}@mail.aub.edu`, name: "AI Test Student" };
const other = { id: `ai-other-${run}`, email: `ai-other-${run}@mail.aub.edu`, name: "Other AI Test Student" };
const course = `/courses/${courseId}`;
const reviewList = `/admin/answer-keys/${courseId}/generated`;
const db = new PrismaClient();
const calls = { practice: 0, feedback: 0 };
const provider = createServer(async (req, res) => {
  try {
    if (req.method !== "POST" || req.url !== "/chat/completions" || req.headers.authorization !== `Bearer ${fakeKey}`) {
      res.writeHead(403).end();
      return;
    }
    const chunks = [];
    for await (const data of req) chunks.push(data);
    const input = requestData(Buffer.concat(chunks).toString("utf8"));
    const feature = "sources" in input ? "practice" : "feedback";
    calls[feature]++;
    if (calls[feature] === 1) {
      res.writeHead(503).end();
      return;
    }
    const output = feature === "practice" ? practiceOutput(input) : feedbackOutput(input);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(envelope(output)));
  } catch {
    res.writeHead(400).end();
  }
});

test.skip(process.env.UPCOMER_E2E_FAKE_AI !== "true", "Run this spec with the dedicated fake-provider server.");
test.setTimeout(90_000);
test.beforeAll(async () => {
  configureLogger({ persist: false });
  await new Promise<void>((resolve, reject) => provider.once("error", reject).listen(fakePort, "127.0.0.1", resolve));
  await db.course.create({ data: { id: courseId, code, name: "Shared AI test course", facultyId: "faculty-eng" } });
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: [student, other].map(user => ({ ...user, passwordHash })) });
  await db.courseFile.create({ data: {
    id: `${courseId}-paper`, courseId, title: "Published TCP final", category: "EXAM", status: "PUBLISHED", year: 2025, topic: "TCP",
    originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf",
    questions: { create: [
      { number: 1, text: "Explain how the TCP three way handshake establishes a connection." },
      { number: 2, text: "Compare slow start and congestion avoidance in TCP." },
    ] },
  } });
  expect((await rebuildQuestionBank(courseId)).ok).toBe(true);
});
test.afterAll(async () => {
  try {
    await db.course.deleteMany({ where: { id: courseId } });
    await db.user.deleteMany({ where: { id: { in: [student.id, other.id] } } });
  } finally {
    await db.$disconnect();
    await new Promise(resolve => provider.close(resolve));
  }
});

async function logIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/my-courses$/);
}

test("practice, admin review, deterministic grading and opt-in AI feedback", async ({ page, browser }) => {
  const otherContext = await browser.newContext();
  const adminContext = await browser.newContext();
  try {
    await logIn(page, student.email);
    await page.goto(`${course}/practice/generated`);
    expect(calls.practice).toBe(0);
    await page.getByLabel("Number of questions").fill("1");
    await page.getByLabel("Topic").selectOption("tcp");
    const generate = page.getByRole("button", { name: "Generate AI questions" });
    await generate.click();
    await expect(page.locator("main").getByRole("alert")).toContainText("Try again or use Template practice");
    await expect(page.getByRole("button", { name: "Template practice", exact: true })).toBeVisible();
    await expect(page.getByLabel("Topic")).toHaveValue("tcp");
    await expect(page.getByLabel("Number of questions")).toHaveValue("1");
    await generate.click();
    await expect(page.getByText(question, { exact: true })).toBeVisible();
    await expect(page.getByText(/No verified rubric available/)).toBeVisible();
    expect(calls.practice).toBe(2);

    const anon = await otherContext.newPage();
    await logIn(anon, other.email);
    await anon.goto(`${course}/practice/generated`);
    await expect(anon.getByText("No generated questions yet.", { exact: false })).toBeVisible();
    await expect(anon.getByText(question, { exact: true })).toHaveCount(0);
    expect((await anon.goto(reviewList))?.status()).toBe(404);

    const admin = await adminContext.newPage();
    await logInAsAdmin(admin);
    await admin.goto(`/admin/answer-keys/${courseId}`);
    await admin.getByRole("link", { name: "Review generated rubrics" }).click();
    await expect(admin.getByText(question, { exact: true })).toBeVisible();
    await admin.getByText("Source · Published TCP final").click();
    await expect(admin.getByRole("link", { name: "Open published paper" })).toBeVisible();
    const revisedRubric = "Check sequence numbers and discard a retransmitted duplicate.";
    await admin.getByLabel("Worked explanation").fill(revisedRubric);
    await admin.getByRole("button", { name: "Approve rubric" }).click();
    await expect(admin.locator("main").getByRole("status")).toHaveText("Rubric review saved.");
    await expect(admin.getByText(/^Approved · Reviewed/)).toBeVisible();

    await page.goto(`${course}/mock-exams`);
    await page.getByLabel("Number of questions").fill("3");
    await page.getByLabel(/Include my generated practice questions/).check();
    await page.getByRole("button", { name: "Generate mock exam" }).click();
    await expect(page.getByRole("heading", { name: "Mock Exam", exact: true })).toBeVisible();
    await admin.getByRole("button", { name: "Reject rubric" }).click();
    await expect(admin.getByText(/^Rejected · Reviewed/)).toBeVisible();
    const generatedCard = page.locator("ol.question-list > li").filter({ hasText: question });
    await generatedCard.getByRole("textbox").fill("The receiver reads the sequence numbers.");
    await page.getByRole("button", { name: "Submit exam" }).click();
    await page.getByRole("link", { name: "See your results" }).click();
    const feedbackCard = page.locator("li[data-missed]").filter({ hasText: question });
    const score = page.locator("[data-score]");
    await expect(score).toContainText("50% of the key points covered");
    await expect(feedbackCard).toContainText(revisedRubric);
    await expect(feedbackCard).toContainText("sends your answer, the question, and the marking rubric and key points to DeepSeek");
    expect(calls.feedback).toBe(0);
    const savedScore = await score.textContent();
    expect((await anon.goto(page.url()))?.status()).toBe(404);
    expect(calls.feedback).toBe(0);

    const feedback = feedbackCard.getByRole("button", { name: "Generate AI explanation" });
    await feedback.click();
    await expect(feedbackCard.getByRole("alert")).toContainText("Try again");
    await expect(score).toHaveText(savedScore!);
    await expect(feedbackCard).toContainText(revisedRubric);
    await feedback.click();
    await expect(feedbackCard.getByRole("heading", { name: "AI feedback" })).toBeVisible();
    await expect(feedbackCard).toContainText(draftRubric.keyPoints[1]);
    await expect(score).toHaveText(savedScore!);
    expect(calls.feedback).toBe(2);
    await page.reload();
    await expect(feedbackCard.getByRole("heading", { name: "AI feedback" })).toBeVisible();
    expect(calls.feedback).toBe(2);
  } finally {
    await adminContext.close();
    await otherContext.close();
  }
});
