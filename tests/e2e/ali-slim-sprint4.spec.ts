import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { logInAsAdmin } from "./fixtures";
import { imageOnlyPdf, textPdf } from "../integration/fixtures/pdf";

const db = new PrismaClient();
const run = `s4e2e-${randomUUID().slice(0, 8)}`;
const password = "sprint4-test-password";
let faculty: string;
let courseId: string;
let fileId: string;
const students: Array<{ id: string; email: string }> = [];
const keys = new Set<string>();
const storage = (key: string) => path.resolve(process.env.FILE_STORAGE_ROOT || "public/uploads", key);
const login = async (page: Page, index = 0) => {
  await page.goto("/login"); await page.getByLabel("Email").fill(students[index].email); await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click(); await expect(page).toHaveURL(/\/my-courses$/);
};
test.beforeAll(async () => {
  faculty = (await db.faculty.create({ data: { code: run.toUpperCase(), name: "Sprint 4 browser faculty" } })).id;
  courseId = (await db.course.create({ data: { code: run.toUpperCase(), name: "Sprint 4 browser course", facultyId: faculty } })).id;
  const passwordHash = await bcrypt.hash(password, 10);
  for (const suffix of ["one", "two"]) students.push(await db.user.create({ data: { email: `${run}-${suffix}@test.invalid`, name: `Private ${suffix}`, passwordHash }, select: { id: true, email: true } }));
  const key = `exams/${run}.pdf`; keys.add(key); await mkdir(path.dirname(storage(key)), { recursive: true });
  const bytes = textPdf([["1. Explain TCP flow control.", "2. Compare TCP reliability and UDP delivery."]]); await writeFile(storage(key), bytes);
  fileId = (await db.courseFile.create({ data: { courseId, title: `Source ${run}`, category: "EXAM", topic: "TCP", originalFileName: "source.pdf", storageKey: key, mimeType: "application/pdf", sizeBytes: bytes.length, year: 2025 } })).id;
  for (const [index, text] of ["Explain TCP flow control.", "Compare TCP reliability and UDP delivery."].entries()) {
    const group = await db.questionGroup.create({ data: { courseId, text, normalizedText: `${run}-${index}`, rank: index + 1, paperCount: 1 } });
    await db.question.create({ data: { fileId, groupId: group.id, number: index + 1, text } });
  }
});
test.afterAll(async () => {
  const files = await db.courseFile.findMany({ where: { courseId }, select: { storageKey: true } }); files.forEach(file => keys.add(file.storageKey));
  await db.user.deleteMany({ where: { id: { in: students.map(student => student.id) } } });
  if (courseId) await db.course.deleteMany({ where: { id: courseId } });
  if (faculty) await db.faculty.deleteMany({ where: { id: faculty } });
  for (const key of keys) await unlink(storage(key)).catch(() => {});
  await db.$disconnect();
});

test("US-25/29: a real student outcome updates the profile and explains priority without leaking to another student", async ({ page }, testInfo) => {
  await login(page);
  await page.goto(`/courses/${courseId}/practice`);
  const question = page.locator("li.card").first();
  await question.getByRole("radio", { name: "Incorrect", exact: true }).check();
  await question.getByRole("button", { name: "Save practice outcome" }).click();
  await expect(page.getByRole("status")).toContainText("Practice outcome saved");
  await page.screenshot({ path: testInfo.outputPath("question-practice-light.png"), fullPage: true });
  const profile = await db.learningTopic.findUniqueOrThrow({ where: { userId_courseId_topicKey: { userId: students[0].id, courseId, topicKey: "tcp" } } });
  expect(profile.incorrectCount).toBe(1); expect(profile.weakness).toBeCloseTo(2 / 3);
  await page.goto(`/courses/${courseId}/exam?order=personal`);
  await page.getByText("Why this priority?", { exact: true }).first().click();
  await expect(page.getByText(/0 correct and 1 incorrect recorded outcomes/).first()).toBeVisible();
  await expect(page.getByText(/No saved confidence rating/).first()).toBeVisible();
  await page.getByRole("button", { name: "Log out" }).click();
  await login(page, 1); await page.goto(`/courses/${courseId}/practice`);
  await page.getByText("Why this priority?", { exact: true }).first().click();
  await expect(page.getByText(/No recorded performance evidence/).first()).toBeVisible();
  expect(await db.learningTopic.count({ where: { userId: students[1].id, courseId } })).toBe(0);
  await expect.poll(() => db.logEntry.count({ where: { event: "learning_evidence_saved", context: { path: ["userId"], equals: students[0].id } } })).toBeGreaterThan(0);
});

