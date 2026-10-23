import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { logInAsAdmin } from "./fixtures";

const expect = baseExpect.configure({ timeout: 15_000 });

// Question corrections in the browser: an admin regroups a throwaway course, moves a wrongly grouped question, splits one
// out, and fixes a wrongly extracted text; a visitor then sees the corrected ordered exam, and the corrections survive
// another "Regroup and rank". The papers are records pointing at a committed fixture; the course is deleted afterwards.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-corr-course-${stamp}`;
const courseCode = `QC${stamp}`;
const papers = [
  { id: `qa-corr-a-${stamp}`, title: `Paper A ${stamp}`, year: 2024, questions: ["1. Explain TCP congestion control.", "2. Define the OSI model.", "3. Explian TCP slow strat."] },
  { id: `qa-corr-b-${stamp}`, title: `Paper B ${stamp}`, year: 2023, questions: ["1. Explain TCP congestion control.", "2. Describe the seven OSI layers."] },
  { id: `qa-corr-c-${stamp}`, title: `Paper C ${stamp}`, year: 2022, questions: ["1. Explain TCP congestion control.", "2. Define the OSI model."] },
];

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  await db.course.create({ data: { id: courseId, code: courseCode, name: `Corrections Course ${stamp}`, facultyId: "faculty-eng" } });
  for (const paper of papers) {
    await db.courseFile.create({
      data: {
        id: paper.id, courseId, title: paper.title, year: paper.year, category: "EXAM",
        originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf",
        questions: { create: paper.questions.map((text, index) => ({ number: index + 1, text })) },
      },
    });
  }
});
test.afterAll(async () => {
  try {
    // Deleting the course deletes its files, questions, groups, and correction log.
    await db.course.deleteMany({ where: { id: courseId } });
  } finally {
    await db.$disconnect();
  }
});

const groupCard = (page: Page, rank: number) => page.getByRole("list", { name: "Question groups" }).getByRole("listitem").filter({ hasText: `#${rank} · in` }).first();
const correct = (page: Page, paper: number, number: number) => page.getByRole("link", { name: `Correct ${papers[paper].title} question ${number}`, exact: true }).click();

async function regroup(page: Page) {
  await page.goto("/admin/questions");
  await page.getByRole("button", { name: `Regroup and rank ${courseCode}` }).click();
  await expect(page.getByRole("status")).toContainText(`Regrouped ${courseCode}`);
}

test("a visitor or student cannot open the correction pages", async ({ page }) => {
  await page.goto(`/admin/questions/${courseId}`);
  await expect(page).toHaveURL(/\/login\?next=/);
});

test("an admin moves, splits, and fixes questions, and the counts, ranking, and text update (acceptance tests 1 and 2)", async ({ page, browser }) => {
  await logInAsAdmin(page);
  await regroup(page);
  await page.getByRole("link", { name: `Correct questions in ${courseCode}` }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/questions/${courseId}$`));
  await expect(groupCard(page, 1)).toContainText("Explain TCP congestion control.");
  await expect(groupCard(page, 1)).toContainText("in 3 of 3 papers");

  // Move: Paper B's "Describe the seven OSI layers." is the OSI question.
  await correct(page, 1, 2);
  await page.getByLabel("Move to group").selectOption({ label: "#2 Define the OSI model." });
  await page.getByRole("button", { name: "Move question" }).click();
  await expect(page.getByRole("status")).toHaveText("Question moved. The counts and ranking are updated.");
  await expect(page.getByText("Moved by an admin")).toBeVisible();
  await page.getByRole("link", { name: `Back to ${courseCode} questions` }).click();
  await expect(groupCard(page, 1)).toContainText("Define the OSI model.");
  await expect(groupCard(page, 1)).toContainText("in 3 of 3 papers");

  // Split: Paper C's TCP question is a different question.
  await correct(page, 2, 1);
  await page.getByRole("button", { name: "Split into its own group" }).click();
  await expect(page.getByRole("status")).toContainText("Question split into a group of its own.");
  await page.getByRole("link", { name: `Back to ${courseCode} questions` }).click();
  await expect(groupCard(page, 2)).toContainText("Explain TCP congestion control.");
  await expect(groupCard(page, 2)).toContainText("in 2 of 3 papers");

  // Edit: Paper A's third question was extracted with typos.
  await correct(page, 0, 3);
  await page.getByLabel("Question text").fill("3. Explain TCP slow start.");
  await page.getByRole("button", { name: "Save text" }).click();
  await expect(page.getByRole("status")).toHaveText("Text corrected. Students see the new text.");
  await expect(page.getByLabel("Question text")).toHaveValue("3. Explain TCP slow start.");

  const visitor = await browser.newPage();
  await visitor.goto(`/courses/${courseId}/exam`);
  await expect(visitor.getByText("Explain TCP slow start.")).toBeVisible();
  await expect(visitor.getByText("Explian")).toHaveCount(0);
  await expect(visitor.getByText("Describe the seven OSI layers.")).toHaveCount(0);
  await visitor.close();
});

test("the corrections survive another regroup and are in the activity log (acceptance test 3)", async ({ page }) => {
  await logInAsAdmin(page);
  await regroup(page);
  await page.goto(`/admin/questions/${courseId}`);
  await expect(groupCard(page, 1)).toContainText("Define the OSI model.");
  await expect(groupCard(page, 1)).toContainText("in 3 of 3 papers");
  // The old text is only in the activity log now.
  await expect(page.getByRole("list", { name: "Question groups" }).getByText("Explian")).toHaveCount(0);
  const log = page.getByRole("table", { name: `Corrections in ${courseCode}` });
  await expect(log.getByRole("row")).toHaveCount(4);
  await expect(log.getByRole("row").nth(1)).toContainText("Text corrected");
  await expect(log.getByRole("row").nth(1)).toContainText(`${papers[0].title}, question 3`);
  await expect(log.getByRole("row").nth(2)).toContainText("Split into its own group");
  await expect(log.getByRole("row").nth(3)).toContainText("Moved to another group");
});

test("a stale edit is refused and an undo groups the question by its text again", async ({ page }) => {
  await logInAsAdmin(page);
  await page.goto(`/admin/questions/${courseId}`);
  await correct(page, 2, 1);
  await expect(page.getByLabel("Question text")).toHaveValue("1. Explain TCP congestion control.");
  // Another admin changes the text while this form is open.
  const question = await db.question.findUniqueOrThrow({ where: { fileId_number: { fileId: papers[2].id, number: 1 } } });
  await db.question.update({ where: { id: question.id }, data: { text: "1. Explain TCP congestion control in detail." } });
  await page.getByLabel("Question text").fill("1. Something else.");
  await page.getByRole("button", { name: "Save text" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Someone else changed this question's text" })).toBeVisible();
  await db.question.update({ where: { id: question.id }, data: { text: question.text } });

  await page.getByRole("button", { name: "Group by text again" }).click();
  await expect(page.getByRole("status")).toHaveText("The question is grouped by its text again.");
  await page.getByRole("link", { name: `Back to ${courseCode} questions` }).click();
  // TCP is back to 3 papers, tied with OSI; the tie goes to the text, so OSI stays first.
  await expect(groupCard(page, 2)).toContainText("Explain TCP congestion control.");
  await expect(groupCard(page, 2)).toContainText("in 3 of 3 papers");
});
