import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

// Sprint 1 Critical End-to-End Journey: one new student, one browser session, every stage in order.
// This is the integrated verification that the features of all five members work together.

const expect = baseExpect.configure({ timeout: 15_000 });
const email = `student-${Date.now()}-journey@mail.aub.edu`;
const password = "password123";

// Delete the journey's student with their sessions and My Courses entries.
test.afterAll(async () => {
  const db = new PrismaClient();
  try {
    const student = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (student) {
      await db.$transaction([
        db.session.deleteMany({ where: { userId: student.id } }),
        db.userCourse.deleteMany({ where: { userId: student.id } }),
        db.user.delete({ where: { id: student.id } }),
      ]);
    }
  } finally {
    await db.$disconnect();
  }
});

// Follows an "Open Original File" link the way the browser would, with the student's session, and checks it is the PDF.
async function openOriginalFile(page: Page, title: string) {
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  const link = card.getByRole("link", { name: "Open Original File" });
  await expect(link).toHaveAttribute("target", "_blank");
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^\/files\/[^/]+$/);
  const file = await page.request.get(href!);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toBe("application/pdf");
  expect(file.headers()["content-disposition"]).toMatch(/^inline;/);
  expect((await file.body()).subarray(0, 5).toString()).toBe("%PDF-");
}

test("a new student completes the Sprint 1 critical journey", async ({ page }) => {
  test.slow();

  await test.step("Create account", async () => {
    await page.goto("/signup");
    await page.getByLabel("Name").fill("Journey Student");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/login\?registered=1$/);
    await expect(page.getByText("Account created. Log in to continue.")).toBeVisible();
  });

  await test.step("Log in", async () => {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/my-courses$/);
    await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
    await expect(page.getByText("You haven't added any courses yet.")).toBeVisible();
  });

  await test.step("Browse courses", async () => {
    await page.getByRole("main").getByRole("link", { name: "Browse Courses" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Browse Courses" })).toBeVisible();
    // The catalog is paged in code order, so EECE350 need not be on the first page; the search step finds it.
    await expect(page.locator("article").first()).toBeVisible();
  });

  await test.step('Search for "eece 350"', async () => {
    await page.getByLabel("Search courses").fill("eece 350");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/[?&]q=eece\+350/);
    const result = page.locator("article").first();
    await expect(result).toContainText("EECE350");
    await expect(result).toContainText("Computer Networks");
  });

  await test.step("Add EECE350 to My Courses", async () => {
    await page.locator("article").filter({ has: page.getByText("EECE350", { exact: true }) }).getByRole("link", { name: "Open Course" }).click();
    await expect(page).toHaveURL(/\/courses\/course-eece350$/);
    await page.getByRole("button", { name: "Add to My Courses" }).click();
    await expect(page).toHaveURL(/\/courses\/course-eece350\?added=1$/);
    await expect(page.getByText("Added to My Courses.")).toBeVisible();
  });

  await test.step("Confirm it shows on My Courses", async () => {
    await page.getByRole("link", { name: "My Courses" }).first().click();
    await expect(page).toHaveURL(/\/my-courses$/);
    await expect(page.locator("article").filter({ has: page.getByText("EECE350", { exact: true }) })).toHaveCount(1);
  });

  await test.step("Open the course", async () => {
    await page.locator("article").filter({ has: page.getByText("EECE350", { exact: true }) }).getByRole("link", { name: "Open Course" }).click();
    await expect(page).toHaveURL(/\/courses\/course-eece350$/);
    await expect(page.getByRole("heading", { name: "Computer Networks", exact: true })).toBeVisible();
  });

  await test.step("Browse its exams", async () => {
    await page.getByRole("link", { name: "Browse Previous Exams" }).click();
    await expect(page).toHaveURL(/\/courses\/course-eece350\/exams$/);
    await expect(page.getByRole("heading", { name: "Previous Exams" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Final Exam 2025", exact: true })).toBeVisible();
    // Another course's exam never appears here.
    await expect(page.getByRole("heading", { name: "Data Structures Final 2025", exact: true })).toHaveCount(0);
  });

  await test.step("Open an exam's original file", async () => {
    await openOriginalFile(page, "Final Exam 2025");
  });

  await test.step("Back to the course", async () => {
    await page.getByRole("link", { name: /Back to EECE350/ }).click();
    await expect(page).toHaveURL(/\/courses\/course-eece350$/);
  });

  await test.step("Browse its materials", async () => {
    await page.getByRole("link", { name: "Browse Course Materials" }).click();
    await expect(page).toHaveURL(/\/courses\/course-eece350\/materials$/);
    await expect(page.getByRole("heading", { name: "Course Materials" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Network Models Lecture", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Trees and Graphs Notes", exact: true })).toHaveCount(0);
  });

  await test.step("Open a material's original file", async () => {
    await openOriginalFile(page, "Network Models Lecture");
  });

  await test.step("Log out", async () => {
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
    // The session really ended: My Courses now asks for a login.
    await page.goto("/my-courses");
    await expect(page).toHaveURL("/login?next=%2Fmy-courses");
  });
});
