import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-43: a student reports advice from the course feed with a reason; the report is linked to the advice, a second report
// of the same advice is refused, and one's own or removed advice cannot be reported. The spec makes one course with
// advice by an author and by nobody; deleting the course at the end deletes the advice and its reports.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-advrep-${stamp}`;
const password = "password123";
const author = { id: `qa-advrep-author-${stamp}`, email: `qa-advrep-author-${stamp}@mail.aub.edu`, name: `Advice Author ${stamp}` };
const reporter = { id: `qa-advrep-reporter-${stamp}`, email: `qa-advrep-reporter-${stamp}@mail.aub.edu`, name: `Reporter ${stamp}` };
const busy = { id: `qa-advrep-busy-${stamp}`, email: `qa-advrep-busy-${stamp}@mail.aub.edu`, name: `Busy Reporter ${stamp}` };
const users = [author, reporter, busy];
const ids = { rude: `qa-advrep-rude-${stamp}`, anon: `qa-advrep-anon-${stamp}`, gone: `qa-advrep-gone-${stamp}`, own: `qa-advrep-own-${stamp}` };
const text = {
  rude: `Rude advice about the TA. ${stamp}`,
  anon: `Anonymous advice. ${stamp}`,
  gone: `Advice deleted soon. ${stamp}`,
  own: `The reporter's own advice. ${stamp}`,
};
const SPAM = 11;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: users.map(user => ({ ...user, passwordHash })) });
  await db.course.create({ data: { id: courseId, code: `QR${stamp}`, name: `Advice Reports ${stamp}`, facultyId: "faculty-eng" } });
  await db.advice.createMany({ data: [
    { id: ids.rude, courseId, authorId: author.id, body: text.rude, createdAt: minutesAgo(1) },
    { id: ids.anon, courseId, authorId: author.id, anonymous: true, body: text.anon, createdAt: minutesAgo(2) },
    { id: ids.gone, courseId, authorId: author.id, body: text.gone, createdAt: minutesAgo(3) },
    { id: ids.own, courseId, authorId: reporter.id, body: text.own, createdAt: minutesAgo(4) },
    // For the DoS test, older so they sit after the advice above on the first page.
    ...Array.from({ length: SPAM }, (_, index) => ({
      id: `qa-advrep-spam-${index}-${stamp}`, courseId, authorId: author.id, body: `Spam ${index}. ${stamp}`, createdAt: minutesAgo(10 + index),
    })),
  ] });
});
test.afterAll(async () => {
  try {
    const userIds = users.map(user => user.id);
    await db.$transaction([
      db.course.deleteMany({ where: { id: courseId } }),
      db.session.deleteMany({ where: { userId: { in: userIds } } }),
      db.user.deleteMany({ where: { id: { in: userIds } } }),
    ]);
  } finally {
    await db.$disconnect();
  }
});

const feed = `/courses/${courseId}/advice`;
async function logIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/my-courses$/);
}
const post = (page: Page, body: string) => page.getByRole("list", { name: "Advice from previous students" }).getByRole("article").filter({ hasText: body });
async function openReport(page: Page, body: string) {
  await post(page, body).getByRole("link", { name: "Report this advice" }).click();
  await expect(page.getByRole("heading", { name: "Report this advice" })).toBeVisible();
  await expect(page.getByRole("article", { name: "The advice you are reporting" })).toContainText(body);
}
async function sendReport(page: Page, reason: string, note = "") {
  await page.getByLabel(reason).check();
  if (note) await page.getByLabel("Details for the admin (optional)").fill(note);
  await page.getByRole("button", { name: "Send report" }).click();
}
async function report(page: Page, body: string, reason: string, note = "") {
  await openReport(page, body);
  await sendReport(page, reason, note);
}
const reportsOf = (adviceId: string) => db.adviceReport.findMany({ where: { adviceId } });

test("a student reports advice with a reason and details; it is linked to the advice, and the feed says it was reported", async ({ page }) => {
  await logIn(page, reporter.email);
  await page.goto(feed);
  await expect(post(page, text.own).getByRole("link", { name: "Report this advice" })).toHaveCount(0);
  await report(page, text.rude, "It is insulting, harassing, or hateful", "It names and insults a TA.");
  await expect(page).toHaveURL(new RegExp(`${feed}\\?reported=1$`));
  await expect(page.getByRole("status").filter({ hasText: "Thanks, your report was sent." })).toBeVisible();
  await expect(post(page, text.rude)).toContainText("You reported this advice. An admin will check it.");
  await expect(post(page, text.rude).getByRole("link", { name: "Report this advice" })).toHaveCount(0);
  // Its report page says so too, instead of offering the form.
  await page.goto(`${feed}/${ids.rude}/report`);
  await expect(page.getByText("You already reported this advice. An admin will check it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send report" })).toHaveCount(0);
  expect(await reportsOf(ids.rude)).toEqual([expect.objectContaining({
    courseId, reporterId: reporter.id, reason: "OFFENSIVE", note: "It names and insults a TA.", status: "OPEN",
  })]);
  // The advice itself stays up until an admin decides (US-77).
  expect((await db.advice.findUniqueOrThrow({ where: { id: ids.rude } })).status).toBe("VISIBLE");
});

