import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-40: rate and sort advice. The spec makes one course with three posts by one author (the middle one anonymous) and
// two other students. Everything is deleted at the end; the course takes its advice and their marks with it.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-votes-${stamp}`;
const password = "password123";
const users = {
  author: { id: `qa-vt-a-${stamp}`, email: `qa-vt-a-${stamp}@mail.aub.edu`, name: `Advice Author ${stamp}` },
  first: { id: `qa-vt-1-${stamp}`, email: `qa-vt-1-${stamp}@mail.aub.edu`, name: "First Reader" },
  second: { id: `qa-vt-2-${stamp}`, email: `qa-vt-2-${stamp}@mail.aub.edu`, name: "Second Reader" },
};
const posts = [
  { id: `${courseId}-old`, title: `Start the labs early ${stamp}`, day: 1, isAnonymous: false },
  { id: `${courseId}-mid`, title: `Redo the midterm ${stamp}`, day: 2, isAnonymous: true },
  { id: `${courseId}-new`, title: `Use office hours ${stamp}`, day: 3, isAnonymous: false },
];
const advicePage = `/courses/${courseId}/advice`;

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: Object.values(users).map(user => ({ ...user, passwordHash })) });
  await db.course.create({ data: { id: courseId, code: `QV${stamp}`, name: `Votes Course ${stamp}`, facultyId: "faculty-eng" } });
  await db.advice.createMany({ data: posts.map(post => ({
    id: post.id, courseId, authorId: users.author.id, isAnonymous: post.isAnonymous, scopeKind: "COURSE", scopeLabel: `QV${stamp}`,
    title: post.title, body: "Some advice.", createdAt: new Date(Date.UTC(2026, 10, post.day)),
  })) });
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
const post = (page: Page, title: string) => page.locator("article").filter({ has: page.getByRole("heading", { name: title }) });
const shownTitles = (page: Page) => page.locator("article h3");
const sortBy = async (page: Page, label: "Newest first" | "Most helpful first") => {
  await page.getByLabel("Sort advice").selectOption({ label });
  await page.getByRole("button", { name: "Search" }).click();
};

test("a visitor sees the counts and a link to log in, but no button", async ({ page }) => {
  await page.goto(advicePage);
  await expect(post(page, posts[0].title)).toContainText("0 students found this helpful");
  await expect(page.getByRole("button", { name: "Mark as helpful" })).toHaveCount(0);
  await expect(post(page, posts[0].title).getByRole("link", { name: "Log in to mark it helpful" })).toBeVisible();
});

test("a mark raises the count by one, a second mark from a stale tab does not, and it can be undone (acceptance tests 1 and 2)", async ({ page, context }) => {
  await logIn(page, users.first.email);
  await page.goto(advicePage);
  const stale = await context.newPage();
  await stale.goto(advicePage);
  await post(page, posts[0].title).getByRole("button", { name: "Mark as helpful" }).click();
  await expect(page.getByRole("status")).toHaveText("Marked as helpful.");
  await expect(post(page, posts[0].title)).toContainText("1 student found this helpful");
  await expect(post(page, posts[0].title).getByRole("button", { name: "Undo helpful" })).toHaveAttribute("aria-pressed", "true");
  // The other tab still shows "Mark as helpful": sending it again sets the same state and does not count twice.
  await post(stale, posts[0].title).getByRole("button", { name: "Mark as helpful" }).click();
  await expect(post(stale, posts[0].title)).toContainText("1 student found this helpful");
  expect(await db.adviceVote.count({ where: { adviceId: posts[0].id } })).toBe(1);
  await post(page, posts[0].title).getByRole("button", { name: "Undo helpful" }).click();
  await expect(page.getByRole("status")).toHaveText("Your helpful mark was removed.");
  await expect(post(page, posts[0].title)).toContainText("0 students found this helpful");
  expect(await db.adviceVote.count({ where: { adviceId: posts[0].id } })).toBe(0);
});

