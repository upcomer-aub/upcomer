import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { configureLogger } from "@/lib/logger";
import { rebuildQuestionBank } from "@/lib/question-bank";
import { logInAsAdmin } from "./fixtures";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-49: answers are marked only against an admin's answer key, mistakes are explained, and a question without a key is
// flagged as not marked, never guessed. Tester's check: marking and explanations are based on evidence; a missing rubric
// is flagged. The spec makes one course with one exam paper of three questions and two students; deleting the course and
// the students at the end deletes the paper, the groups, the keys and the mock exams.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-mark-${stamp}`;
const password = "password123";
const student = { id: `qa-mark-a-${stamp}`, email: `qa-mark-a-${stamp}@mail.aub.edu`, name: "Marked Student" };
const other = { id: `qa-mark-b-${stamp}`, email: `qa-mark-b-${stamp}@mail.aub.edu`, name: "Other Student" };
const texts = {
  handshake: `Explain how the TCP three-way handshake opens a connection ${stamp}.`,
  congestion: `Compare slow start with congestion avoidance ${stamp}.`,
  osi: `State the OSI model layers ${stamp}.`,
};

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  configureLogger({ persist: false });
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: [student, other].map(user => ({ ...user, passwordHash })) });
  await db.course.create({ data: { id: courseId, code: `QK${stamp}`, name: `Marking Course ${stamp}`, facultyId: "faculty-eng" } });
  await db.courseFile.create({ data: {
    id: `${courseId}-paper`, courseId, title: `Networks final ${stamp}`, year: 2025, topic: "Networking", examType: "FINAL", category: "EXAM",
    originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf",
    questions: { create: Object.values(texts).map((text, index) => ({ number: index + 1, text })) },
  } });
  expect((await rebuildQuestionBank(courseId)).ok).toBe(true);
});
test.afterAll(async () => {
  try {
    const userIds = [student.id, other.id];
    await db.$transaction([
      db.course.deleteMany({ where: { id: courseId } }),
      db.session.deleteMany({ where: { userId: { in: userIds } } }),
      db.user.deleteMany({ where: { id: { in: userIds } } }),
    ]);
  } finally {
    await db.$disconnect();
  }
});

const keys = `/admin/answer-keys/${courseId}`;
const status = (page: Page) => page.locator("main").getByRole("status");
const alert = (page: Page) => page.locator("main").getByRole("alert");
const questionCard = (page: Page, text: string) => page.locator("ol.question-list > li").filter({ hasText: text });
async function logIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/my-courses$/);
}
async function writeKey(page: Page, text: string, points: string, explanation: string) {
  await page.goto(keys);
  await page.locator("ol.question-list > li").filter({ hasText: text }).getByRole("link", { name: "Write an answer key" }).click();
  await page.getByLabel(/Key points, one per line/).fill(points);
  await page.getByLabel(/Explanation for students/).fill(explanation);
  await page.getByRole("button", { name: "Save the answer key" }).click();
  await expect(status(page)).toHaveText("The answer key was saved.");
}

test("a student cannot open the answer keys; a visitor is sent to log in", async ({ page }) => {
  await page.goto(keys);
  await expect(page).toHaveURL(/\/login\?next=/);
  await logIn(page, student.email);
  const response = await page.goto(keys);
  expect(response?.status()).toBe(404);
});

test("an admin writes answer keys from the question bank; an empty key is refused", async ({ page }) => {
  await logInAsAdmin(page);
  await page.goto("/admin/questions");
  await page.getByRole("link", { name: `Answer keys for QK${stamp}` }).click();
  await expect(page).toHaveURL(new RegExp(`${keys}$`));
  await expect(page.locator("[data-key-count]")).toHaveText("0 of 3 questions have an answer key.");
  await writeKey(page, texts.handshake, "SYN, SYN-ACK, ACK\nsequence numbers are synchronised", "Both sides agree on starting sequence numbers.");
  await writeKey(page, texts.congestion, "slow start\ncongestion avoidance", "Slow start doubles the window; avoidance grows it by one.");
  await expect(page.locator("[data-key-count]")).toHaveText("2 of 3 questions have an answer key.");
  await page.locator("ol.question-list > li").filter({ hasText: texts.osi }).getByRole("link", { name: "Write an answer key" }).click();
  await page.getByLabel(/Key points, one per line/).evaluate(input => input.removeAttribute("required"));
  await page.getByRole("button", { name: "Save the answer key" }).click();
  await expect(alert(page)).toHaveText("Write at least one key point, one per line.");
});

test("a submitted exam is marked against the keys, mistakes are explained, and the unkeyed question is flagged (acceptance test)", async ({ page }) => {
  await logIn(page, student.email);
  await page.goto(`/courses/${courseId}/mock-exams`);
  await page.getByLabel("Number of questions").fill("3");
  await page.getByRole("button", { name: "Generate mock exam" }).click();
  await expect(page).toHaveURL(new RegExp(`/courses/${courseId}/mock-exams/[a-z0-9]+(\\?same=1)?$`));
  await questionCard(page, texts.handshake).getByRole("textbox").fill("SYN, then SYN-ACK, then ACK; the sequence numbers are synchronised.");
  await questionCard(page, texts.congestion).getByRole("textbox").fill("It uses slow start.");
  await questionCard(page, texts.osi).getByRole("textbox").fill("Seven layers from physical to application.");
  await page.getByRole("button", { name: "Submit exam" }).click();
  await expect(status(page)).toHaveText("Your exam was submitted.");
  await expect(page.locator("[data-marked]")).toHaveText("Your answers were marked against the answer keys. See each question below.");

  const handshake = questionCard(page, texts.handshake);
  await expect(handshake.locator("[data-outcome]")).toHaveText("Correct");
  const congestion = questionCard(page, texts.congestion);
  await expect(congestion.locator("[data-outcome]")).toHaveText("Partly correct");
  await expect(congestion).toContainText('Your answer does not cover: "congestion avoidance".');
  await expect(congestion).toContainText("Slow start doubles the window; avoidance grows it by one.");
  const osi = questionCard(page, texts.osi);
  await expect(osi.locator("[data-outcome]")).toHaveText("Not marked: no answer key");
  await expect(osi).toContainText("This question has no answer key yet, so your answer was not marked.");

  // The marks are stored: they are the same after a reload, and the answers stay locked.
  await page.reload();
  await expect(congestion.locator("[data-outcome]")).toHaveText("Partly correct");
  await expect(handshake.getByRole("textbox")).toHaveAttribute("readonly", "");
  const marked = await db.mockExam.findFirstOrThrow({ where: { courseId, userId: student.id }, select: { markedAt: true } });
  expect(marked.markedAt).not.toBeNull();
  // The two marked questions update the student's profile (US-25); the unkeyed one does not.
  expect(await db.learningEvent.count({ where: { userId: student.id, courseId, source: "MOCK_EXAM" } })).toBe(2);
});

test("another student cannot open the marked exam", async ({ page }) => {
  const exam = await db.mockExam.findFirstOrThrow({ where: { courseId, userId: student.id }, select: { id: true } });
  await logIn(page, other.email);
  const response = await page.goto(`/courses/${courseId}/mock-exams/${exam.id}`);
  expect(response?.status()).toBe(404);
  expect(await page.content()).not.toContain("Partly correct");
});
