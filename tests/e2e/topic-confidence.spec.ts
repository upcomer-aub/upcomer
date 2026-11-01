import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { configureLogger } from "@/lib/logger";
import { rebuildQuestionBank } from "@/lib/question-bank";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-24: a student rates their confidence in a course's topics. The spec makes one course with five topic-tagged exam
// papers (the same as the personal order's spec) and two students. Everything is deleted at the end; the course takes its
// papers, questions, groups, and profile rows with it.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-conf-${stamp}`;
const password = "password123";
const students = {
  a: { id: `qa-conf-a-${stamp}`, email: `qa-conf-a-${stamp}@mail.aub.edu`, name: "Rates Topics" },
  b: { id: `qa-conf-b-${stamp}`, email: `qa-conf-b-${stamp}@mail.aub.edu`, name: "Skips Topics" },
};
const handshake = "Explain the TCP three-way handshake.";
const routing = "Describe link-state routing.";
const dns = "Explain how DNS resolves a host name.";
const papers: Array<[number, string, string[]]> = [
  [2021, "TCP", [handshake]], [2022, "TCP", [handshake]], [2023, "Routing", [handshake, routing]], [2024, "Routing", [routing]], [2025, "DNS", [dns]],
];

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  configureLogger({ persist: false });
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: Object.values(students).map(student => ({ ...student, passwordHash })) });
  await db.course.create({ data: { id: courseId, code: `QC${stamp}`, name: `Confidence Course ${stamp}`, facultyId: "faculty-eng" } });
  for (const [year, topic, texts] of papers) {
    await db.courseFile.create({ data: {
      id: `${courseId}-${year}`, courseId, title: `Exam ${year} ${stamp}`, year, topic, examType: "FINAL", category: "EXAM",
      originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf",
      questions: { create: texts.map((text, index) => ({ number: index + 1, text })) },
    } });
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

const confidence = `/courses/${courseId}/confidence`;
const exam = `/courses/${courseId}/exam`;
async function fillLogIn(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}
async function logIn(page: Page, email: string) {
  await page.goto("/login");
  await fillLogIn(page, email);
  await expect(page).toHaveURL(/\/my-courses$/);
}
const topic = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
const rating = (page: Page, name: string, label: string) => topic(page, name).getByRole("radio", { name: label, exact: true });
const profile = (userId: string) =>
  db.learningTopic.findMany({ where: { userId, courseId }, orderBy: { topicKey: "asc" }, select: { topicKey: true, weakness: true, confidence: true } });
// The questions as shown, top to bottom.
const shown = (page: Page) => page.locator("li[data-tier] > p:first-of-type");

test("a visitor is sent to log in and comes back to the ratings", async ({ page }) => {
  await page.goto(confidence);
  await expect(page).toHaveURL(/\/login\?next=/);
  await fillLogIn(page, students.a.email);
  await expect(page).toHaveURL(new RegExp(`${confidence}$`));
  await expect(page.getByRole("heading", { name: "Rate your topics" })).toBeVisible();
  for (const name of ["TCP", "Routing", "DNS"]) await expect(rating(page, name, "Skip")).toBeChecked();
});

test("rating topics changes the personal order (from the no-profile note to a reordered exam)", async ({ page }) => {
  await logIn(page, students.a.email);
  await page.goto(`${exam}?order=personal`);
  await expect(page.getByText("You have no learning profile for this course yet, so this is the frequency order.")).toBeVisible();
  await expect(shown(page)).toHaveText([handshake, routing, dns]);
  await page.getByRole("note").getByRole("link", { name: "Rate your topics" }).click();
  await expect(page).toHaveURL(new RegExp(`${confidence}$`));

  await rating(page, "Routing", "1 · Not confident").check();
  await rating(page, "TCP", "5 · Very confident").check();
  await rating(page, "DNS", "5 · Very confident").check();
  await page.getByRole("button", { name: "Save ratings" }).click();
  await expect(page.getByRole("status")).toContainText("Your ratings were saved.");
  expect(await profile(students.a.id)).toEqual([
    { topicKey: "dns", weakness: 0, confidence: 5 }, { topicKey: "routing", weakness: 1, confidence: 1 }, { topicKey: "tcp", weakness: 0, confidence: 5 },
  ]);

  await page.getByRole("link", { name: "See your personal order" }).click();
  await expect(page).toHaveURL(new RegExp(`${exam}\\?order=personal$`));
  await expect(page.getByRole("heading", { name: /Your order/ })).toBeVisible();
  await expect(shown(page)).toHaveText([routing, handshake, dns]);
});

test("the ratings are pre-filled after logging out and back in, and can be changed", async ({ page }) => {
  await logIn(page, students.a.email);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
  await logIn(page, students.a.email);
  await page.goto(confidence);
  await expect(rating(page, "Routing", "1 · Not confident")).toBeChecked();
  await expect(rating(page, "TCP", "5 · Very confident")).toBeChecked();
  await expect(rating(page, "DNS", "5 · Very confident")).toBeChecked();

  await rating(page, "TCP", "3 · Somewhat confident").check();
  await page.getByRole("button", { name: "Save ratings" }).click();
  await expect(page.getByRole("status")).toContainText("Your ratings were saved.");
  await expect(rating(page, "TCP", "3 · Somewhat confident")).toBeChecked();
});

test("skipping a topic gives it the neutral default", async ({ page }) => {
  // Student B skips everything: each topic gets the neutral default with no rating.
  await logIn(page, students.b.email);
  await page.goto(confidence);
  await page.getByRole("button", { name: "Save ratings" }).click();
  await expect(page.getByRole("status")).toContainText("Your ratings were saved.");
  expect(await profile(students.b.id)).toEqual(["dns", "routing", "tcp"].map(topicKey => ({ topicKey, weakness: 0.5, confidence: null })));

  // Student A clears an earlier rating with Skip: back to the neutral default.
  await page.getByRole("button", { name: "Log out" }).click();
  await logIn(page, students.a.email);
  await page.goto(confidence);
  await rating(page, "DNS", "Skip").check();
  await page.getByRole("button", { name: "Save ratings" }).click();
  await expect(page.getByRole("status")).toContainText("Your ratings were saved.");
  await expect(rating(page, "DNS", "Skip")).toBeChecked();
  expect((await profile(students.a.id)).find(row => row.topicKey === "dns")).toEqual({ topicKey: "dns", weakness: 0.5, confidence: null });
});

test("tampered input is refused with a message and saves nothing", async ({ page }) => {
  await logIn(page, students.a.email);
  await page.goto(confidence);
  const before = await profile(students.a.id);

  // A rating outside 1-5.
  await rating(page, "Routing", "5 · Very confident").evaluate(input => {
    (input as HTMLInputElement).value = "9";
    (input as HTMLInputElement).checked = true;
  });
  await page.getByRole("button", { name: "Save ratings" }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText("Choose a rating from 1 to 5, or Skip, for each topic.");
  expect(await profile(students.a.id)).toEqual(before);

  // A topic that is not in this course.
  await page.goto(confidence);
  await page.locator("form", { has: page.getByRole("button", { name: "Save ratings" }) }).evaluate(form => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "rating:operating systems";
    input.value = "1";
    form.append(input);
  });
  await page.getByRole("button", { name: "Save ratings" }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText("One of those topics isn't part of this course. Reload the page and try again.");
  expect(await profile(students.a.id)).toEqual(before);
  expect(await db.learningTopic.count({ where: { userId: students.a.id, courseId, topicKey: "operating systems" } })).toBe(0);
});
