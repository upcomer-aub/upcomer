import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import { configureLogger } from "@/lib/logger";
import type { Mail } from "@/lib/mail";
import { RESET_SENT_MESSAGE, requestPasswordReset } from "@/lib/password-reset";
import "./fixtures";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-03. The spec makes one student with a stamped ID and deletes it at the end, which removes its links and sessions too.
// Links are made through requestPasswordReset with a capturing sender, since no mail provider runs in tests. It never counts
// rows beyond this student's own.
const stamp = String(Date.now()).slice(-8);
const oldPassword = "password123";
const newPassword = "new-password-456";
const student = { id: `qa-reset-${stamp}`, email: `qa-reset-${stamp}@mail.aub.edu`, name: `Reset Student ${stamp}` };
const unregistered = `qa-reset-nobody-${stamp}@mail.aub.edu`;
const db = new PrismaClient();
let firstLink = "";
let firstTokenHash = "";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  configureLogger({ persist: false });
  // The in-process service builds links from APP_URL; the server under test is on this origin.
  process.env.APP_URL = "http://127.0.0.1:3000";
  await db.user.create({ data: { ...student, passwordHash: await bcrypt.hash(oldPassword, 10) } });
});
test.afterAll(async () => {
  try {
    await db.user.deleteMany({ where: { id: student.id } });
  } finally {
    await db.$disconnect();
  }
});

// Asks for a link the way the forgot-password form does and returns the path it was sent with. Earlier links are moved
// out of the rate-limit window first, so the spec can make as many as it needs.
async function newLink() {
  await db.passwordResetToken.updateMany({ where: { userId: student.id }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });
  const sent: Mail[] = [];
  await requestPasswordReset(student.email, { send: async mail => { sent.push(mail); } });
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toBe(student.email);
  const url = new URL(sent[0].text.match(/https?:\/\/\S+/)![0]);
  return { path: `${url.pathname}${url.search}`, token: url.searchParams.get("token")! };
}

async function logIn(page: Page, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(student.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}

// Page notices only: a page-wide getByRole("alert") also matches Next's empty route announcer.
const notice = (page: Page) => page.locator("p.notice");
const sentNotice = (page: Page) => page.getByRole("status").filter({ hasText: "If an account exists" });

async function askForReset(page: Page, email: string) {
  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(sentNotice(page)).toHaveText(RESET_SENT_MESSAGE);
  return page.url();
}

test("a registered email gets a single-use link that expires (acceptance test 1)", async ({ page }) => {
  await askForReset(page, student.email);
  await expect(page).toHaveURL(/\/forgot-password\?sent=1$/);
  await expect.poll(() => db.passwordResetToken.count({ where: { userId: student.id } })).toBe(1);

  const startedAt = Date.now();
  const link = await newLink();
  firstLink = link.path;
  firstTokenHash = hash(link.token);
  expect(link.path).toMatch(/^\/reset-password\?token=[\w-]{43}$/);
  const row = await db.passwordResetToken.findUniqueOrThrow({ where: { tokenHash: firstTokenHash } });
  // Only the hash is stored, never the token itself.
  expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  expect(row.tokenHash).not.toContain(link.token);
  expect(row.usedAt).toBeNull();
  const minutesLeft = (row.expiresAt.getTime() - startedAt) / 60_000;
  expect(minutesLeft).toBeGreaterThan(29);
  expect(minutesLeft).toBeLessThanOrEqual(31);
});

test("a valid link sets a new password, the old one stops working, and old sessions end (acceptance test 2)", async ({ page, browser }) => {
  const other = await browser.newContext();
  try {
    const otherPage = await other.newPage();
    await logIn(otherPage, oldPassword);
    await expect(otherPage).toHaveURL(/\/my-courses$/);

    await page.goto(firstLink);
    await expect(page.getByRole("heading", { name: "Set a New Password" })).toBeVisible();
    // A mismatched confirmation is refused and leaves the link usable.
    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    await page.getByLabel("Confirm new password").fill(`${newPassword}-typo`);
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(notice(page)).toHaveText("The two passwords don't match.");
    expect(page.url()).not.toContain(newPassword);

    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    await page.getByLabel("Confirm new password").fill(newPassword);
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page).toHaveURL(/\/login\?reset=1$/);
    await expect(notice(page)).toHaveText("Your password was changed. Log in with your new password.");

    await logIn(page, oldPassword);
    await expect(notice(page)).toHaveText("Invalid email or password.");
    await logIn(page, newPassword);
    await expect(page).toHaveURL(/\/my-courses$/);

    // The session made before the reset was logged out.
    await otherPage.goto("/my-courses");
    await expect(otherPage).toHaveURL(/\/login\?next=/);
  } finally {
    await other.close();
  }
  expect((await db.passwordResetToken.findUniqueOrThrow({ where: { tokenHash: firstTokenHash } })).usedAt).toEqual(expect.any(Date));
});

test("an unregistered email gets the same neutral message (acceptance test 3)", async ({ page }) => {
  const registeredUrl = await askForReset(page, student.email);
  const registeredText = await sentNotice(page).textContent();
  const unregisteredUrl = await askForReset(page, unregistered);
  expect(unregisteredUrl).toBe(registeredUrl);
  expect(await sentNotice(page).textContent()).toBe(registeredText);
  expect(await db.user.findUnique({ where: { email: unregistered } })).toBeNull();
  expect(await db.passwordResetToken.count({ where: { user: { email: unregistered } } })).toBe(0);
});

test("used, expired, replaced, and made-up links are rejected (acceptance test 4)", async ({ page }) => {
  const rejected = async (path: string, message: string) => {
    await page.goto(path);
    await expect(notice(page)).toHaveText(message);
    await expect(page.getByLabel("New password", { exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Request a new link" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
  };

  await rejected(firstLink, "This reset link has already been used.");

  // A link opened in time but submitted after it expired is rejected too.
  const expiring = await newLink();
  await page.goto(expiring.path);
  await expect(page.getByRole("heading", { name: "Set a New Password" })).toBeVisible();
  await db.passwordResetToken.updateMany({ where: { userId: student.id, usedAt: null, invalidatedAt: null }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  await page.getByLabel("New password", { exact: true }).fill("another-password-789");
  await page.getByLabel("Confirm new password").fill("another-password-789");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(notice(page)).toHaveText("This reset link has expired or was replaced by a newer one.");
  await rejected(expiring.path, "This reset link has expired or was replaced by a newer one.");

  const older = await newLink();
  const newer = await newLink();
  await rejected(older.path, "This reset link has expired or was replaced by a newer one.");
  await page.goto(newer.path);
  await expect(page.getByRole("heading", { name: "Set a New Password" })).toBeVisible();

  await rejected("/reset-password?token=not-a-real-link", "This reset link isn't valid.");
  await rejected("/reset-password", "This reset link isn't valid.");

  // None of these changed the password.
  await logIn(page, newPassword);
  await expect(page).toHaveURL(/\/my-courses$/);
});
