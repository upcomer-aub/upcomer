import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { imageOnlyPdf } from "../integration/fixtures/pdf";
import { linesPdf } from "../integration/fixtures/layout-pdf";
import { logInAsAdmin } from "./fixtures";

const expect = baseExpect.configure({ timeout: 15_000 });

// M4 cross-test of M5's US-14 and US-76 through the browser: upload through the admin form, read the result on
// /admin/processing, fix the file, retry, and see the questions on the course's ordered exam. Everything is in a
// throwaway course, deleted at the end with its stored files.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-proc-course-${stamp}`;
const titles = { scan: `Scanned Final ${stamp}`, typed: `Typed Midterm ${stamp}` };
const student = { id: `qa-proc-student-${stamp}`, email: `qa-proc-${stamp}@mail.aub.edu`, password: "processing-pass-1" };
const root = path.resolve(process.env.FILE_STORAGE_ROOT || "public/uploads");
const db = new PrismaClient();

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  await db.course.create({ data: { id: courseId, code: `PR${stamp}`, name: `Processing Course ${stamp}`, facultyId: "faculty-eng" } });
  await db.user.create({ data: { id: student.id, email: student.email, name: "Processing Student", passwordHash: await bcrypt.hash(student.password, 10) } });
});
test.afterAll(async () => {
  try {
    const files = await db.courseFile.findMany({ where: { courseId }, select: { storageKey: true } });
    for (const { storageKey } of files) {
      // Only ever delete upload copies, never the committed fixtures next to them.
      if (/^(exams|materials)\/[^/\\]+$/.test(storageKey)) await unlink(path.join(root, storageKey)).catch(() => undefined);
    }
    await db.course.deleteMany({ where: { id: courseId } });
    await db.session.deleteMany({ where: { userId: student.id } });
    await db.user.deleteMany({ where: { id: student.id } });
  } finally {
    await db.$disconnect();
  }
});

async function uploadExam(page: Page, title: string, name: string, bytes: Uint8Array) {
  await page.goto("/admin/uploads");
  await page.getByRole("link", { name: "Upload Previous Exam" }).click();
  await page.getByLabel("Course").selectOption(courseId);
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("File").setInputFiles({ name, mimeType: "application/pdf", buffer: Buffer.from(bytes) });
  await page.getByRole("button", { name: "Upload exam" }).click();
  await expect(page.getByRole("status")).toContainText(`Uploaded “${title}”`);
}
const card = (page: Page, title: string) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

test("an image-only exam shows as failed at text extraction with \"No extractable text\" and a Retry button", async ({ page }) => {
  await logInAsAdmin(page);
  await uploadExam(page, titles.scan, "scan.pdf", imageOnlyPdf());
  await page.getByRole("link", { name: "Check exam processing status" }).click();
  await expect(page).toHaveURL(/\/admin\/processing$/);
  const scan = card(page, titles.scan);
  await expect(scan).toContainText("Status: Failed");
  await expect(scan).toContainText("Stage: Text extraction");
  await expect(scan).toContainText("Reason: No extractable text was found in this PDF.");
  await expect(scan.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("a typed exam shows as completed, without a Retry button, and its questions reach the ordered exam", async ({ page }) => {
  await logInAsAdmin(page);
  await uploadExam(page, titles.typed, "typed.pdf", linesPdf([["Midterm", "1. Define latency.", "2. Define jitter.", "3. Define throughput."]]));
  await page.goto("/admin/processing");
  await expect(card(page, titles.typed)).toContainText("Status: Completed");
  await expect(card(page, titles.typed).getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.goto(`/courses/${courseId}/exam`);
  for (const text of ["Define latency.", "Define jitter.", "Define throughput."]) await expect(page.getByText(text, { exact: true })).toBeVisible();
});

test("after the file is fixed, Retry processes it and its questions reach the ordered exam", async ({ page }) => {
  const file = await db.courseFile.findFirstOrThrow({ where: { courseId, title: titles.scan } });
  // The admin replaces the scan with a typed copy.
  await writeFile(path.join(root, file.storageKey), Buffer.from(linesPdf([["Final", "1. Define latency.", "2. Explain ARP."]])));
  await logInAsAdmin(page);
  await page.goto("/admin/processing");
  await card(page, titles.scan).getByRole("button", { name: "Retry" }).click();
  await expect(page).toHaveURL(/\/admin\/processing\?retried=1$/);
  await expect(page.getByText("Processing was retried.")).toBeVisible();
  await expect(card(page, titles.scan)).toContainText("Status: Completed");
  expect((await db.fileProcessingRun.findMany({ where: { fileId: file.id }, orderBy: { createdAt: "asc" } })).map(run => run.status)).toEqual(["FAILED", "SUCCEEDED"]);

  await page.goto(`/courses/${courseId}/exam`);
  await expect(page.getByText("Explain ARP.", { exact: true })).toBeVisible();
  // "Define latency." is now in both papers.
  await expect(page.getByText("2 of 2 papers").first()).toBeVisible();
});

test("students and visitors cannot see the processing page or retry", async ({ page }) => {
  await page.goto("/admin/processing");
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fprocessing$/);

  await page.goto("/login");
  await page.getByLabel("Email").fill(student.email);
  await page.getByLabel("Password").fill(student.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/my-courses$/);
  await page.goto("/admin/processing");
  await expect(page.getByRole("heading", { name: "Exam processing" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
});
