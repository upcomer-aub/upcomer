import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-38: a student browses a course's advice from previous students. The spec makes two courses, an exam paper, a term,
// a question group, and advice of every scope (one anonymous, one removed, one in the other course), plus 21 more in a
// third course for the pages. Deleting the courses at the end deletes their advice, paper, and group.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-adv-${stamp}`;
const otherCourseId = `qa-adv-other-${stamp}`;
const busyCourseId = `qa-adv-busy-${stamp}`;
const termId = `qa-adv-term-${stamp}`;
const termName = `Fall 2024 QA ${stamp}`;
const paperId = `qa-adv-paper-${stamp}`;
const paperTitle = `Final 2024 ${stamp}`;
const password = "password123";
const reader = { id: `qa-adv-reader-${stamp}`, email: `qa-adv-reader-${stamp}@mail.aub.edu`, name: "Advice Reader" };
const named = { id: `qa-adv-named-${stamp}`, email: `qa-adv-named-${stamp}@mail.aub.edu`, name: `Named Senior ${stamp}` };
const hidden = { id: `qa-adv-hidden-${stamp}`, email: `qa-adv-hidden-${stamp}@mail.aub.edu`, name: `Hidden Senior ${stamp}` };
const advice = {
  course: `Do every past final twice. ${stamp}`,
  exam: `This final rewards clear diagrams. ${stamp}`,
  session: `Fall exams were the hardest. ${stamp}`,
  topic: `Routing shows up every year. ${stamp}`,
  question: `Learn the handshake by heart. ${stamp}`,
  removed: `This advice was removed. ${stamp}`,
  other: `Advice for the other course. ${stamp}`,
};
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: [reader, named, hidden].map(user => ({ ...user, passwordHash })) });
  await db.course.createMany({ data: [
    { id: courseId, code: `QA${stamp}`, name: `Advice Course ${stamp}`, facultyId: "faculty-eng" },
    { id: otherCourseId, code: `QO${stamp}`, name: `Other Advice Course ${stamp}`, facultyId: "faculty-eng" },
    { id: busyCourseId, code: `QB${stamp}`, name: `Busy Advice Course ${stamp}`, facultyId: "faculty-eng" },
  ] });
  await db.term.create({ data: { id: termId, name: termName } });
  await db.courseFile.create({ data: {
    id: paperId, courseId, title: paperTitle, year: 2024, examType: "FINAL", category: "EXAM",
    originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf",
  } });
  const group = await db.questionGroup.create({ data: {
    courseId, text: "Explain the TCP three-way handshake.", normalizedText: `qa handshake ${stamp}`, paperCount: 1, rank: 1,
  } });
  await db.advice.createMany({ data: [
    { courseId, authorId: named.id, body: advice.course, createdAt: minutesAgo(50) },
    { courseId, authorId: named.id, body: advice.exam, scope: "EXAM", fileId: paperId, createdAt: minutesAgo(40) },
    { courseId, authorId: hidden.id, anonymous: true, body: advice.session, scope: "SESSION", termId, createdAt: minutesAgo(30), editedAt: minutesAgo(1) },
    { courseId, authorId: named.id, body: advice.topic, scope: "TOPIC", topic: "Routing", createdAt: minutesAgo(20) },
    { courseId, authorId: named.id, body: advice.question, scope: "QUESTION", questionGroupId: group.id, resourceUrl: "https://example.com/tcp", createdAt: minutesAgo(10) },
    { courseId, authorId: named.id, body: advice.removed, status: "REMOVED", removedAt: minutesAgo(2), removedById: named.id, createdAt: minutesAgo(5) },
    { courseId: otherCourseId, authorId: named.id, body: advice.other, createdAt: minutesAgo(1) },
    ...Array.from({ length: 21 }, (_, index) => ({ courseId: busyCourseId, authorId: named.id, body: `Busy advice ${index + 1} ${stamp}`, createdAt: minutesAgo(100 - index) })),
  ] });
});
test.afterAll(async () => {
  try {
    const userIds = [reader, named, hidden].map(user => user.id);
    await db.$transaction([
      db.course.deleteMany({ where: { id: { in: [courseId, otherCourseId, busyCourseId] } } }),
      db.term.deleteMany({ where: { id: termId } }),
      db.session.deleteMany({ where: { userId: { in: userIds } } }),
      db.user.deleteMany({ where: { id: { in: userIds } } }),
    ]);
  } finally {
    await db.$disconnect();
  }
});

