import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { normalizeQuestionText } from "../../lib/question-grouping";
import { createRng } from "../reliability/rng";
import { logInAsAdmin } from "./fixtures";

const expect = baseExpect.configure({ timeout: 15_000 });

// Edge cases of the Upcomer Exam on the real database: unusual course IDs, IDs that contain LIKE wildcards, unsafe text,
// very long text, and random courses whose papers move, change category, or are deleted without a regroup. Every count is
// checked against a reference computed straight from the database. All courses are made here and deleted at the end.
const stamp = String(Date.now()).slice(-8);
const seed = Number(process.env.EXAM_E2E_SEED) || Date.now() % 1_000_000;
const underscoreId = `qa-w_${stamp}`;
const lookalikeId = `qa-wX${stamp}`;
const percentId = `qa-p%${stamp}`;
const unsafeId = `qa-unsafe-${stamp}`;
const otherId = `qa-exfz-other-${stamp}`;
const fuzzIds = [0, 1, 2].map(round => `qa-exfz-${stamp}-${round}`);
const allIds = [underscoreId, lookalikeId, percentId, unsafeId, otherId, ...fuzzIds];

const paper = (courseId: string, suffix: string | number, fields: Partial<{ year: number | null; category: "EXAM" | "MATERIAL"; examType: "FINAL" | "MIDTERM" | null; termId: string | null; title: string }> = {}) => ({
  id: `${courseId}-${suffix}`, courseId, title: `Exam ${suffix} ${stamp}`, year: 2024, examType: "FINAL" as const, termId: "term-fall", professorId: "prof-a",
  category: "EXAM" as const, originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf", ...fields,
});

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  await db.course.createMany({ data: allIds.map((id, index) => ({ id, code: `UE${stamp}${index}`, name: `Exam Edge Course ${index} ${stamp}`, facultyId: "faculty-eng" })) });
  // The underscore course has one paper; its lookalike, which "_" would match as a LIKE wildcard, has two.
  await db.courseFile.createMany({ data: [paper(underscoreId, 1), paper(lookalikeId, 1), paper(lookalikeId, 2), paper(percentId, 1)] });
  await db.question.createMany({ data: [
    { fileId: `${underscoreId}-1`, number: 1, text: "Define a socket." },
    { fileId: `${underscoreId}-1`, number: 2, text: "What does 100% mean in a_b?" },
    { fileId: `${lookalikeId}-1`, number: 1, text: "Define a socket." },
    { fileId: `${lookalikeId}-2`, number: 1, text: "Define a socket." },
    { fileId: `${percentId}-1`, number: 1, text: "What does 100% mean in a_b?" },
  ] });
});
test.afterAll(async () => {
  try {
    await db.course.deleteMany({ where: { id: { in: allIds } } });
  } finally {
    await db.$disconnect();
  }
});

const codeOf = (id: string) => `UE${stamp}${allIds.indexOf(id)}`;
async function regroup(page: Page, courseId: string) {
  await page.goto("/admin/questions");
  await page.getByRole("button", { name: `Regroup and rank ${codeOf(courseId)}`, exact: true }).click();
  // A course left with no questions drops off the admin list and gets no message, so the redirect is the success signal.
  await page.waitForURL(url => url.searchParams.get("rebuilt") === courseId);
}
const examUrl = (courseId: string) => `/courses/${encodeURIComponent(courseId)}/exam`;

test("unusual and hostile course IDs give a not found page, never an error or another course", async ({ page }) => {
  const ids = [
    "%", "%%", "_", "*", ".*", "qa-%", `qa-w%${stamp}`, `qa-w_${stamp}`.toUpperCase(), "' OR '1'='1", "course-eece350 ", " course-eece350",
    "course-eece350\u0000", "\u0000", "../course-eece350", "course-eece350/..", "курс", "🤔", "a".repeat(3000), "null", "undefined", "[object Object]",
  ];
  for (const id of ids) {
    const response = await page.request.get(examUrl(id));
    expect(response.status(), `course ID ${JSON.stringify(id.slice(0, 40))}`).toBe(404);
    expect(await response.text()).not.toContain("distinct question");
  }
  // Broken percent-encoding is refused by Next.js before it reaches the page.
  for (const raw of ["%ZZ", "%E0%A4%A"]) expect((await page.request.get(`/courses/${raw}/exam`)).status()).toBe(400);
});

