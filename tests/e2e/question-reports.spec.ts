import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { configureLogger } from "@/lib/logger";
import { rebuildQuestionBank } from "@/lib/question-bank";
import { logInAsAdmin } from "./fixtures";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-15b and US-23. The spec makes one course with three exam papers whose questions are worded differently, and two
// students. It deletes them at the end; the course takes its papers, questions, groups, and reports with it.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-reports-${stamp}`;
const code = `QR${stamp}`;
const password = "password123";
const students = {
  a: { id: `qa-rep-a-${stamp}`, email: `qa-rep-a-${stamp}@mail.aub.edu`, name: "Reporting Student" },
  b: { id: `qa-rep-b-${stamp}`, email: `qa-rep-b-${stamp}@mail.aub.edu`, name: "Second Reporter" },
};
const note = `These ask about different protocols ${stamp}`;
const paper = (year: number) => ({
  id: `${courseId}-${year}`, courseId, title: `Exam ${year} ${stamp}`, year, examType: "FINAL" as const, category: "EXAM" as const,
  originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf",
});
const questions: Array<[number, string[]]> = [
  [2023, ["What is the difference between TCP and UDP?", "Explain the TCP three-way handshake."]],
  [2024, ["Compare TCP and UDP.", "Describe how TCP establishes a connection using the three-way handshake."]],
  [2025, ["Distinguish between TCP and UDP.", "What is the difference between TCP and IP?"]],
];

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  configureLogger({ persist: false });
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: Object.values(students).map(student => ({ ...student, passwordHash })) });
  await db.course.create({ data: { id: courseId, code, name: `Report Course ${stamp}`, facultyId: "faculty-eng" } });
  await db.courseFile.createMany({ data: questions.map(([year]) => paper(year)) });
  for (const [year, texts] of questions) {
    await db.question.createMany({ data: texts.map((text, index) => ({ fileId: `${courseId}-${year}`, number: index + 1, text })) });
  }
  expect(await rebuildQuestionBank(courseId)).toEqual({ ok: true, groupCount: 3, questionCount: 6 });
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

const exam = `/courses/${courseId}/exam`;
const examQuestions = (page: Page) => page.locator("li[data-tier]");

async function report(page: Page, position: number, reason: RegExp, details = "") {
  const question = page.locator(`#question-${position}`);
  await question.getByText(`Report a problem with question ${position}`).click();
  await question.getByRole("radio", { name: reason }).check();
  if (details) await question.getByLabel("Details (optional)").fill(details);
  await question.getByRole("button", { name: `Send report on question ${position}` }).click();
}

test("reworded questions appear once on the Upcomer Exam, with every paper counted (US-15b)", async ({ page }) => {
  await page.goto(exam);
  await expect(page.getByText("3 distinct questions from 3 previous exams")).toBeVisible();
  await expect(examQuestions(page).locator("p").first()).toHaveText("What is the difference between TCP and UDP?");
  await expect(examQuestions(page).first()).toContainText("Appeared in 3 of 3 papers");
  await expect(examQuestions(page).nth(1)).toContainText("Explain the TCP three-way handshake.");
  await expect(examQuestions(page).nth(1)).toContainText("Appeared in 2 of 3 papers");
  // Same topic, different question: TCP and IP stays apart from TCP and UDP.
  await expect(examQuestions(page).nth(2)).toContainText("What is the difference between TCP and IP?");
  // A visitor is asked to log in before reporting.
  await expect(page.getByText("Report a problem")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Log in", exact: true }).last()).toHaveAttribute("href", `/login?next=${encodeURIComponent(exam)}`);
});

test("a student reports a wrong grouping, and a second report of the same question is refused (US-23)", async ({ page }) => {
  await logIn(page, students.a.email);
  await page.goto(exam);
  await report(page, 1, /Different questions are shown as one/, note);
  // The action returns to #question-1; Next.js drops the fragment on a client-side redirect, and the notice is at the top.
  await expect(page).toHaveURL(new RegExp(`${exam}\\?reported=1(#question-1)?$`));
  await expect(page.getByRole("status")).toContainText("Thanks, your report was sent.");
  await report(page, 1, /The text is wrong/);
  await expect(page.locator("p.notice.error")).toHaveText("You already reported this question. An admin will check it.");
  const stored = await db.questionReport.findMany({ where: { courseId } });
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ reporterId: students.a.id, reason: "WRONG_GROUPING", note, status: "OPEN", questionText: "What is the difference between TCP and UDP?" });
});

test("the report reaches the admin queue with its question and course, joined by another student's report", async ({ page, browser }) => {
  const other = await browser.newPage();
  await logIn(other, students.b.email);
  await other.goto(exam);
  await report(other, 1, /Something else/);
  await expect(other.getByRole("status")).toContainText("Thanks, your report was sent.");
  await other.close();

  await logInAsAdmin(page);
  await page.goto("/admin/catalog");
  await page.getByRole("link", { name: "Open question reports" }).click();
  await expect(page).toHaveURL(/\/admin\/reports$/);
  const item = page.locator("ol[aria-label='Reported questions'] > li").filter({ hasText: code });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(`${code} · Rank 1 · 3 papers`);
  await expect(item.locator("h3")).toHaveText("What is the difference between TCP and UDP?");
  await expect(item).toContainText("Reported by 2 students");
  await expect(item).toContainText("Wrong grouping · Other");
  await expect(item).toContainText(note);
  await expect(item.getByRole("link", { name: `Open the ${code} Upcomer Exam` })).toHaveAttribute("href", exam);
});
