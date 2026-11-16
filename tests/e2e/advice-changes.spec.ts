import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-36: a student edits or deletes their own advice. Tester's check: only the author can change their advice, and the
// feed shows the change at once. The spec makes one course, an author, another student, and three posts by the author
// (one anonymous). Deleting the course at the end deletes the advice.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-advch-${stamp}`;
const password = "password123";
const author = { id: `qa-advch-author-${stamp}`, email: `qa-advch-author-${stamp}@mail.aub.edu`, name: `Changing Author ${stamp}` };
const other = { id: `qa-advch-other-${stamp}`, email: `qa-advch-other-${stamp}@mail.aub.edu`, name: "Other Student" };
const ids = { edit: `qa-advch-edit-${stamp}`, anon: `qa-advch-anon-${stamp}`, remove: `qa-advch-remove-${stamp}` };
const feed = `/courses/${courseId}/advice`;

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: [author, other].map(user => ({ ...user, passwordHash })) });
  await db.course.create({ data: { id: courseId, code: `QC${stamp}`, name: `Changes Course ${stamp}`, facultyId: "faculty-eng" } });
  const base = { courseId, authorId: author.id, scopeKind: "COURSE" as const, scopeLabel: `QC${stamp}` };
  await db.advice.createMany({ data: [
    { ...base, id: ids.edit, title: `Edit me ${stamp}`, body: "Original text.", createdAt: new Date(Date.now() - 3000) },
    { ...base, id: ids.anon, title: `Anonymous ${stamp}`, body: "Anonymous text.", isAnonymous: true, createdAt: new Date(Date.now() - 2000) },
    { ...base, id: ids.remove, title: `Delete me ${stamp}`, body: "Soon gone.", createdAt: new Date(Date.now() - 1000) },
  ] });
});
test.afterAll(async () => {
  try {
    await db.$transaction([
      db.course.deleteMany({ where: { id: courseId } }),
      db.session.deleteMany({ where: { userId: { in: [author.id, other.id] } } }),
      db.user.deleteMany({ where: { id: { in: [author.id, other.id] } } }),
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
const post = (page: Page, id: string) => page.locator(`#advice-${id}`);
const status = (page: Page) => page.getByRole("main").getByRole("status");

test("the author edits their advice and the feed shows the new text at once, marked edited", async ({ page }) => {
  await logIn(page, author.email);
  await page.goto(feed);
  await expect(post(page, ids.edit)).toContainText("Original text.");
  await post(page, ids.edit).getByRole("link", { name: "Edit or delete your advice" }).click();
  await expect(page.getByRole("heading", { name: "Edit your advice" })).toBeVisible();
  await page.getByLabel("Title").fill(`Edited ${stamp}`);
  await page.getByLabel("Your advice").fill("New text.\nSecond line.");
  await page.getByLabel(/Helpful link/).fill("https://example.com/notes");
  await page.getByLabel("Link name (optional)").fill("Notes");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(new RegExp(`${feed}\\?edited=1$`));
  await expect(status(page)).toHaveText("Your advice was updated.");
  await expect(post(page, ids.edit)).toContainText(`Edited ${stamp}`);
  await expect(post(page, ids.edit)).toContainText("New text.");
  await expect(post(page, ids.edit)).toContainText("edited");
  await expect(post(page, ids.edit).getByRole("link", { name: "Notes" })).toHaveAttribute("href", "https://example.com/notes");
  await expect(page.getByText("Original text.")).toHaveCount(0);
});

test("saving unchanged advice changes nothing; an unsafe link is refused and keeps the advice", async ({ page }) => {
  await logIn(page, author.email);
  await page.goto(`${feed}/${ids.edit}/edit`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(status(page)).toHaveText("Nothing changed, so your advice was not updated.");
  await page.goto(`${feed}/${ids.edit}/edit`);
  // The browser's own check would stop javascript: in a url field, so the field type is removed first, as an attacker would.
  await page.getByLabel(/Helpful link/).evaluate(input => input.setAttribute("type", "text"));
  await page.getByLabel(/Helpful link/).fill("javascript:alert(1)");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Enter a full link that starts with https://");
  expect((await db.advice.findUniqueOrThrow({ where: { id: ids.edit } })).resourceUrl).toBe("https://example.com/notes");
});

test("anonymous advice stays anonymous after its author edits it", async ({ page }) => {
  await logIn(page, author.email);
  await page.goto(`${feed}/${ids.anon}/edit`);
  await expect(page.getByText("Other students see this advice as by Anonymous student.")).toBeVisible();
  await page.getByLabel("Your advice").fill("Anonymous text, edited.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(post(page, ids.anon)).toContainText("Anonymous student");
  await expect(post(page, ids.anon)).not.toContainText(author.name);
});

test("another student sees no edit link, and the edit page is not found for them", async ({ page }) => {
  await logIn(page, other.email);
  await page.goto(feed);
  await expect(post(page, ids.edit)).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit or delete your advice" })).toHaveCount(0);
  const response = await page.goto(`${feed}/${ids.edit}/edit`);
  expect(response?.status()).toBe(404);
  expect(await page.content()).not.toContain("New text.");
});

test("a visitor opening the edit page is sent to log in", async ({ page }) => {
  await page.goto(`${feed}/${ids.edit}/edit`);
  await expect(page).toHaveURL(/\/login\?next=/);
});

test("the author deletes their advice: it leaves the feed at once, and the edit page is gone", async ({ page }) => {
  await logIn(page, author.email);
  await page.goto(`${feed}/${ids.remove}/edit`);
  await page.getByRole("button", { name: "Delete advice" }).click();
  await expect(page).toHaveURL(new RegExp(`${feed}\\?deleted=1$`));
  await expect(status(page)).toHaveText("Your advice was deleted. Other students no longer see it.");
  await expect(page.getByText(`Delete me ${stamp}`)).toHaveCount(0);
  const response = await page.goto(`${feed}/${ids.remove}/edit`);
  expect(response?.status()).toBe(404);
  // Kept for moderation (US-43/US-77), marked removed by its author.
  expect(await db.advice.findUniqueOrThrow({ where: { id: ids.remove } })).toMatchObject({ status: "REMOVED", removedById: author.id });
});