test("course IDs containing % and _ match only themselves, never as wildcards", async ({ page }) => {
  await logInAsAdmin(page);
  for (const id of [underscoreId, lookalikeId, percentId]) await regroup(page, id);

  await page.goto(examUrl(underscoreId));
  await expect(page.getByText("2 distinct questions from 1 previous exam,")).toBeVisible();
  await expect(page.locator("li[data-tier] > p.muted")).toHaveText(["Appeared in 1 of 1 paper", "Appeared in 1 of 1 paper"]);
  await expect(page.locator("li[data-tier] > p").filter({ hasText: "100%" })).toHaveText("What does 100% mean in a_b?");
  for (const link of await page.locator("li[data-tier] a").all()) await expect(link).toHaveAttribute("href", `/files/${encodeURIComponent(`${underscoreId}-1`)}`);

  await page.goto(examUrl(lookalikeId));
  await expect(page.locator("li[data-tier] > p.muted")).toHaveText(["Appeared in 2 of 2 papers"]);

  // Next.js passes a route parameter to the page still percent-encoded, so no course page can open an ID that needs encoding
  // (generated IDs never do). The exam behaves like the course home page: not found, never another course.
  const home = await page.request.get(`/courses/${encodeURIComponent(percentId)}`);
  const exam = await page.request.get(examUrl(percentId));
  expect([home.status(), exam.status()]).toEqual([404, 404]);
});

