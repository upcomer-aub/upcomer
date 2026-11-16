import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { configureLogger } from "@/lib/logger";
import { rebuildQuestionBank } from "@/lib/question-bank";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-42: advice is labelled "Student opinion", exam statistics "Historical exam data", in separate sections, and advice
// a student publishes never shows up in the Upcomer Exam or its counts. One course with two papers and one student;
// everything is deleted at the end (the course takes its papers, questions, groups and advice with it).
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-separate-${stamp}`;
const password = "password123";
const student = { id: `qa-sep-${stamp}`, email: `qa-sep-${stamp}@mail.aub.edu`, name: "Separation Student" };
const repeated = "Explain the TCP three-way handshake.";
const marker = `Only advice ${stamp}`;

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  configureLogger({ persist: false });
  await db.user.create({ data: { ...student, passwordHash: await bcrypt.hash(password, 10) } });
  await db.course.create({ data: { id: courseId, code: `QS${stamp}`, name: `Separation Course ${stamp}`, facultyId: "faculty-eng" } });
  for (const year of [2024, 2025]) {
    await db.courseFile.create({ data: {
      id: `${courseId}-${year}`, courseId, title: `Exam ${year} ${stamp}`, year, topic: "TCP", examType: "FINAL", category: "EXAM",
      originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf",
      questions: { create: [{ number: 1, text: repeated }, { number: 2, text: `Describe slow start ${year}.` }] },
    } });
  }
  expect(await rebuildQuestionBank(courseId)).toMatchObject({ ok: true, groupCount: 3 });
});
test.afterAll(async () => {
  try {
    await db.$transaction([
      db.course.deleteMany({ where: { id: courseId } }),
      db.session.deleteMany({ where: { userId: student.id } }),
      db.user.deleteMany({ where: { id: student.id } }),
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
const examQuestions = (page: Page) => page.locator("li[data-tier]");

test("the course page shows exam statistics and advice in separate, labelled sections (acceptance test 1)", async ({ page }) => {
  await page.goto(`/courses/${courseId}`);
  const statistics = page.getByRole("region", { name: "Exam statistics" });
  const advice = page.getByRole("region", { name: "Advice from previous students" });
  await expect(statistics).toContainText("Historical exam data");
  await expect(statistics.getByRole("link", { name: "Open Upcomer Exam" })).toBeVisible();
  await expect(statistics.getByRole("link", { name: "Browse Question Bank" })).toBeVisible();
  await expect(statistics).not.toContainText("Student opinion");
  await expect(advice).toContainText("Student opinion");
  await expect(advice.getByRole("link", { name: "Read Student Advice" })).toBeVisible();
  await expect(advice).not.toContainText("Historical exam data");
});

test("published advice is labelled as opinion and never enters the Upcomer Exam or its counts (acceptance test 2)", async ({ page }) => {
  await logIn(page);
  await page.goto(`/courses/${courseId}/exam`);
  await expect(page.getByText("Historical exam data", { exact: true })).toBeVisible();
  await expect(examQuestions(page)).toHaveCount(3);
  const before = await examQuestions(page).allTextContents();
  await expect(examQuestions(page).first()).toContainText("Appeared in 2 of 2 papers");

  await page.getByRole("link", { name: "Advice", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/courses/${courseId}/advice$`));
  await expect(page.getByText("Student opinion", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Title").fill(marker);
  // The advice repeats a past-paper question word for word: it still must not count as an appearance.
  await page.getByLabel("Your advice").fill(`${repeated} ${marker}`);
  await page.getByRole("button", { name: "Publish advice" }).click();
  const post = page.locator("article").filter({ hasText: marker });
  await expect(post).toBeVisible();
  await expect(post).toContainText("Student opinion");

  await page.getByRole("link", { name: "Upcomer Exam", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/courses/${courseId}/exam$`));
  await expect(examQuestions(page)).toHaveCount(3);
  expect(await examQuestions(page).allTextContents()).toEqual(before);
  await expect(page.locator("main, body").first()).not.toContainText(marker);
  await expect(examQuestions(page).first()).toContainText("Appeared in 2 of 2 papers");
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the labels fit a 375 px phone in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 375, height: 800 });
    for (const path of [`/courses/${courseId}`, `/courses/${courseId}/advice`, `/courses/${courseId}/exam`, `/courses/${courseId}/questions`]) {
      await page.goto(path);
      await expect(page.locator("[data-source]").first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
  });
}

test("the Question Bank labels its frequencies as historical exam data and never shows advice", async ({ page }) => {
  await page.goto(`/courses/${courseId}/questions`);
  await expect(page.getByText("Historical exam data", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Advice", exact: true })).toHaveAttribute("href", `/courses/${courseId}/advice`);
  await expect(page.getByText("Student opinion", { exact: true })).toHaveCount(0);
  // The advice published in the test above (it repeats a past-paper question) is not in the bank.
  await expect(page.locator("body")).not.toContainText(marker);
});
