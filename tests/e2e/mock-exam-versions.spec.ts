import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { configureLogger } from "@/lib/logger";
import { rebuildQuestionBank } from "@/lib/question-bank";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-46: an alternative version of a mock exam. One course with ten distinct TCP questions and two students. The student
// generates a 3-question TCP exam (US-45), sits it, and asks for alternatives: version 2 and 3 share no question with
// earlier versions, and a 4th is refused because only one unused question is left. Everything is deleted at the end; the
// course takes its papers, questions, groups and mock exams with it.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-versions-${stamp}`;
const password = "password123";
const users = {
  owner: { id: `qa-vr-o-${stamp}`, email: `qa-vr-o-${stamp}@mail.aub.edu`, name: "Version Owner" },
  other: { id: `qa-vr-x-${stamp}`, email: `qa-vr-x-${stamp}@mail.aub.edu`, name: "Other Student" },
};
const TCP = [
  "State the purpose of the TCP checksum.", "Explain how the TCP three way handshake establishes a connection.", "Explain why TCP needs sequence numbers.",
  "Describe how TCP flow control uses the receive window.", "Explain fast retransmit after three duplicate acknowledgements.",
  "Explain the TIME_WAIT state when a TCP connection closes.", "Compare Go-Back-N with Selective Repeat retransmission.",
  "Describe slow start in TCP congestion control.", "Explain how TCP estimates the retransmission timeout.", "Describe the TCP half-close.",
];
const mockExams = `/courses/${courseId}/mock-exams`;

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  configureLogger({ persist: false });
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: Object.values(users).map(user => ({ ...user, passwordHash })) });
  await db.course.create({ data: { id: courseId, code: `QV${stamp}`, name: `Versions Course ${stamp}`, facultyId: "faculty-eng" } });
  await db.courseFile.create({ data: {
    id: `${courseId}-paper`, courseId, title: `TCP final ${stamp}`, year: 2025, topic: "TCP", examType: "FINAL", category: "EXAM",
    originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf",
    questions: { create: TCP.map((text, index) => ({ number: index + 1, text })) },
  } });
  expect(await rebuildQuestionBank(courseId)).toMatchObject({ ok: true, groupCount: 10 });
});
test.afterAll(async () => {
  try {
    const userIds = Object.values(users).map(user => user.id);
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
const shown = (page: Page) => page.locator("ol.question-list > li > p:first-of-type").allTextContents();
const status = (page: Page) => page.locator("main").getByRole("status");
const alert = (page: Page) => page.locator("main").getByRole("alert");
const settingsLine = (page: Page) => page.locator("main h1 + p.muted");
const examUrl = new RegExp(`${mockExams}/([^/?]+)`);
const idOf = (page: Page) => page.url().match(examUrl)![1];
const makeAlternative = (page: Page) => page.getByRole("button", { name: "Make an alternative version" }).click();

let firstId = "";
let firstQuestions: string[] = [];
let secondQuestions: string[] = [];

test("an alternative keeps the settings and changes every question, also after submitting (acceptance tests 1 and 2)", async ({ page }) => {
  await logIn(page, users.owner.email);
  await page.goto(mockExams);
  await page.getByRole("checkbox", { name: /^TCP \(/ }).check();
  await page.getByLabel("Number of questions").fill("3");
  await page.getByLabel("Difficulty").selectOption({ label: "Mixed" });
  await page.getByRole("button", { name: "Generate mock exam" }).click();
  await expect(page).toHaveURL(examUrl);
  firstId = idOf(page);
  firstQuestions = await shown(page);
  expect(firstQuestions).toHaveLength(3);
  const settings = await settingsLine(page).textContent();
  // Submit version 1 first: an alternative is mostly wanted after finishing an exam.
  await page.getByRole("textbox", { name: "Your answer to question 1", exact: true }).fill("Detects corrupted segments.");
  await page.getByRole("button", { name: "Submit exam" }).click();
  await expect(status(page)).toHaveText("Your exam was submitted.");

  await makeAlternative(page);
  await expect(status(page)).toHaveText("This is version 2 of this mock exam: the same topics, length and difficulty, with questions not used in its earlier versions.");
  expect(idOf(page)).not.toBe(firstId);
  await expect(settingsLine(page)).toHaveText(settings!);
  secondQuestions = await shown(page);
  expect(secondQuestions).toHaveLength(3);
  expect(secondQuestions.filter(text => firstQuestions.includes(text))).toEqual([]);
  // A fresh exam: nothing answered, Save and Submit available.
  await expect(page.getByRole("textbox", { name: "Your answer to question 1", exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Submit exam" })).toBeVisible();
  const versions = page.getByRole("region", { name: "Versions" });
  await expect(versions.getByRole("link", { name: "Version 1" })).toHaveAttribute("href", `${mockExams}/${firstId}`);
  await expect(versions.getByText("Version 2 (this one)")).toBeVisible();
});

test("version 3 avoids versions 1 and 2, and a 4th is refused with the count of unused questions", async ({ page }) => {
  await logIn(page, users.owner.email);
  await page.goto(`${mockExams}/${firstId}`);
  // Asked from version 1, the new exam is still the family's next version.
  await makeAlternative(page);
  await expect(status(page)).toContainText("This is version 3 of this mock exam");
  const thirdQuestions = await shown(page);
  expect(new Set([...firstQuestions, ...secondQuestions, ...thirdQuestions]).size).toBe(9);
  const thirdUrl = page.url();
  await makeAlternative(page);
  await expect(alert(page)).toHaveText("Only 1 unused question matches these settings (not in this exam or any of its versions), and a new version needs 3. Make a new mock exam with other topics or a shorter length instead.");
  expect(page.url().split("?")[0]).toBe(thirdUrl.split("?")[0]);
  expect(await db.mockExam.count({ where: { courseId, userId: users.owner.id } })).toBe(3);
  await expect(page.getByRole("region", { name: "Versions" }).getByRole("listitem")).toHaveCount(3);
});

test("another student can neither open a version nor make one from it", async ({ page }) => {
  await logIn(page, users.other.email);
  const response = await page.goto(`${mockExams}/${firstId}`);
  expect(response?.status()).toBe(404);
  // Their own exam's form, pointed at the owner's exam, is refused as not found and makes nothing. The refusal returns to
  // the exam asked about, which is the owner's, so the student sees the same not-found page as opening it directly.
  await page.goto(mockExams);
  await page.getByLabel("Number of questions").fill("3");
  await page.getByRole("button", { name: "Generate mock exam" }).click();
  await expect(page).toHaveURL(examUrl);
  const before = await db.mockExam.count({ where: { courseId } });
  await page.getByRole("region", { name: "Versions" }).locator('input[name="mockExamId"]').evaluate((input: HTMLInputElement, id) => { input.value = id; }, firstId);
  await makeAlternative(page);
  await expect(page).toHaveURL(new RegExp(`${mockExams}/${firstId}\\?version_error=not_found$`));
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(firstQuestions[0]);
  expect(await db.mockExam.count({ where: { courseId } })).toBe(before);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the Versions section fits a 375 px phone in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 375, height: 800 });
    await logIn(page, users.owner.email);
    await page.goto(`${mockExams}/${firstId}`);
    const versions = page.getByRole("region", { name: "Versions" });
    await expect(versions.getByRole("listitem")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const box = (await versions.getByRole("button", { name: "Make an alternative version" }).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(375);
  });
}