test("most helpful first follows the marks, ties stay newest first, and the sort survives a mark (acceptance test 3)", async ({ page, browser }) => {
  await logIn(page, users.first.email);
  await page.goto(advicePage);
  await sortBy(page, "Most helpful first");
  await expect(page).toHaveURL(/sort=helpful/);
  await expect(shownTitles(page)).toHaveText([posts[2].title, posts[1].title, posts[0].title]);
  await post(page, posts[0].title).getByRole("button", { name: "Mark as helpful" }).click();
  await expect(page.getByRole("status")).toHaveText("Marked as helpful.");
  await expect(page).toHaveURL(/sort=helpful/);
  await expect(page.getByLabel("Sort advice")).toHaveValue("helpful");
  await expect(shownTitles(page)).toHaveText([posts[0].title, posts[2].title, posts[1].title]);
  // A second student marks the anonymous post and the oldest one: the oldest leads with 2.
  const other = await browser.newContext();
  const second = await other.newPage();
  await logIn(second, users.second.email);
  await second.goto(`${advicePage}?sort=helpful`);
  await post(second, posts[1].title).getByRole("button", { name: "Mark as helpful" }).click();
  await expect(post(second, posts[1].title).getByRole("button", { name: "Undo helpful" })).toBeVisible();
  await post(second, posts[0].title).getByRole("button", { name: "Mark as helpful" }).click();
  await expect(post(second, posts[0].title)).toContainText("2 students found this helpful");
  await expect(shownTitles(second)).toHaveText([posts[0].title, posts[1].title, posts[2].title]);
  // The anonymous post keeps its label in the sorted feed.
  await expect(post(second, posts[1].title)).toContainText("Anonymous student");
  await expect(post(second, posts[1].title)).not.toContainText(users.author.name);
  await other.close();
  await sortBy(page, "Newest first");
  await expect(shownTitles(page)).toHaveText([posts[2].title, posts[1].title, posts[0].title]);
});

test("the author sees the count of their own advice but cannot mark it", async ({ page }) => {
  await logIn(page, users.author.email);
  await page.goto(advicePage);
  await expect(post(page, posts[0].title)).toContainText("2 students found this helpful · Your advice");
  await expect(page.getByRole("button", { name: /helpful/ })).toHaveCount(0);
});

test("a tampered form is refused with a message and saves nothing", async ({ page }) => {
  await logIn(page, users.second.email);
  await page.goto(advicePage);
  // The helpful form only; since US-41 each post also has a reply form.
  const form = post(page, posts[2].title).locator("form").filter({ has: page.getByRole("button", { name: /helpful/ }) });
  await form.locator('input[name="helpful"]').evaluate((input: HTMLInputElement) => { input.value = "5"; });
  await form.getByRole("button", { name: "Mark as helpful" }).click();
  await expect(page.locator('p.notice[role="alert"]')).toHaveText("That helpful mark could not be read. Please try again.");
  // After the reload the form is fresh again; now point it at advice that does not exist.
  await form.locator('input[name="adviceId"]').evaluate((input: HTMLInputElement, id) => { input.value = id; }, `${courseId}-missing`);
  await form.getByRole("button", { name: "Mark as helpful" }).click();
  await expect(page.locator('p.notice[role="alert"]')).toHaveText("That advice is no longer available.");
  expect(await db.adviceVote.count({ where: { adviceId: posts[2].id } })).toBe(0);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the sort and the buttons fit a 375 px phone in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 375, height: 800 });
    await logIn(page, users.second.email);
    await page.goto(`${advicePage}?sort=helpful`);
    await expect(page.locator("article")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    for (const button of await page.getByRole("button", { name: /helpful/ }).all()) {
      const box = (await button.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(375);
    }
  });
}

test("the search row keeps the four selects and the Search button on one line at desktop width, and fits 375 px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(advicePage);
  const row = page.getByRole("search");
  const top = async (name: string) => Math.round((await row.getByLabel(name).boundingBox())!.y);
  const button = Math.round((await row.getByRole("button", { name: "Search" }).boundingBox())!.y);
  const selects = await Promise.all(["Filter by topic", "Filter by exam", "Filter by session", "Sort advice"].map(top));
  expect(new Set(selects).size).toBe(1);
  expect(Math.abs(button - selects[0])).toBeLessThanOrEqual(2);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const control of await row.locator("input, select, button").all()) {
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
  }
});
