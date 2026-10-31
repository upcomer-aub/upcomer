import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { corruptPdf, imageOnlyPdf, textPdf } from "../integration/fixtures/pdf";
import { createRng } from "../reliability/rng";
import { logInAsAdmin } from "./fixtures";

// Sprint 3: 50 repeatable trials per owned feature against Playwright's production server.
// A failed extraction is a correct outcome for unreadable or scanned input, not a failed reliability trial.
const db = new PrismaClient();
const stamp = `slim-rel-${Date.now().toString(36)}`;
const courseId = `${stamp}-course`;
const root = path.resolve(process.env.FILE_STORAGE_ROOT || "public/uploads");
const fileIds: string[] = [];
test.describe.configure({ mode: "serial", timeout: 180_000 });

test.beforeAll(async () => {
  await db.course.create({ data: { id: courseId, code: `SR${Date.now().toString(36)}`.toUpperCase(), name: "Processing reliability", facultyId: "faculty-eng" } });
});
test.afterAll(async () => {
  try {
    const files = await db.courseFile.findMany({ where: { courseId }, select: { storageKey: true } });
    for (const file of files) {
      if (/^exams\/[^/\\]+$/.test(file.storageKey)) await unlink(path.join(root, file.storageKey)).catch(() => undefined);
    }
    await db.course.deleteMany({ where: { id: courseId } });
    await db.logEntry.deleteMany({ where: { OR: [
      { context: { path: ["courseId"], equals: courseId } },
      ...fileIds.map(fileId => ({ context: { path: ["fileId"], equals: fileId } })),
    ] } });
  } finally { await db.$disconnect(); }
});

async function upload(page: Page, bytes: Uint8Array, title: string) {
  // Use the authenticated browser: production's Secure cookie works on Chromium's loopback origin, whereas
  // Playwright's separate API client does not send Secure cookies over this HTTP test address.
  const response = await page.evaluate(async input => {
    const form = new FormData();
    form.set("category", "EXAM");
    form.set("courseId", input.courseId);
    form.set("title", input.title);
    form.set("file", new File([new Uint8Array(input.bytes)], "exam.pdf", { type: "application/pdf" }));
    const result = await fetch("/api/admin/uploads", { method: "POST", body: form });
    return { status: result.status, body: await result.json() };
  }, { bytes: Array.from(bytes), title, courseId });
  expect(response.status).toBe(201);
  const { file } = response.body;
  fileIds.push(file.id);
  return db.courseFile.findUniqueOrThrow({ where: { id: file.id } });
}

const latest = (fileId: string) => db.fileProcessingRun.findFirstOrThrow({ where: { fileId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });

test("US-14: 50 randomized typed, scanned, blank, corrupt and unnumbered PDF trials", async ({ page }) => {
  await logInAsAdmin(page);
  const rng = createRng(271003);
  const counts: Record<string, number> = {};
  for (let trial = 0; trial < 50; trial++) {
    const kind = rng.pick(["typed", "typed", "scan", "blank", "corrupt", "unnumbered"]);
    counts[kind] = (counts[kind] ?? 0) + 1;
    const number = rng.int(1, 12);
    const questions = Array.from({ length: number }, (_, i) => `${i + 1}${rng.pick([". ", ")", ": "])}Explain networking topic number ${i + 1}.`);
    const bytes = kind === "typed" ? textPdf([questions]) : kind === "scan" ? imageOnlyPdf()
      : kind === "blank" ? textPdf([[]]) : kind === "corrupt" ? corruptPdf() : textPdf([["Read the course handbook."]]);
    const file = await upload(page, bytes, `${stamp} extraction ${trial}`);
    const run = await latest(file.id);
    const stored = await db.question.findMany({ where: { fileId: file.id }, orderBy: { number: "asc" } });
    if (kind === "typed") {
      expect(run.status).toBe("SUCCEEDED");
      expect(stored.map(q => q.text)).toEqual(questions);
    } else {
      expect(run).toMatchObject({ status: "FAILED", stage: "EXTRACTION", reason: kind === "corrupt" ? "unreadable_pdf" : kind === "unnumbered" ? "no_questions" : "no_text" });
      expect(stored).toHaveLength(0);
    }
  }
  console.log(`US14_RELIABILITY seed=271003 passed=50/50 cases=${JSON.stringify(counts)}`);
});

test("US-76: 50 randomized retry outcomes through the admin processing page", async ({ page }) => {
  await logInAsAdmin(page);
  const rng = createRng(271076);
  const counts: Record<string, number> = {};
  for (let trial = 0; trial < 50; trial++) {
    const kind = rng.pick(["fixed", "fixed", "scan", "missing", "corrupt", "unnumbered"]);
    counts[kind] = (counts[kind] ?? 0) + 1;
    const title = `${stamp} retry ${trial}`;
    const file = await upload(page, imageOnlyPdf(), title);
    const storedPath = path.join(root, file.storageKey);
    if (kind === "missing") await unlink(storedPath);
    else if (kind !== "scan") await writeFile(storedPath, kind === "fixed" ? textPdf([["1. Define latency.", "2. Explain ARP."]]) : kind === "corrupt" ? corruptPdf() : textPdf([["Instructions without questions."]]));
    await page.goto("/admin/processing");
    const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
    await expect(card).toContainText("Status: Failed");
    await card.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/processing\?retried=1$/);
    await expect(card).toContainText(kind === "fixed" ? "Status: Completed" : "Status: Failed");
    const run = await latest(file.id);
    expect(await db.fileProcessingRun.count({ where: { fileId: file.id } })).toBe(2);
    if (kind === "fixed") {
      expect(run.status).toBe("SUCCEEDED");
      await expect(card.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
      expect(await db.question.count({ where: { fileId: file.id } })).toBe(2);
    } else {
      expect(run).toMatchObject({ status: "FAILED", stage: "EXTRACTION", reason: kind === "missing" ? "missing_file" : kind === "corrupt" ? "unreadable_pdf" : kind === "unnumbered" ? "no_questions" : "no_text" });
      await expect(card.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    }
  }
  await expect.poll(() => db.logEntry.count({ where: { event: "exam_processing_started", context: { path: ["courseId"], equals: courseId } } })).toBeGreaterThan(0);
  await expect.poll(() => db.logEntry.count({ where: { event: "exam_processing_completed", context: { path: ["retry"], equals: "true" }, AND: { context: { path: ["courseId"], equals: courseId } } } })).toBeGreaterThan(0);
  await expect.poll(() => db.logEntry.count({ where: { event: "exam_processing_failed", context: { path: ["retry"], equals: "true" }, AND: { context: { path: ["courseId"], equals: courseId } } } })).toBeGreaterThan(0);
  console.log(`US76_RELIABILITY seed=271076 passed=50/50 cases=${JSON.stringify(counts)}`);
});
