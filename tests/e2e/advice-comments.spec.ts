import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { logInAsAdmin } from "./fixtures";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-41: discuss beneath an advice post. One course with an anonymous post and a named post by one author, and two other
// students; the seeded admin deletes a reply. Everything is deleted at the end; the course takes its advice and replies.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-discuss-${stamp}`;
const password = "password123";
const users = {
  author: { id: `qa-dc-a-${stamp}`, email: `qa-dc-a-${stamp}@mail.aub.edu`, name: `Hidden Author ${stamp}` },
  first: { id: `qa-dc-1-${stamp}`, email: `qa-dc-1-${stamp}@mail.aub.edu`, name: `First Student ${stamp}` },
  second: { id: `qa-dc-2-${stamp}`, email: `qa-dc-2-${stamp}@mail.aub.edu`, name: `Second Student ${stamp}` },
};
const anonymous = { id: `${courseId}-anon`, title: `Redo the midterm ${stamp}` };
const named = { id: `${courseId}-named`, title: `Start the labs early ${stamp}` };
const advicePage = `/courses/${courseId}/advice`;

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: Object.values(users).map(user => ({ ...user, passwordHash })) });
  await db.course.create({ data: { id: courseId, code: `QD${stamp}`, name: `Discussion Course ${stamp}`, facultyId: "faculty-eng" } });
  await db.advice.createMany({ data: [[anonymous, true, 2], [named, false, 1]].map(([post, isAnonymous, day]) => {
    const { id, title } = post as typeof anonymous;
    return { id, courseId, authorId: users.author.id, isAnonymous: isAnonymous as boolean, scopeKind: "COURSE" as const, scopeLabel: `QD${stamp}`, title, body: "Some advice.", createdAt: new Date(Date.UTC(2026, 10, day as number)) };
  }) });
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
const thread = (page: Page, title: string) => post(page, title).locator("details");
const openThread = async (page: Page, title: string) => {
  const details = thread(page, title);
  if (!(await details.getAttribute("open").then(value => value !== null))) await details.locator("summary").click();
  return details;
};
async function reply(page: Page, title: string, text: string) {
  const details = await openThread(page, title);
  await details.getByLabel("Your reply").fill(text);
  await details.getByRole("button", { name: "Post reply" }).click();
  await expect(page.getByRole("status")).toHaveText("Your reply was posted.");
  await expect(thread(page, title)).toHaveAttribute("open", "");
}
const replyTexts = (page: Page, title: string) => thread(page, title).locator("li p:nth-of-type(2)");
const notice = (page: Page) => page.locator('p.notice[role="alert"]');

test("a visitor sees the discussion and a link to log in, but no reply form", async ({ page }) => {
  await page.goto(advicePage);
  const details = await openThread(page, named.title);
  await expect(details.locator("summary")).toHaveText("Discussion (0 replies)");
  await expect(details.getByText("No replies yet.")).toBeVisible();
  await expect(details.getByRole("link", { name: "Log in to reply" })).toBeVisible();
  await expect(details.getByLabel("Your reply")).toHaveCount(0);
});

test("replies show beneath the right post in time order, and an anonymous author stays anonymous (acceptance test 1)", async ({ browser }) => {
  const [first, author] = await Promise.all([browser.newContext(), browser.newContext()]).then(contexts => Promise.all(contexts.map(context => context.newPage())));
  await logIn(first, users.first.email);
  await first.goto(advicePage);
  await expect((await openThread(first, anonymous.title)).getByText("Your reply is shown with your name.")).toBeVisible();
  await reply(first, anonymous.title, `When was the midterm? ${stamp}`);

  await logIn(author, users.author.email);
  await author.goto(advicePage);
  await expect((await openThread(author, anonymous.title)).getByText("Your reply is shown as Anonymous student (author).")).toBeVisible();
  await reply(author, anonymous.title, `Week 7, in the evening. ${stamp}`);

  await first.goto(advicePage);
  await reply(first, anonymous.title, `Thanks! ${stamp}`);
  await expect(replyTexts(first, anonymous.title)).toHaveText([`When was the midterm? ${stamp}`, `Week 7, in the evening. ${stamp}`, `Thanks! ${stamp}`]);
  const details = thread(first, anonymous.title);
  await expect(details.locator("summary")).toHaveText("Discussion (3 replies)");
  await expect(details.locator("li strong")).toHaveText([users.first.name, "Anonymous student (author)", users.first.name]);
  await expect(details).not.toContainText(users.author.name);
  // The other post's thread is untouched.
  await expect(thread(first, named.title).locator("summary")).toHaveText("Discussion (0 replies)");
  await Promise.all([first.context().close(), author.context().close()]);
});