const feed = `/courses/${courseId}/advice`;
async function fillLogIn(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}
async function logIn(page: Page) {
  await page.goto("/login");
  await fillLogIn(page, reader.email);
  await expect(page).toHaveURL(/\/my-courses$/);
}
const posts = (page: Page) => page.getByRole("list", { name: "Advice from previous students" }).getByRole("article");
const post = (page: Page, text: string) => posts(page).filter({ hasText: text });

test("a visitor is sent to log in and comes back to the advice", async ({ page }) => {
  await page.goto(feed);
  await expect(page).toHaveURL(/\/login\?next=/);
  await fillLogIn(page, reader.email);
  await expect(page).toHaveURL(new RegExp(`${feed}$`));
  await expect(page.getByRole("heading", { name: "Advice from previous students" })).toBeVisible();
});

test("the course page links to the feed, which shows only this course's visible advice, newest first", async ({ page }) => {
  await logIn(page);
  await page.goto(`/courses/${courseId}`);
  await page.getByRole("link", { name: "Read Student Advice" }).click();
  await expect(page).toHaveURL(new RegExp(`${feed}$`));
  await expect(page.getByRole("status")).toHaveText("5 pieces of advice.");
  await expect(posts(page).locator("p:nth-of-type(3)")).toHaveText([advice.question, advice.topic, advice.session, advice.exam, advice.course]);
  await expect(page.getByText(advice.removed)).toHaveCount(0);
  await expect(page.getByText(advice.other)).toHaveCount(0);
  await expect(posts(page).first().getByText("Student advice")).toBeVisible();
});

test("each advice says what it is about, and the exam and question link to them", async ({ page }) => {
  await logIn(page);
  await page.goto(feed);
  await expect(post(page, advice.course)).toContainText("About the whole course");
  await expect(post(page, advice.session)).toContainText(`About the term: ${termName}`);
  await expect(post(page, advice.topic)).toContainText("About the topic: Routing");
  await expect(post(page, advice.exam).getByRole("link", { name: paperTitle })).toHaveAttribute("href", `/files/${paperId}`);
  await post(page, advice.question).getByRole("link", { name: "Explain the TCP three-way handshake." }).click();
  await expect(page).toHaveURL(new RegExp(`/courses/${courseId}/exam$`));
});

test("an anonymous author's name is nowhere on the page; a named author's is", async ({ page }) => {
  await logIn(page);
  await page.goto(feed);
  await expect(post(page, advice.session)).toContainText("By Anonymous student");
  await expect(post(page, advice.session)).toContainText("· edited");
  await expect(post(page, advice.course)).toContainText(`By ${named.name}`);
  const html = await page.content();
  expect(html).not.toContain(hidden.name);
  expect(html).not.toContain(hidden.id);
  expect(html).not.toContain(named.id);
});

test("a resource link opens in a new tab without access to the page", async ({ page }) => {
  await logIn(page);
  await page.goto(feed);
  const link = post(page, advice.question).getByRole("link", { name: "https://example.com/tcp" });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
});

test("a course with more than 20 pieces of advice has pages, and one without any says so", async ({ page }) => {
  await logIn(page);
  await page.goto(`/courses/${busyCourseId}/advice`);
  await expect(page.getByRole("status")).toHaveText("21 pieces of advice, page 1 of 2.");
  await expect(posts(page)).toHaveCount(20);
  await expect(posts(page).first()).toContainText(`Busy advice 21 ${stamp}`);
  await page.getByRole("link", { name: "Older →" }).click();
  await expect(page).toHaveURL(new RegExp(`/courses/${busyCourseId}/advice\\?page=2$`));
  await expect(posts(page)).toHaveCount(1);
  await expect(posts(page)).toContainText(`Busy advice 1 ${stamp}`);

  await db.advice.updateMany({ where: { courseId: otherCourseId }, data: { status: "REMOVED", removedAt: new Date() } });
  await page.goto(`/courses/${otherCourseId}/advice`);
  await expect(page.getByText(`No advice has been shared for QO${stamp} yet.`)).toBeVisible();
});

test("an unknown course shows the not-found page", async ({ page }) => {
  await logIn(page);
  const response = await page.goto(`/courses/qa-no-such-course-${stamp}/advice`);
  expect(response?.status()).toBe(404);
});