test("US-44: generate configured tasks, retain them after refresh, show provenance and keep libraries private", async ({ page }, testInfo) => {
  await login(page);
  await page.goto(`/courses/${courseId}/practice/generated`);
  await page.getByLabel("Topic", { exact: true }).selectOption("tcp"); await page.getByLabel("Number of questions").fill("2"); await page.getByLabel("Difficulty", { exact: true }).selectOption("HARD");
  await page.getByRole("button", { name: "Generate questions", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("New practice questions saved");
  await expect(page.locator("li.card")).toHaveCount(2);
  await expect(page.locator("li.card").first()).toContainText("hard");
  await expect(page.locator("li.card").first()).toContainText("No verified rubric available");
  await page.reload(); await expect(page.locator("li.card")).toHaveCount(2);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("generated-practice-mobile-dark.png"), fullPage: true });
  await expect.poll(() => db.logEntry.count({ where: { event: "practice_generation_completed", context: { path: ["userId"], equals: students[0].id } } })).toBeGreaterThan(0);
  const item = await db.generatedPracticeQuestion.findFirstOrThrow({ where: { userId: students[0].id, courseId } });
  expect(item.rubric).toBeNull();
  await page.getByRole("button", { name: "Log out" }).click(); await login(page, 1); await page.goto(`/courses/${courseId}/practice/generated`);
  await expect(page.locator("li.card")).toHaveCount(0);
});

test("US-73: students cannot mutate files; admin replacement and removal update the actual course", async ({ page }, testInfo) => {
  await login(page);
  const denied = await page.request.post(`/api/admin/files/${fileId}`, { form: { operation: "remove", confirm: "yes" } }); expect(denied.status()).toBe(403);
  const hidden = await page.goto(`/admin/files/${fileId}/manage`); expect(hidden?.status()).toBe(404);
  await page.getByRole("button", { name: "Log out" }).click(); await logInAsAdmin(page);
  await page.goto(`/admin/files/${fileId}/manage`);
  await page.getByLabel("Replacement file").setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from(imageOnlyPdf()) });
  await page.getByRole("button", { name: "Replace file", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("PDF exams must contain readable numbered questions");
  expect(await db.question.count({ where: { fileId } })).toBe(2);
  await page.getByLabel("Replacement file").setInputFiles({ name: "replacement.pdf", mimeType: "application/pdf", buffer: Buffer.from(textPdf([["1. Explain selective repeat retransmission."]])) });
  await page.getByRole("button", { name: "Replace file", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("File replaced");
  await page.screenshot({ path: testInfo.outputPath("admin-file-management.png"), fullPage: true });
  const current = await db.courseFile.findUniqueOrThrow({ where: { id: fileId } }); keys.add(current.storageKey);
  expect(await db.question.count({ where: { fileId } })).toBe(1);
  expect(await db.generatedPracticeQuestion.count({ where: { courseId } })).toBe(0);
  await page.goto(`/courses/${courseId}/exam`); await expect(page.getByText("Explain selective repeat retransmission.", { exact: true })).toBeVisible();
  await expect(page.getByText("Explain TCP flow control.", { exact: true })).toHaveCount(0);
  await page.goto(`/admin/files/${fileId}/manage`); await page.getByRole("checkbox").check(); await page.getByRole("button", { name: "Remove file", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/files\?/);
  await page.goto(`/courses/${courseId}/exam`); await expect(page.getByText(/No exam papers have been processed/)).toBeVisible();
  expect(await db.courseFile.findUnique({ where: { id: fileId } })).toBeNull();
  await expect.poll(() => db.logEntry.count({ where: { event: "file_management_completed", context: { path: ["fileId"], equals: fileId } } })).toBeGreaterThan(0);
});

test("practice pages require a session", async ({ page }) => {
  await page.goto(`/courses/${courseId}/practice`); await expect(page).toHaveURL(/\/login\?next=/);
});