test("an empty reply is refused and saves nothing (acceptance test 3)", async ({ page }) => {
  await logIn(page, users.second.email);
  await page.goto(advicePage);
  const details = await openThread(page, named.title);
  // The box is required in the browser; the server refuses blank text too.
  await expect(details.getByLabel("Your reply")).toHaveAttribute("required", "");
  await details.getByLabel("Your reply").evaluate((box: HTMLTextAreaElement) => { box.required = false; box.value = "   \n  "; });
  await details.getByRole("button", { name: "Post reply" }).click();
  await expect(notice(page)).toHaveText("Write a reply before sending it.");
  expect(await db.adviceComment.count({ where: { adviceId: named.id } })).toBe(0);
});

test("only a reply's author or an admin can delete it; another student is refused", async ({ page, browser }) => {
  await logIn(page, users.second.email);
  await page.goto(advicePage);
  // No Delete button on someone else's reply.
  await expect((await openThread(page, anonymous.title)).getByRole("button", { name: /Delete/ })).toHaveCount(0);
  // A tampered form pointing at the first student's reply is refused, and the reply stays.
  await reply(page, named.title, `My own reply ${stamp}`);
  const target = await db.adviceComment.findFirstOrThrow({ where: { adviceId: anonymous.id, authorId: users.first.id }, orderBy: { createdAt: "asc" }, select: { id: true } });
  const ownDelete = thread(page, named.title).locator("form").filter({ has: page.getByRole("button", { name: "Delete my reply" }) });
  await ownDelete.locator('input[name="commentId"]').evaluate((input: HTMLInputElement, id) => { input.value = id; }, target.id);
  await ownDelete.getByRole("button", { name: "Delete my reply" }).click();
  await expect(notice(page)).toHaveText("You can only delete your own replies.");
  expect(await db.adviceComment.count({ where: { id: target.id } })).toBe(1);
  // Their own reply they can delete.
  await thread(page, named.title).getByRole("button", { name: "Delete my reply" }).click();
  await expect(page.getByRole("status")).toHaveText("The reply was deleted.");
  await expect(thread(page, named.title).locator("summary")).toHaveText("Discussion (0 replies)");

  // The admin can delete any reply.
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await logInAsAdmin(admin);
  await admin.goto(advicePage);
  const adminThread = await openThread(admin, anonymous.title);
  await adminThread.locator("li").filter({ hasText: `Thanks! ${stamp}` }).getByRole("button", { name: "Delete reply" }).click();
  await expect(admin.getByRole("status")).toHaveText("The reply was deleted.");
  await expect(replyTexts(admin, anonymous.title)).toHaveText([`When was the midterm? ${stamp}`, `Week 7, in the evening. ${stamp}`]);
  await adminContext.close();
});

test("a post removed by an admin hides its thread, and a stale reply form is refused (acceptance test 2)", async ({ page }) => {
  await logIn(page, users.first.email);
  await page.goto(advicePage);
  const details = await openThread(page, anonymous.title);
  await details.getByLabel("Your reply").fill(`Posted after removal ${stamp}`);
  // An admin removes the post (US-77's action is not built yet, so the status is set directly).
  await db.advice.update({ where: { id: anonymous.id }, data: { status: "REMOVED", removedAt: new Date() } });
  await details.getByRole("button", { name: "Post reply" }).click();
  await expect(notice(page)).toHaveText("That advice or reply is no longer available.");
  await expect(post(page, anonymous.title)).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(`When was the midterm? ${stamp}`);
  expect(await db.adviceComment.count({ where: { adviceId: anonymous.id, body: { contains: "after removal" } } })).toBe(0);
  await db.advice.update({ where: { id: anonymous.id }, data: { status: "VISIBLE", removedAt: null } });
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the discussion fits a 375 px phone in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 375, height: 800 });
    await logIn(page, users.first.email);
    await page.goto(`${advicePage}?thread=${anonymous.id}`);
    const details = thread(page, anonymous.title);
    await expect(details).toHaveAttribute("open", "");
    await expect(details.getByLabel("Your reply")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    for (const control of await details.locator("textarea, button").all()) {
      const box = (await control.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(375);
    }
  });
}
