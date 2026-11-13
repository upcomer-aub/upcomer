import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-36: an author edits and deletes their own advice from the course feed; nobody else can, not even with a forged form.
// The spec makes one course with advice by an author (one of it anonymous) and by another student. Deleting the course at
// the end deletes the advice.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-advch-${stamp}`;
const password = "password123";
const author = { id: `qa-advch-author-${stamp}`, email: `qa-advch-author-${stamp}@mail.aub.edu`, name: `Advice Author ${stamp}` };
const other = { id: `qa-advch-other-${stamp}`, email: `qa-advch-other-${stamp}@mail.aub.edu`, name: `Other Student ${stamp}` };
const busy = { id: `qa-advch-busy-${stamp}`, email: `qa-advch-busy-${stamp}@mail.aub.edu`, name: `Busy Editor ${stamp}` };
const ids = { edit: `qa-advch-edit-${stamp}`, remove: `qa-advch-remove-${stamp}`, anon: `qa-advch-anon-${stamp}`, theirs: `qa-advch-theirs-${stamp}`, busy: `qa-advch-busy-advice-${stamp}` };
const text = {
  edit: `Start with the course notes. ${stamp}`,
  remove: `This one will be deleted. ${stamp}`,
  anon: `Fall finals were long. ${stamp}`,
  theirs: `The other student's advice. ${stamp}`,
};
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: [author, other, busy].map(user => ({ ...user, passwordHash })) });
  await db.course.create({ data: { id: courseId, code: `QC${stamp}`, name: `Advice Changes ${stamp}`, facultyId: "faculty-eng" } });
  await db.advice.createMany({ data: [
    { id: ids.edit, courseId, authorId: author.id, body: text.edit, createdAt: minutesAgo(40) },
    { id: ids.remove, courseId, authorId: author.id, body: text.remove, createdAt: minutesAgo(30) },
    { id: ids.anon, courseId, authorId: author.id, anonymous: true, body: text.anon, createdAt: minutesAgo(20) },
    { id: ids.theirs, courseId, authorId: other.id, body: text.theirs, createdAt: minutesAgo(10) },
    { id: ids.busy, courseId, authorId: busy.id, body: `Busy advice. ${stamp}`, createdAt: minutesAgo(50) },
  ] });
});
test.afterAll(async () => {
  try {
    const userIds = [author, other, busy].map(user => user.id);
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
const editUrl = (adviceId: string) => `${feed}/${adviceId}/edit`;
async function logIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/my-courses$/);
}
const post = (page: Page, body: string) => page.getByRole("list", { name: "Advice from previous students" }).getByRole("article").filter({ hasText: body });
const notice = (page: Page, message: string) => page.getByRole("status").filter({ hasText: message });

test("only the author's own advice offers to edit or delete it", async ({ page }) => {
  await logIn(page, author.email);
  await page.goto(feed);
  for (const body of [text.edit, text.remove, text.anon]) {
    await expect(post(page, body)).toContainText("Your advice");
    await expect(post(page, body).getByRole("link", { name: "Edit or delete" })).toBeVisible();
  }
  await expect(post(page, text.theirs).getByRole("link", { name: "Edit or delete" })).toHaveCount(0);
  await expect(post(page, text.theirs)).not.toContainText("Your advice");
  await expect(post(page, text.anon)).toContainText("Others see you as Anonymous student.");
});

test("the author edits their advice, and every student sees the new text, marked edited", async ({ page, browser }) => {
  await logIn(page, author.email);
  await page.goto(feed);
  await post(page, text.edit).getByRole("link", { name: "Edit or delete" }).click();
  await expect(page).toHaveURL(new RegExp(`${editUrl(ids.edit)}$`));
  await expect(page.getByRole("heading", { name: "Edit your advice" })).toBeVisible();
  await expect(page.getByLabel("Your advice")).toHaveValue(text.edit);
  await page.getByLabel("Your advice").fill(`Start with the 2024 final.\nThen the notes. ${stamp}`);
  await page.getByLabel("Resource link (optional)").fill("https://example.com/final");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(new RegExp(`${feed}\\?edited=1$`));
  await expect(notice(page, "Your advice was updated.")).toBeVisible();
  const edited = post(page, `Then the notes. ${stamp}`);
  await expect(edited).toContainText("· edited");
  await expect(edited.getByRole("link", { name: "https://example.com/final" })).toBeVisible();

  const reader = await browser.newPage();
  try {
    await logIn(reader, other.email);
    await reader.goto(feed);
    await expect(post(reader, `Then the notes. ${stamp}`)).toContainText("· edited");
    await expect(reader.getByText(text.edit, { exact: true })).toHaveCount(0);
  } finally {
    await reader.close();
  }
});

test("saving without a change says so and does not mark the advice edited", async ({ page }) => {
  await logIn(page, author.email);
  await page.goto(editUrl(ids.remove));
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(notice(page, "Nothing was changed.")).toBeVisible();
  await expect(post(page, text.remove)).not.toContainText("edited");
});

test("an unsafe resource link is refused with a message, and nothing is saved", async ({ page }) => {
  await logIn(page, author.email);
  await page.goto(editUrl(ids.remove));
  await page.getByLabel("Your advice").fill(`Changed text. ${stamp}`);
  await page.getByLabel("Resource link (optional)").fill("http://example.com/notes");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(new RegExp(`${editUrl(ids.remove)}\\?error=invalid_resource$`));
  await expect(page.getByRole("alert").filter({ hasText: "https://" })).toHaveText("A resource link must be a full https:// address, or left empty.");
  expect((await db.advice.findUniqueOrThrow({ where: { id: ids.remove } })).body).toBe(text.remove);
});

test("the author deletes their advice, and it leaves the feed for everyone", async ({ page, browser }) => {
  await logIn(page, author.email);
  await page.goto(feed);
  await post(page, text.remove).getByRole("link", { name: "Edit or delete" }).click();
  await expect(page.getByText("Other students will no longer see it. This cannot be undone.")).toBeVisible();
  await page.getByRole("button", { name: "Delete advice" }).click();
  await expect(page).toHaveURL(new RegExp(`${feed}\\?deleted=1$`));
  await expect(notice(page, "Your advice was deleted. Other students no longer see it.")).toBeVisible();
  await expect(page.getByText(text.remove)).toHaveCount(0);
  // Its edit page is gone too.
  expect((await page.goto(editUrl(ids.remove)))?.status()).toBe(404);

  const reader = await browser.newPage();
  try {
    await logIn(reader, other.email);
    await reader.goto(feed);
    await expect(post(reader, text.theirs)).toBeVisible();
    await expect(reader.getByText(text.remove)).toHaveCount(0);
  } finally {
    await reader.close();
  }
});

test("the anonymous author edits their advice; it stays anonymous and their name is nowhere on another student's page", async ({ page, browser }) => {
  await logIn(page, author.email);
  await page.goto(editUrl(ids.anon));
  await expect(page.getByText("Other students see this advice as by Anonymous student.")).toBeVisible();
  await page.getByLabel("Your advice").fill(`Fall finals were long, bring water. ${stamp}`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(notice(page, "Your advice was updated.")).toBeVisible();

  const reader = await browser.newPage();
  try {
    await logIn(reader, other.email);
    await reader.goto(feed);
    const anonymous = post(reader, `bring water. ${stamp}`);
    await expect(anonymous).toContainText("By Anonymous student");
    await expect(anonymous).not.toContainText(author.name);
    await expect(anonymous.getByRole("link", { name: "Edit or delete" })).toHaveCount(0);
    expect(await reader.content()).not.toContain(author.id);
  } finally {
    await reader.close();
  }
});

test("another student cannot open the author's edit page, nor change the advice with a forged form", async ({ page }) => {
  await logIn(page, other.email);
  expect((await page.goto(editUrl(ids.anon)))?.status()).toBe(404);
  expect((await page.goto(editUrl(ids.edit)))?.status()).toBe(404);
  const before = await db.advice.findUniqueOrThrow({ where: { id: ids.anon } });

  // Their own edit form, pointed at the author's advice.
  await page.goto(editUrl(ids.theirs));
  await page.locator('form:has(button:text("Save changes")) input[name="adviceId"]').evaluate((input, target) => { (input as HTMLInputElement).value = target; }, ids.anon);
  await page.getByLabel("Your advice").fill(`Hijacked. ${stamp}`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(new RegExp(`${feed}\\?change_error=not_found$`));
  await expect(page.getByRole("alert").filter({ hasText: "isn't yours" })).toHaveText("That advice isn't yours to change, or it is no longer shown.");

  await page.goto(editUrl(ids.theirs));
  await page.locator('form:has(button:text("Delete advice")) input[name="adviceId"]').evaluate((input, target) => { (input as HTMLInputElement).value = target; }, ids.anon);
  await page.getByRole("button", { name: "Delete advice" }).click();
  await expect(page).toHaveURL(new RegExp(`${feed}\\?change_error=not_found$`));

  expect(await db.advice.findUniqueOrThrow({ where: { id: ids.anon } })).toEqual(before);
  expect((await db.advice.findUniqueOrThrow({ where: { id: ids.theirs } })).body).toBe(text.theirs);
});

test("a visitor is sent to log in and comes back to the edit page", async ({ page }) => {
  await page.goto(editUrl(ids.busy));
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel("Email").fill(busy.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(new RegExp(`${editUrl(ids.busy)}$`));
});

test("DoS: a student saving over and over is stopped after 20 changes a minute", async ({ page }) => {
  await logIn(page, busy.email);
  for (let save = 1; save <= 20; save++) {
    await page.goto(editUrl(ids.busy));
    await page.getByLabel("Your advice").fill(`Busy advice, version ${save}. ${stamp}`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(notice(page, "Your advice was updated.")).toBeVisible();
  }
  await page.goto(editUrl(ids.busy));
  await page.getByLabel("Your advice").fill(`One too many. ${stamp}`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Too many" })).toHaveText("Too many changes in a minute. Wait a moment and try again.");
  expect((await db.advice.findUniqueOrThrow({ where: { id: ids.busy } })).body).toBe(`Busy advice, version 20. ${stamp}`);
});
