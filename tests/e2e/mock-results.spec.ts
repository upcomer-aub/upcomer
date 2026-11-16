import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient, type MarkOutcome } from "@prisma/client";
import bcrypt from "bcryptjs";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-50: after marking, the results report's score and topic breakdown match the actual answers and missed items.
// The spec makes one course, two students, one marked exam (two topics, one question without an answer key), and one
// exam still in progress. Deleting the course and the students at the end deletes the exams.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-res-${stamp}`;
const password = "password123";
const student = { id: `qa-res-a-${stamp}`, email: `qa-res-a-${stamp}@mail.aub.edu`, name: "Results Student" };
const other = { id: `qa-res-b-${stamp}`, email: `qa-res-b-${stamp}@mail.aub.edu`, name: "Other Student" };
const markedId = `qa-res-marked-${stamp}`;
const openId = `qa-res-open-${stamp}`;
const exam = (id: string) => `/courses/${courseId}/mock-exams/${id}`;

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: [student, other].map(user => ({ ...user, passwordHash })) });
  await db.course.create({ data: { id: courseId, code: `QR${stamp}`, name: `Results Course ${stamp}`, facultyId: "faculty-eng" } });
  const now = new Date();
  const base = { userId: student.id, courseId, topicKeys: [], topics: [], difficulty: "MIXED" as const };
  await db.mockExam.create({ data: { ...base, id: markedId, length: 5, status: "SUBMITTED", submittedAt: now, markedAt: now, questions: { create: [
    { position: 1, topic: "TCP", text: `Explain the handshake ${stamp}`, outcome: "CORRECT", matchedPoints: ["SYN", "ACK"], missedPoints: [] },
    { position: 2, topic: "TCP", text: `Compare slow start ${stamp}`, outcome: "PARTIAL", matchedPoints: ["slow start"], missedPoints: ["congestion avoidance"], feedback: 'Your answer does not cover: "congestion avoidance".' },
    { position: 3, topic: "DNS", text: `Explain recursive resolution ${stamp}`, outcome: "INCORRECT", matchedPoints: [], missedPoints: ["root server"], feedback: 'Your answer does not cover: "root server".' },
    { position: 4, topic: "DNS", text: `Define a zone ${stamp}`, outcome: "UNANSWERED", matchedPoints: [], missedPoints: ["authority"], feedback: 'You did not answer. A full answer covers: "authority".' },
    { position: 5, topic: "DNS", text: `State the record types ${stamp}`, outcome: "NO_KEY", matchedPoints: [], missedPoints: [], feedback: "This question has no answer key yet, so your answer was not marked." },
  ].map(question => ({ ...question, outcome: question.outcome as MarkOutcome })).map(question => ({ paperCount: 1, totalPapers: 2, sourcePapers: [], answer: question.outcome === "UNANSWERED" ? null : "An answer.", markedAt: now, ...question })) } } });
  await db.mockExam.create({ data: { ...base, id: openId, length: 3, status: "IN_PROGRESS", questions: { create: [1, 2, 3].map(position => ({
    position, text: `Open question ${position} ${stamp}`, paperCount: 1, totalPapers: 1, sourcePapers: [],
  })) } } });
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

async function logIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/my-courses$/);
}
const row = (page: Page, topic: string) => page.locator(`tr[data-topic="${topic}"] td`);

test("the results report's score and topic breakdown match the marked answers (acceptance test)", async ({ page }) => {
  await logIn(page, student.email);
  await page.goto(exam(markedId));
  await page.getByRole("link", { name: "See your results" }).click();
  await expect(page).toHaveURL(new RegExp(`${exam(markedId)}/results$`));
  // 4 marked: 1 correct; key points covered (1 + 0.5 + 0 + 0) / 4 = 38%.
  await expect(page.locator("[data-score]")).toHaveText("1 of 4 marked questions fully correct · 38% of the key points covered");
  await expect(page.locator("[data-not-marked]")).toContainText("1 of 5 questions was not marked, because it has no answer key.");
  // Weakest first: DNS (0%) before TCP (75%).
  await expect(page.locator("tbody tr th")).toHaveText(["DNS", "TCP"]);
  await expect(row(page, "DNS")).toHaveText(["3", "0", "0", "1", "1", "1", "0%"]);
  await expect(row(page, "TCP")).toHaveText(["2", "1", "1", "0", "0", "0", "75%"]);
  await expect(page.locator("[data-missed]")).toHaveCount(3);
  await expect(page.locator('[data-missed="2"]')).toContainText('Missed: "congestion avoidance"');
  await expect(page.locator('[data-missed="4"]')).toContainText("You did not answer.");
  await expect(page.locator('[data-unmarked="5"]')).toContainText("no answer key yet");
});

test("an exam still in progress has no results yet, and the exams list links only marked exams to results", async ({ page }) => {
  await logIn(page, student.email);
  await page.goto(`${exam(openId)}/results`);
  await expect(page.locator("main").getByRole("status")).toHaveText("Submit the exam to see your results.");
  await page.goto(`/courses/${courseId}/mock-exams`);
  await expect(page.locator(`a[href="${exam(markedId)}/results"]`)).toHaveCount(1);
  await expect(page.locator(`a[href="${exam(openId)}/results"]`)).toHaveCount(0);
});

test("another student cannot open the results", async ({ page }) => {
  await logIn(page, other.email);
  const response = await page.goto(`${exam(markedId)}/results`);
  expect(response?.status()).toBe(404);
  expect(await page.content()).not.toContain("congestion avoidance");
});

test("a visitor is sent to log in", async ({ page }) => {
  await page.goto(`${exam(markedId)}/results`);
  await expect(page).toHaveURL(/\/login\?next=/);
});