test("question text and paper titles are shown as text, never run as HTML", async ({ page }) => {
  await db.courseFile.create({ data: paper(unsafeId, 1, { title: `<script>window.__xss = 3</script><b>Final</b>` }) });
  await db.question.createMany({ data: [
    { fileId: `${unsafeId}-1`, number: 1, text: `<img src=x onerror="window.__xss = 1">Explain <b>this</b><script>window.__xss = 2</script>` },
    { fileId: `${unsafeId}-1`, number: 2, text: `Explain ${"a".repeat(400)} at length.\n(a) ${"b".repeat(300)}` },
  ] });
  await logInAsAdmin(page);
  await regroup(page, unsafeId);
  let dialog = false;
  page.on("dialog", async prompt => { dialog = true; await prompt.dismiss(); });
  await page.goto(`${examUrl(unsafeId)}?q=%25&year=2024&examType=FINAL&termId=_`);
  await expect(page.locator("li[data-tier]")).toHaveCount(2);
  await expect(page.locator("li[data-tier] > p").filter({ hasText: "<img src=x" })).toHaveText(`<img src=x onerror="window.__xss = 1">Explain <b>this</b><script>window.__xss = 2</script>`);
  await page.locator("li[data-tier] summary").first().click();
  await expect(page.getByRole("link", { name: "<script>window.__xss = 3</script><b>Final</b>" }).first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await expect(page.locator("li[data-tier] img, li[data-tier] b, li[data-tier] script")).toHaveCount(0);
  expect(dialog).toBe(false);

  // A very long word wraps instead of widening the exam on a phone. Only the exam content inside <main> is measured: the shared
  // header is within a few pixels of 375px and its width depends on how the platform renders fonts.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.reload();
  await expect(page.locator("li[data-tier]")).toHaveCount(2);
  const tooWide = await page.locator("main").evaluate(main => {
    const right = main.getBoundingClientRect().right - parseFloat(getComputedStyle(main).paddingRight) + 1;
    const elements = [...main.querySelectorAll("li[data-tier]")].flatMap(card => [card, ...card.querySelectorAll("*")]);
    const wide = elements.filter(element => element.getBoundingClientRect().right > right)
      .map(element => `${element.tagName.toLowerCase()}.${element.className || "(no class)"} ${Math.round(element.getBoundingClientRect().width)}px`);
    if (main.scrollWidth > main.clientWidth + 1) wide.push(`main scrolls: ${main.scrollWidth}px > ${main.clientWidth}px`);
    return wide;
  });
  expect(tooWide, "elements wider than the exam content at 375px").toEqual([]);
});

// The reference: Y is the course's exam papers with at least one non-excluded source entry; each stored group, in rank order, shows once with
// X = its distinct papers among those, and is left out when it has none. Tiers by the share rule, the note under 5 papers.
async function expected(courseId: string) {
  const papers = new Set((await db.courseFile.findMany({ where: { courseId, category: "EXAM", questions: { some: { excludedFromBank: false } } }, select: { id: true } })).map(item => item.id));
  const groups = await db.questionGroup.findMany({ where: { courseId, questions: { some: { excludedFromBank: false } } }, orderBy: { rank: "asc" }, include: { questions: { where: { excludedFromBank: false }, select: { fileId: true } } } });
  const questions = groups
    .map(group => ({ key: group.normalizedText, papers: [...new Set(group.questions.map(item => item.fileId).filter(id => papers.has(id)))].sort() }))
    .filter(item => item.papers.length)
    .map(item => ({ ...item, tier: item.papers.length * 2 >= papers.size ? "VERY_LIKELY" : item.papers.length * 4 >= papers.size ? "LIKELY" : "RARE" }));
  return { total: papers.size, questions };
}

async function shown(page: Page) {
  return page.locator("li[data-tier]").evaluateAll(items => items.map(item => ({
    text: (item.querySelector(":scope > p") as HTMLElement).innerText,
    evidence: (item.querySelector(":scope > p.muted") as HTMLElement).textContent,
    tier: item.getAttribute("data-tier"),
    papers: [...item.querySelectorAll("ul a")].map(link => decodeURIComponent(link.getAttribute("href")!.replace("/files/", ""))).sort(),
  })));
}

async function compare(page: Page, courseId: string, context: string) {
  const reference = await expected(courseId);
  await page.goto(examUrl(courseId));
  const items = await shown(page);
  if (reference.total === 0) await expect(page.getByText("No exam papers have been processed for this course yet."), context).toBeVisible();
  else if (!reference.questions.length) await expect(page.getByText("still being prepared"), context).toBeVisible();
  else await expect(page.getByText(`${reference.questions.length} distinct question`), context).toBeVisible();
  await expect(page.getByRole("note"), context).toHaveCount(reference.total > 0 && reference.total < 5 && reference.questions.length ? 1 : 0);
  expect(items.length, context).toBe(reference.questions.length);
  items.forEach((item, index) => {
    const want = reference.questions[index];
    expect(normalizeQuestionText(item.text), `${context}, question ${index + 1}`).toBe(want.key);
    expect(item.evidence, `${context}, question ${index + 1}`).toBe(`Appeared in ${want.papers.length} of ${reference.total} ${reference.total === 1 ? "paper" : "papers"}`);
    expect(item.tier, `${context}, question ${index + 1}`).toBe(want.tier);
    expect(item.papers, `${context}, question ${index + 1}`).toEqual(want.papers);
  });
}

const BASE = [
  "Explain the TCP three-way handshake.", "Define a socket.", "What is NAT?", "Explain the UDP header.", "Compute the subnet mask of a /26 network.",
  "Consider the network below.\n(a) Find the subnet mask.\n(b) How many hosts fit?", "What does ARP do?", "What does 100% of a_b mean?",
];

// The title stays fixed: each Playwright worker loads this file at a different time, so a seed taken from the clock must not
// be part of it. The seed is in the report's annotations and in every failure message; EXAM_E2E_SEED repeats a run.
test("random courses match the database reference before and after papers move, change, or are deleted", async ({ page }) => {
  test.info().annotations.push({ type: "seed", description: String(seed) });
  test.setTimeout(240_000);
  const rng = createRng(seed);
  await db.courseFile.create({ data: paper(otherId, "x", { year: 2020 }) });
  await logInAsAdmin(page);
  for (const [round, courseId] of fuzzIds.entries()) {
    const context = `seed ${seed}, round ${round}`;
    const papers = Array.from({ length: rng.int(1, 9) }, (_, index) => paper(courseId, index, {
      year: rng.chance(0.15) ? null : rng.int(2015, 2026), examType: rng.pick(["FINAL", "MIDTERM", null] as const),
      termId: rng.pick(["term-fall", "term-spring", null]), category: index > 0 && rng.chance(0.15) ? "MATERIAL" : "EXAM",
    }));
    await db.courseFile.createMany({ data: papers });
    for (const [paperIndex, item] of papers.entries()) {
      // Variants the grouping treats as the same question: case, spacing, numbering, marks, end punctuation. Some papers
      // also hold a question that is only a number, which belongs to no group. The first paper always has a real question,
      // so the course is listed on the admin page.
      const picked = rng.subset(BASE).slice(0, rng.int(0, 5));
      if (paperIndex === 0 && !picked.length) picked.push(rng.pick(BASE));
      const texts = picked.map((text, index) => {
        let variant = rng.chance(0.3) ? rng.mixCase(text) : text;
        if (rng.chance(0.3)) variant = variant.replace(/ /g, "  ");
        if (rng.chance(0.3)) variant = `Q${index + 1}. ${variant}`;
        if (rng.chance(0.2)) variant = `${variant} (5 points)`;
        if (rng.chance(0.2)) variant = variant.replace(/[.?]$/, "");
        return variant;
      });
      if (rng.chance(0.15)) texts.push(`Q${texts.length + 1}.`);
      if (texts.length) await db.question.createMany({ data: texts.map((text, index) => ({ fileId: item.id, number: index + 1, text })) });
    }
    await compare(page, courseId, `${context}, before grouping`);
    await regroup(page, courseId);
    await compare(page, courseId, `${context}, grouped`);

    // Without a regroup: one paper moves to another course, one becomes a material, one is deleted.
    const exams = await db.courseFile.findMany({ where: { courseId, category: "EXAM", questions: { some: {} } }, select: { id: true }, orderBy: { id: "asc" } });
    const [moved, material, deleted] = [rng.pick(exams), rng.pick(exams), rng.pick(exams)].map(item => item?.id);
    if (moved) await db.courseFile.update({ where: { id: moved }, data: { courseId: otherId } });
    if (material) await db.courseFile.updateMany({ where: { id: material, courseId }, data: { category: "MATERIAL" } });
    if (deleted) await db.courseFile.deleteMany({ where: { id: deleted, courseId } });
    await compare(page, courseId, `${context}, out of date`);
    await regroup(page, courseId);
    await compare(page, courseId, `${context}, regrouped`);
  }
  // The other course was never regrouped, so it has papers and no groups yet.
  await compare(page, otherId, `seed ${seed}, other course`);
});