test("a second report of the same advice, from a page opened before the first, is refused and stored once", async ({ page, browser }) => {
  await logIn(page, reporter.email);
  await page.goto(feed);
  await openReport(page, text.anon);
  const second = await browser.newPage();
  try {
    await second.context().addCookies(await page.context().cookies());
    await second.goto(feed);
    await report(second, text.anon, "It is advertising, or not about the course");
    await expect(second.getByRole("status").filter({ hasText: "Thanks, your report was sent." })).toBeVisible();
  } finally {
    await second.close();
  }
  // The first page still shows the form.
  await sendReport(page, "Something else");
  await expect(page).toHaveURL(new RegExp(`${feed}\\?report_error=duplicate$`));
  await expect(page.getByRole("alert").filter({ hasText: "already reported" })).toHaveText("You already reported this advice. An admin will check it.");
  expect(await reportsOf(ids.anon)).toEqual([expect.objectContaining({ reason: "SPAM" })]);
});

test("reporting an anonymous advice shows nobody its author", async ({ page }) => {
  await logIn(page, reporter.email);
  await page.goto(feed);
  await expect(post(page, text.anon)).toContainText("By Anonymous student");
  expect(await page.content()).not.toContain(author.id);
  await expect(post(page, text.anon)).not.toContainText(author.name);
});

test("advice its author deleted after the page was opened cannot be reported any more", async ({ page, browser }) => {
  await logIn(page, reporter.email);
  await page.goto(feed);
  await openReport(page, text.gone);
  // The author deletes it from their own edit page (US-36), which also clears the feed's cache.
  const authorPage = await browser.newPage();
  try {
    await logIn(authorPage, author.email);
    await authorPage.goto(`${feed}/${ids.gone}/edit`);
    await authorPage.getByRole("button", { name: "Delete advice" }).click();
    await expect(authorPage.getByRole("status").filter({ hasText: "Your advice was deleted." })).toBeVisible();
  } finally {
    await authorPage.close();
  }
  await sendReport(page, "Something else");
  await expect(page).toHaveURL(new RegExp(`${feed}\\?report_error=not_found$`));
  await expect(page.getByRole("alert").filter({ hasText: "no longer shown" })).toBeVisible();
  await expect(page.getByText(text.gone)).toHaveCount(0);
  expect(await reportsOf(ids.gone)).toEqual([]);
  // Its report page is gone too.
  expect((await page.goto(`${feed}/${ids.gone}/report`))?.status()).toBe(404);
});

test("a forged form cannot report one's own advice nor use a reason not on the list", async ({ page }) => {
  await logIn(page, reporter.email);
  await page.goto(feed);
  // Their own advice has no report page form.
  await page.goto(`${feed}/${ids.own}/report`);
  await expect(page.getByRole("note").filter({ hasText: "your own advice" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send report" })).toHaveCount(0);

  // Another advice's form, pointed at their own advice.
  await page.goto(feed);
  await openReport(page, `Spam 0. ${stamp}`);
  await page.locator('input[name="adviceId"]').evaluate((input, target) => { (input as HTMLInputElement).value = target; }, ids.own);
  await sendReport(page, "Something else");
  await expect(page.getByRole("alert").filter({ hasText: "your own advice" })).toHaveText("This is your own advice. To take it down, edit or delete it instead.");

  await page.goto(feed);
  await openReport(page, `Spam 0. ${stamp}`);
  await page.getByLabel("Something else").check();
  await page.locator('input[name="reason"]:checked').evaluate((input) => { (input as HTMLInputElement).value = "MADE_UP"; });
  expect(await page.locator('input[name="reason"]:checked').inputValue()).toBe("MADE_UP");
  await page.getByRole("button", { name: "Send report" }).click();
  // Back on the report page, with the message.
  await expect(page).toHaveURL(new RegExp(`/report\\?error=invalid_reason$`));
  await expect(page.getByRole("alert").filter({ hasText: "Choose what" })).toHaveText("Choose what is wrong with the advice.");
  expect(await reportsOf(ids.own)).toEqual([]);
  expect(await reportsOf(`qa-advrep-spam-0-${stamp}`)).toEqual([]);
});

test("DoS: a student reporting over and over is stopped after 10 reports a minute", async ({ page }) => {
  await logIn(page, busy.email);
  for (let index = 0; index < 10; index++) {
    await page.goto(feed);
    await report(page, `Spam ${index}. ${stamp}`, "It is advertising, or not about the course");
    await expect(page.getByRole("status").filter({ hasText: "Thanks, your report was sent." })).toBeVisible();
  }
  await page.goto(feed);
  await report(page, `Spam 10. ${stamp}`, "It is advertising, or not about the course");
  await expect(page.getByRole("alert").filter({ hasText: "Too many" })).toHaveText("Too many reports in a minute. Wait a moment and try again.");
  expect(await db.adviceReport.count({ where: { reporterId: busy.id } })).toBe(10);
});
