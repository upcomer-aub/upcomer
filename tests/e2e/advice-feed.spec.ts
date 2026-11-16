import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient, type Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-38: students browse a course's advice from previous students at /courses/:courseId/advice (built by US-34/US-39;
// this spec checks the feed). Tester's check: the feed displays only relevant visible advice with the correct course and
// scope. The spec makes three courses, an exam paper, a term, a question group, and advice of every scope (one anonymous,
// one removed, one in another course, one pointing at another course's paper), plus 21 more for the pages. Deleting the
// courses at the end deletes their advice, paper, and group.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-feed-${stamp}`;
const otherCourseId = `qa-feed-other-${stamp}`;
const busyCourseId = `qa-feed-busy-${stamp}`;
const termId = `qa-feed-term-${stamp}`;
const termName = `Fall 2024 QA ${stamp}`;
const paperId = `qa-feed-paper-${stamp}`;
const otherPaperId = `qa-feed-other-paper-${stamp}`;
const paperTitle = `Final 2024 ${stamp}`;
const password = "password123";
const reader = { id: `qa-feed-reader-${stamp}`, email: `qa-feed-reader-${stamp}@mail.aub.edu`, name: "Feed Reader" };
const named = { id: `qa-feed-named-${stamp}`, email: `qa-feed-named-${stamp}@mail.aub.edu`, name: `Named Senior ${stamp}` };
const hidden = { id: `qa-feed-hidden-${stamp}`, email: `qa-feed-hidden-${stamp}@mail.aub.edu`, name: `Hidden Senior ${stamp}` };
const flooder = { id: `qa-feed-flood-${stamp}`, email: `qa-feed-flood-${stamp}@mail.aub.edu`, name: "Feed Flooder" };
const users = [reader, named, hidden, flooder];
const title = {
  course: `Do every past final twice ${stamp}`,
  exam: `This final rewards diagrams ${stamp}`,
  session: `Fall exams were the hardest ${stamp}`,
  topic: `Routing shows up every year ${stamp}`,
  question: `Learn the handshake ${stamp}`,
  removed: `Removed advice ${stamp}`,
  other: `Other course advice ${stamp}`,
  crossCourse: `Points at another course ${stamp}`,
};
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: users.map(user => ({ ...user, passwordHash })) });
  await db.course.createMany({ data: [
    { id: courseId, code: `QF${stamp}`, name: `Feed Course ${stamp}`, facultyId: "faculty-eng" },
    { id: otherCourseId, code: `QO${stamp}`, name: `Other Feed Course ${stamp}`, facultyId: "faculty-eng" },
    { id: busyCourseId, code: `QB${stamp}`, name: `Busy Feed Course ${stamp}`, facultyId: "faculty-eng" },
  ] });
  await db.term.create({ data: { id: termId, name: termName } });
  const paper = (id: string, course: string, paperName: string) => ({
    id, courseId: course, title: paperName, year: 2024, examType: "FINAL" as const, category: "EXAM" as const, termId,
    originalFileName: "final.pdf", storageKey: `qa/${id}.pdf`, mimeType: "application/pdf",
  });
  await db.courseFile.createMany({ data: [paper(paperId, courseId, paperTitle), paper(otherPaperId, otherCourseId, `Other final ${stamp}`)] });
  const group = await db.questionGroup.create({ data: {
    courseId, text: "Explain the TCP three-way handshake.", normalizedText: `qa handshake ${stamp}`, paperCount: 1, rank: 1,
  } });
  const base = (over: Partial<Prisma.AdviceCreateManyInput> & { title: string }): Prisma.AdviceCreateManyInput =>
    ({ courseId, authorId: named.id, scopeKind: "COURSE", scopeLabel: `QF${stamp}`, body: `Body ${stamp}`, ...over });
  await db.advice.createMany({ data: [
    base({ title: title.course, createdAt: minutesAgo(50) }),
    base({ title: title.exam, scopeKind: "EXAM", scopeLabel: paperTitle, fileId: paperId, createdAt: minutesAgo(40) }),
    base({ title: title.session, authorId: hidden.id, isAnonymous: true, scopeKind: "SESSION", scopeLabel: termName, termId, createdAt: minutesAgo(30) }),
    base({ title: title.topic, scopeKind: "TOPIC", scopeLabel: "Routing", topic: "Routing", topicKey: "routing", createdAt: minutesAgo(20) }),
    base({ title: title.question, scopeKind: "QUESTION", scopeLabel: "Explain the TCP three-way handshake.", groupId: group.id, resourceUrl: "https://example.com/tcp", resourceTitle: "TCP notes", createdAt: minutesAgo(10) }),
    base({ title: title.removed, status: "REMOVED", removedAt: minutesAgo(2), removedById: named.id, createdAt: minutesAgo(5) }),
    // Bad data that publishing refuses: this course's advice pointing at another course's paper.
    base({ title: title.crossCourse, scopeKind: "EXAM", scopeLabel: "x", fileId: otherPaperId, createdAt: minutesAgo(3) }),
    base({ title: title.other, courseId: otherCourseId, createdAt: minutesAgo(1) }),
    ...Array.from({ length: 21 }, (_, index) => base({ courseId: busyCourseId, title: `Busy advice ${index + 1} ${stamp}`, createdAt: minutesAgo(100 - index) })),
  ] });
});
test.afterAll(async () => {
  try {
    const userIds = users.map(user => user.id);
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
async function logIn(page: Page, email = reader.email) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/my-courses$/);
}
const posts = (page: Page) => page.locator("article.card");
const post = (page: Page, text: string) => posts(page).filter({ hasText: text });

test("the course page links to the feed, which shows only this course's visible advice, newest first", async ({ page }) => {
  await logIn(page);
  await page.goto(`/courses/${courseId}`);
  await page.getByRole("link", { name: "Read Student Advice" }).click();
  await expect(page).toHaveURL(new RegExp(`${feed}$`));
  await expect(posts(page).locator("h3")).toHaveText([title.question, title.topic, title.session, title.exam, title.course]);
  for (const hiddenTitle of [title.removed, title.other, title.crossCourse]) await expect(page.getByText(hiddenTitle)).toHaveCount(0);
});

test("each advice says what it is about, and an https resource opens safely in a new tab", async ({ page }) => {
  await logIn(page);
  await page.goto(feed);
  await expect(post(page, title.course)).toContainText("The whole course");
  await expect(post(page, title.exam)).toContainText(`An exam paper: ${paperTitle}`);
  await expect(post(page, title.session)).toContainText(`A session (term): ${termName}`);
  await expect(post(page, title.topic)).toContainText("A topic: Routing");
  await expect(post(page, title.question)).toContainText("A question: Explain the TCP three-way handshake.");
  const link = post(page, title.question).getByRole("link", { name: "TCP notes" });
  await expect(link).toHaveAttribute("href", "https://example.com/tcp");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
});

test("an anonymous author's name and every author ID stay out of the page", async ({ page }) => {
  await logIn(page);
  await page.goto(feed);
  await expect(post(page, title.session)).toContainText("Anonymous student");
  await expect(post(page, title.exam)).toContainText(named.name);
  const html = await page.content();
  expect(html).not.toContain(hidden.name);
  for (const user of users) expect(html).not.toContain(user.id);
});

test("a visitor can read the feed and is asked to log in to publish", async ({ page }) => {
  await page.goto(feed);
  await expect(posts(page)).toHaveCount(5);
  await expect(page.getByRole("main").getByRole("link", { name: "Log in" })).toHaveAttribute("href", `/login?next=${encodeURIComponent(feed)}`);
});

test("21 advice make two pages of 20 and 1, with no advice twice", async ({ page }) => {
  await logIn(page);
  await page.goto(`/courses/${busyCourseId}/advice`);
  await expect(posts(page)).toHaveCount(20);
  await expect(posts(page).first()).toContainText(`Busy advice 21 ${stamp}`);
  await expect(page.getByLabel("Pages")).toContainText("Page 1 of 2");
  await page.getByRole("link", { name: "Next →" }).click();
  await expect(posts(page)).toHaveCount(1);
  await expect(posts(page).first()).toContainText(`Busy advice 1 ${stamp}`);
  await page.goto(`/courses/${busyCourseId}/advice?page=99`);
  await expect(page.getByLabel("Pages")).toContainText("Page 2 of 2");
  await page.goto(`/courses/${busyCourseId}/advice?page=abc`);
  await expect(page.getByLabel("Pages")).toContainText("Page 1 of 2");
});

test("a student's new advice shows at the top at once, though the feed is cached", async ({ page }) => {
  await logIn(page);
  await page.goto(feed);
  await expect(posts(page).first()).toContainText(title.question);
  const fresh = `Fresh advice ${stamp}`;
  await page.getByLabel("Title").fill(fresh);
  await page.getByLabel("Your advice").fill("Go to office hours in week 3.");
  await page.getByRole("button", { name: "Publish advice" }).click();
  await expect(posts(page).first()).toContainText(fresh);
  await page.reload();
  await expect(posts(page).first()).toContainText(fresh);
});

test("a student flooding the feed is stopped at 120 reads a minute; another student is still served", async ({ page, browser }) => {
  await logIn(page, flooder.email);
  // The request client does not send the Secure session cookie over http, so the reads are made from inside the page.
  const statuses = await page.evaluate(async url => {
    const codes: number[] = [];
    for (let index = 0; index < 120; index++) codes.push((await fetch(url)).status);
    return codes;
  }, feed);
  expect(statuses.every(code => code === 200)).toBe(true);
  await page.goto(feed);
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("You are opening advice pages too quickly. Wait a minute and try again.");
  await expect(posts(page)).toHaveCount(0);

  const other = await browser.newPage();
  await logIn(other);
  await other.goto(feed);
  await expect(posts(other).first()).toBeVisible();
  await other.close();
});
