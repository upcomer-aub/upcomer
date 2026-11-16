import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { configureLogger } from "@/lib/logger";
import { rebuildQuestionBank } from "@/lib/question-bank";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-21: mark questions done and resume. The spec makes one course with eight questions on two exam papers, and two
// students. It deletes them at the end; the course takes its papers, questions, groups, and marks with it.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-progress-${stamp}`;
const password = "password123";
const students = {
  a: { id: `qa-prog-a-${stamp}`, email: `qa-prog-a-${stamp}@mail.aub.edu`, name: "Progress Student" },
  b: { id: `qa-prog-b-${stamp}`, email: `qa-prog-b-${stamp}@mail.aub.edu`, name: "Other Student" },
};
const texts = [
  "Explain the TCP three-way handshake.", "Define a socket.", "What does ARP do?", "Describe the layers of the OSI model.",
  "What is a subnet mask used for?", "Explain how DNS resolves a host name.", "What is the purpose of NAT?", "Describe the sliding window protocol.",
];
const paper = (year: number) => ({
  id: `${courseId}-${year}`, courseId, title: `Exam ${year} ${stamp}`, year, examType: "FINAL" as const, category: "EXAM" as const,
  originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf",
});

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  configureLogger({ persist: false });
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: Object.values(students).map(student => ({ ...student, passwordHash })) });
  await db.course.create({ data: { id: courseId, code: `QP${stamp}`, name: `Progress Course ${stamp}`, facultyId: "faculty-eng" } });
  await db.courseFile.createMany({ data: [paper(2024), paper(2025)] });
  await db.question.createMany({ data: texts.map((text, index) => ({ fileId: `${courseId}-${index < 4 ? 2024 : 2025}`, number: (index % 4) + 1, text })) });
  expect(await rebuildQuestionBank(courseId)).toEqual({ ok: true, groupCount: 8, questionCount: 8 });
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
async function logOut(page: Page) {
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("link", { name: "Log in", exact: true }).first()).toBeVisible();
}
const exam = `/courses/${courseId}/exam`;
const question = (page: Page, position: number) => page.locator(`#question-${position}`);
async function markDone(page: Page, position: number) {
  await question(page, position).getByRole("button", { name: `Mark question ${position} done` }).click();
  // Next.js drops the #question-N of a redirect after a server action; "at" brings the student back to the question.
  await expect(page).toHaveURL(new RegExp(`${exam}\\?at=${position}(#question-${position})?$`));
  await expect(question(page, position)).toContainText("✓ Done");
  await expect(question(page, position)).toBeInViewport();
}

test("a question marked done stays marked after logging out and back in (acceptance test 1)", async ({ page }) => {
  await logIn(page, students.a.email);
  await page.goto(exam);
  await expect(page.locator("li[data-tier]")).toHaveCount(8);
  for (const position of [1, 2, 3, 4, 5]) await markDone(page, position);
  // Undo works and can be redone.
  await question(page, 5).getByRole("button", { name: "Undo done on question 5" }).click();
  await expect(question(page, 5)).not.toContainText("✓ Done");
  await expect(question(page, 5)).toBeInViewport();
  await markDone(page, 5);

  await logOut(page);
  await page.goto(exam);
  await expect(page.getByText("✓ Done")).toHaveCount(0);
  await logIn(page, students.a.email);
  await page.goto(exam);
  for (const position of [1, 2, 3, 4, 5]) await expect(question(page, position)).toContainText("✓ Done");
  for (const position of [6, 7, 8]) await expect(question(page, position).getByRole("button", { name: `Mark question ${position} done` })).toBeVisible();
});

test("returning to the course, the exam opens at the first question not yet done (acceptance test 2)", async ({ page }) => {
  await logIn(page, students.a.email);
  await page.goto(`/courses/${courseId}`);
  await page.getByRole("link", { name: /Upcomer Exam/ }).click();
  await expect(page).toHaveURL(new RegExp(`${exam}$`));
  await expect(page.getByText("5 of 8 questions done.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue at question 6" })).toHaveAttribute("href", "#question-6");
  await expect(question(page, 6)).toBeInViewport();
  await expect(question(page, 1)).not.toBeInViewport();

  // Coming back from marking a question stays on that question instead, even one far above the place to continue.
  await markDone(page, 6);
  await question(page, 1).getByRole("button", { name: "Undo done on question 1" }).click();
  // Wait for the undo to land: the click itself scrolls question 1 into view, so being in view alone proves nothing.
  await expect(page).toHaveURL(new RegExp(`${exam}\\?at=1(#question-1)?$`));
  await expect(question(page, 1).getByRole("button", { name: "Mark question 1 done" })).toBeVisible();
  await expect(question(page, 1)).toBeInViewport();
  await page.goto(exam);
  await expect(page.getByRole("link", { name: "Continue at question 1" })).toBeVisible();
  await markDone(page, 1);
  await page.goto(exam);
  await expect(page.getByRole("link", { name: "Continue at question 7" })).toBeVisible();
  await expect(question(page, 7)).toBeInViewport();
});

test("one student's progress is never shown to another student (acceptance test 3)", async ({ page }) => {
  await logIn(page, students.b.email);
  await page.goto(exam);
  await expect(page.locator("li[data-tier]")).toHaveCount(8);
  await expect(page.getByText("✓ Done")).toHaveCount(0);
  await expect(page.getByText(/questions done\./)).toHaveCount(0);
  for (const position of [1, 2, 3, 4, 5, 6, 7, 8]) await expect(question(page, position).getByRole("button", { name: `Mark question ${position} done` })).toBeVisible();
  await expect(question(page, 1)).toBeInViewport();

  // B's own mark does not change A's progress.
  await markDone(page, 8);
  expect(await db.questionProgress.count({ where: { userId: students.a.id, courseId } })).toBe(6);
  expect(await db.questionProgress.count({ where: { userId: students.b.id, courseId } })).toBe(1);
});
