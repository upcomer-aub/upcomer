import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { setTopicWeakness } from "@/lib/learning-profile";
import { configureLogger } from "@/lib/logger";
import { rebuildQuestionBank } from "@/lib/question-bank";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-31: practice that emphasizes weak topics, at /courses/:courseId/practice/weak-topics. The spec makes one course with two TCP papers (sharing six questions, so
// TCP fills the top of the frequency order) and one DNS paper with six other questions, and two students: one weak in
// DNS and one without a profile. Everything is deleted at the end; the course takes its papers, questions, groups, and
// profile rows with it.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-practice-${stamp}`;
const password = "password123";
const students = {
  weak: { id: `qa-prc-w-${stamp}`, email: `qa-prc-w-${stamp}@mail.aub.edu`, name: "Weak In DNS" },
  none: { id: `qa-prc-n-${stamp}`, email: `qa-prc-n-${stamp}@mail.aub.edu`, name: "No Profile" },
};
const tcp = [
  "Explain the TCP three-way handshake.", "Describe TCP slow start and congestion avoidance.", "Why does TCP use a sliding window for flow control?",
  "Compare Go-Back-N with Selective Repeat retransmission.", "How does TCP estimate the retransmission timeout?", "What happens during a TCP connection teardown?",
];
const dns = [
  "Explain how DNS resolves a host name iteratively.", "What is the purpose of a DNS MX record?", "Why are DNS responses cached, and for how long?",
  "Describe the role of root and top-level domain servers.", "How does DNS use UDP, and when does it switch to TCP?", "What is a CNAME record used for?",
];
const papers: Array<[number, string, string[]]> = [[2023, "TCP", tcp], [2024, "TCP", tcp], [2025, "DNS", dns]];

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  configureLogger({ persist: false });
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: Object.values(students).map(student => ({ ...student, passwordHash })) });
  await db.course.create({ data: { id: courseId, code: `QP${stamp}`, name: `Practice Course ${stamp}`, facultyId: "faculty-eng" } });
  for (const [year, topic, texts] of papers) {
    await db.courseFile.create({ data: {
      id: `${courseId}-${year}`, courseId, title: `Exam ${year} ${stamp}`, year, topic, examType: "FINAL", category: "EXAM",
      originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf",
      questions: { create: texts.map((text, index) => ({ number: index + 1, text })) },
    } });
  }
  expect(await rebuildQuestionBank(courseId)).toMatchObject({ ok: true, groupCount: 12 });
  for (const [topic, weakness] of [["TCP", 0], ["DNS", 1]] as const) expect(await setTopicWeakness(students.weak.id, courseId, topic, weakness)).toEqual({ ok: true });
});
test.afterAll(async () => {
  try {
    const userIds = Object.values(students).map(student => student.id);
    await db.$transaction([
      db.course.deleteMany({ where: { id: courseId } }),
      db.session.deleteMany({ where: { userId: { in: userIds } } }),
      db.user.deleteMany({ where: { id: { in: userIds } } }),
    ]);
  } finally {
    await db.$disconnect();
  }
});

async function logIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/my-courses$/);
}
const practice = `/courses/${courseId}/practice/weak-topics`;
const items = (page: Page) => page.getByRole("region", { name: /Your practice set/ }).locator("li[data-topic]");

test("a visitor is sent to log in and comes back to the practice page", async ({ page }) => {
  await page.goto(practice);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel("Email").fill(students.none.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(new RegExp(`${practice}$`));
  await expect(page.getByRole("heading", { name: "Practice your weak topics" })).toBeVisible();
});

test("a student weak in DNS gets more DNS questions, though TCP is more frequent (acceptance test 1)", async ({ page }) => {
  await logIn(page, students.weak.email);
  await page.goto(`/courses/${courseId}`);
  await page.getByRole("link", { name: "Practice your weak topics" }).click();
  await expect(page).toHaveURL(new RegExp(`${practice}$`));
  await page.getByLabel("Number of questions").selectOption("5");
  await page.getByRole("button", { name: "Get practice set" }).click();
  await expect(page).toHaveURL(new RegExp(`${practice}\\?size=5$`));
  await expect(items(page)).toHaveCount(5);
  const dnsCount = await page.locator('li[data-topic="DNS"]').count();
  const tcpCount = await page.locator('li[data-topic="TCP"]').count();
  expect(dnsCount).toBeGreaterThan(tcpCount);
  expect(tcpCount).toBeGreaterThan(0);
  await expect(items(page).first()).toHaveAttribute("data-topic", "DNS");
  await expect(page.getByRole("list", { name: "Questions per topic" })).toContainText("weaker topic");
  await expect(page.getByText("Historical exam data", { exact: true })).toBeVisible();
});

test("a student without a profile gets the frequency order and a link to rate topics (acceptance test 2)", async ({ page }) => {
  await logIn(page, students.none.email);
  await page.goto(`${practice}?size=5`);
  await expect(page.getByRole("note").filter({ hasText: "no weak topics" })).toBeVisible();
  await expect(items(page)).toHaveCount(5);
  await expect(page.locator('li[data-topic="DNS"]')).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Rate your topics" })).toHaveAttribute("href", `/courses/${courseId}/confidence`);
});

test("a set larger than the course has every question once (acceptance test 3)", async ({ page }) => {
  await logIn(page, students.weak.email);
  await page.goto(`${practice}?size=20`);
  await expect(page.getByText("This course has only 12 questions, so the set has all of them.")).toBeVisible();
  await expect(items(page)).toHaveCount(12);
  const texts = await items(page).locator("p:first-of-type").allTextContents();
  expect(new Set(texts).size).toBe(12);
});

test("each question links to the Upcomer Exam to attempt it, and the exam links back", async ({ page }) => {
  await logIn(page, students.weak.email);
  await page.goto(`/courses/${courseId}/exam`);
  await page.getByRole("link", { name: "Practice your weak topics" }).click();
  await expect(page).toHaveURL(new RegExp(`${practice}$`));
  const first = items(page).first();
  const position = (await first.locator(".eyebrow").textContent())?.match(/Question (\d+)/)?.[1];
  await first.getByRole("link", { name: "Attempt it in the Upcomer Exam" }).click();
  await expect(page).toHaveURL(new RegExp(`/courses/${courseId}/exam#question-${position}$`));
});

test("the practice set fits a 375 px phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await logIn(page, students.weak.email);
  await page.goto(`${practice}?size=20`);
  await expect(items(page)).toHaveCount(12);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
