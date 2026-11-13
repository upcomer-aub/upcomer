import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { actionIdFor } from "../reliability/client";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-77: an admin reviews reported advice and removes it or keeps it; the feed updates at once; a student can neither see
// the queue nor send a decision. This is step 3 of the sprint demo: another student reports advice, the admin removes
// it, the feed updates. Deleting the course at the end deletes the advice and its reports.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-advmod-${stamp}`;
const password = "password123";
const author = { id: `qa-advmod-author-${stamp}`, email: `qa-advmod-author-${stamp}@mail.aub.edu`, name: `Hidden Author ${stamp}` };
const reporter = { id: `qa-advmod-reporter-${stamp}`, email: `qa-advmod-reporter-${stamp}@mail.aub.edu`, name: `Reporter ${stamp}` };
const admin = { id: `qa-advmod-admin-${stamp}`, email: `qa-advmod-admin-${stamp}@mail.aub.edu`, name: `Moderator ${stamp}`, role: "ADMIN" as const };
const users = [author, reporter, admin];
const ids = { rude: `qa-advmod-rude-${stamp}`, fine: `qa-advmod-fine-${stamp}` };
const text = { rude: `The TA is useless, skip everything. ${stamp}`, fine: `Do the past finals. ${stamp}` };

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: users.map(user => ({ ...user, passwordHash })) });
  await db.course.create({ data: { id: courseId, code: `QM${stamp}`, name: `Advice Moderation ${stamp}`, facultyId: "faculty-eng" } });
  await db.advice.createMany({ data: [
    { id: ids.rude, courseId, authorId: author.id, anonymous: true, body: text.rude, createdAt: new Date(Date.now() - 60_000) },
    { id: ids.fine, courseId, authorId: author.id, body: text.fine, createdAt: new Date(Date.now() - 120_000) },
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
const queue = "/admin/advice-reports";
async function logIn(page: Page, email: string, landing = /\/my-courses$/) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(landing);
}
const post = (page: Page, body: string) => page.getByRole("list", { name: "Advice from previous students" }).getByRole("article").filter({ hasText: body });
const queued = (page: Page, body: string) => page.getByRole("list", { name: "Reported advice" }).getByRole("listitem").filter({ hasText: body });
async function report(page: Page, body: string, reason: string, note = "") {
  await page.goto(feed);
  await post(page, body).getByRole("link", { name: "Report this advice" }).click();
  await page.getByLabel(reason).check();
  if (note) await page.getByLabel("Details for the admin (optional)").fill(note);
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Thanks, your report was sent." })).toBeVisible();
}

test("demo: a student reports advice, the admin removes it, and the feed updates for everyone", async ({ page, browser }) => {
  await logIn(page, reporter.email);
  await report(page, text.rude, "It is insulting, harassing, or hateful", "It insults the TA.");
  await report(page, text.fine, "Something else");

  const adminPage = await browser.newPage();
  try {
    await logIn(adminPage, admin.email);
    await adminPage.goto("/admin/catalog");
    await adminPage.getByRole("link", { name: "Open advice reports" }).click();
    await expect(adminPage).toHaveURL(new RegExp(`${queue}$`));
    const item = queued(adminPage, text.rude);
    await expect(item).toContainText("By Anonymous student");
    await expect(item).toContainText("Offensive");
    await expect(item).toContainText("It insults the TA.");
    // The anonymous author stays anonymous for the admin too (the same author's named advice shows their name, as students
    // see it), and who reported is nowhere on the page; no user ID is either.
    await expect(item).not.toContainText(author.name);
    const html = await adminPage.content();
    for (const secret of [author.id, reporter.name, reporter.id]) expect(html).not.toContain(secret);

    await item.getByRole("button", { name: "Remove advice" }).click();
    await expect(adminPage).toHaveURL(new RegExp(`${queue}\\?removed=1$`));
    await expect(adminPage.getByRole("status").filter({ hasText: "The advice was removed." })).toBeVisible();
    await expect(queued(adminPage, text.rude)).toHaveCount(0);
  } finally {
    await adminPage.close();
  }

  // The feed no longer shows it, at once (the feed's cache was cleared).
  await page.goto(feed);
  await expect(post(page, text.fine)).toBeVisible();
  await expect(page.getByText(text.rude)).toHaveCount(0);
  expect((await page.goto(`${feed}/${ids.rude}/report`))?.status()).toBe(404);
  expect(await db.advice.findUniqueOrThrow({ where: { id: ids.rude } })).toMatchObject({ status: "REMOVED", removedById: admin.id });
  expect((await db.adviceReport.findMany({ where: { adviceId: ids.rude } })).map(entry => entry.status)).toEqual(["RESOLVED"]);
});

test("the admin keeps advice that breaks no rule: its reports are dismissed and it stays in the feed", async ({ page }) => {
  await logIn(page, admin.email);
  await page.goto(queue);
  await queued(page, text.fine).getByRole("button", { name: "Keep advice" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The advice was kept, and its reports are dismissed." })).toBeVisible();
  await expect(page.getByText("No advice is reported.")).toBeVisible();
  expect((await db.adviceReport.findMany({ where: { adviceId: ids.fine } })).map(entry => entry.status)).toEqual(["DISMISSED"]);
  await page.goto(feed);
  await expect(post(page, text.fine)).toBeVisible();
});

test("a student cannot open the queue, and a decision sent by a student with the real form changes nothing", async ({ page, browser }) => {
  await logIn(page, reporter.email);
  await report(page, text.fine, "It is advertising, or not about the course");
  expect((await page.goto(queue))?.status()).toBe(404);
  // The action's ID is the same for everyone, so take it from the admin's page and send it with the student's session.
  const adminPage = await browser.newPage();
  let actionId = "";
  try {
    await logIn(adminPage, admin.email);
    await adminPage.goto(queue);
    actionId = actionIdFor(await adminPage.content(), "Remove advice");
  } finally {
    await adminPage.close();
  }
  // Sent from the student's own page, as a form post with their session.
  const status = await page.evaluate(async ({ url, fields }) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    return (await fetch(url, { method: "POST", body: form, redirect: "manual" })).status;
  }, { url: queue, fields: { [actionId]: "", adviceId: ids.fine, decision: "remove", page: "1" } });
  expect(status).toBe(404);
  expect((await db.advice.findUniqueOrThrow({ where: { id: ids.fine } })).status).toBe("VISIBLE");
  expect(await db.adviceReport.findMany({ where: { adviceId: ids.fine, status: "OPEN" } })).toHaveLength(1);
});

test("a visitor is sent to log in", async ({ page }) => {
  await page.goto(queue);
  await expect(page).toHaveURL(/\/login\?next=/);
});

test("a second decision on the same advice, from a page opened before the first, changes nothing", async ({ page, browser }) => {
  await logIn(page, admin.email);
  await page.goto(queue);
  const second = await browser.newPage();
  try {
    await second.context().addCookies(await page.context().cookies());
    await second.goto(queue);
    await queued(second, text.fine).getByRole("button", { name: "Keep advice" }).click();
    await expect(second.getByRole("status").filter({ hasText: "kept" })).toBeVisible();
  } finally {
    await second.close();
  }
  await queued(page, text.fine).getByRole("button", { name: "Remove advice" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "no open reports" })).toBeVisible();
  expect((await db.advice.findUniqueOrThrow({ where: { id: ids.fine } })).status).toBe("VISIBLE");
});
