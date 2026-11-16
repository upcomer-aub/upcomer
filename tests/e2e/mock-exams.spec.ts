import { expect as baseExpect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { configureLogger } from "@/lib/logger";
import { generatePracticeQuestions } from "@/lib/practice-generation";
import { rebuildQuestionBank } from "@/lib/question-bank";

const expect = baseExpect.configure({ timeout: 15_000 });

// US-45: a student chooses topics, a length and a difficulty, gets an exam that follows them, and sits it: answers are
// saved, kept after a reload, and locked on submit. Only its student can open it, tampered settings are refused, and the
// student's generated practice questions (US-44) are mixed in when asked for. A request larger than the topics allow gets
// the largest exam they can give, with a message (US-45). US-47: a student who rated a topic weak gets more of it, and the
// exam page says why; a student without ratings gets the exam-frequency mix. The spec makes one course with two
// topic-tagged exam papers and three students. Everything is deleted at the end; the course and the students take the
// papers, questions, groups, generated questions and mock exams with them.
const stamp = String(Date.now()).slice(-8);
const courseId = `qa-mock-${stamp}`;
const password = "password123";
const students = {
  a: { id: `qa-mock-a-${stamp}`, email: `qa-mock-a-${stamp}@mail.aub.edu`, name: "Sits Mocks" },
  b: { id: `qa-mock-b-${stamp}`, email: `qa-mock-b-${stamp}@mail.aub.edu`, name: "Other Student" },
  c: { id: `qa-mock-c-${stamp}`, email: `qa-mock-c-${stamp}@mail.aub.edu`, name: "Rated Student" },
};
// From the simplest to the most complex: difficulty is estimated from a question's length and its number of parts.
const tcp = [
  "Define a TCP segment.",
  "Explain how the TCP three-way handshake opens a connection between two hosts.",
  "Describe TCP congestion control, and compare slow start with congestion avoidance in a long-lived connection.",
  "A sender transmits ten TCP segments and the fourth is lost.\na) Show what the receiver acknowledges.\nb) Explain when fast retransmit starts.\nc) Compute the window after recovery.",
];
const dns = [
  "Define a DNS zone.",
  "Explain how a recursive resolver finds the address of a host name it has never seen.",
  "Compare iterative and recursive DNS queries, and explain what a resolver caches and for how long it keeps each answer.",
];
const papers: Array<[number, string, string[]]> = [[2024, "TCP", tcp], [2025, "DNS", dns]];

const db = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  configureLogger({ persist: false });
  const passwordHash = await bcrypt.hash(password, 10);
  await db.user.createMany({ data: Object.values(students).map(student => ({ ...student, passwordHash })) });
  await db.course.create({ data: { id: courseId, code: `QM${stamp}`, name: `Mock Exam Course ${stamp}`, facultyId: "faculty-eng" } });
  for (const [year, topic, texts] of papers) {
    await db.courseFile.create({ data: {
      id: `${courseId}-${year}`, courseId, title: `${topic} final ${stamp}`, year, topic, examType: "FINAL", category: "EXAM",
      originalFileName: "eece350-final-2025.pdf", storageKey: "eece350-final-2025.pdf", mimeType: "application/pdf",
      questions: { create: texts.map((text, index) => ({ number: index + 1, text })) },
    } });
  }
  expect((await rebuildQuestionBank(courseId)).ok).toBe(true);
});
test.afterAll(async () => {
  try {
    const ids = Object.values(students).map(student => student.id);
    await db.$transaction([
      db.course.deleteMany({ where: { id: courseId } }),
      db.session.deleteMany({ where: { userId: { in: ids } } }),
      db.user.deleteMany({ where: { id: { in: ids } } }),
    ]);
    expect(await db.mockExam.count({ where: { OR: [{ courseId }, { userId: { in: ids } }] } })).toBe(0);
    expect(await db.generatedPracticeQuestion.count({ where: { userId: { in: ids } } })).toBe(0);
  } finally {
    await db.$disconnect();
  }
});

const mockExams = `/courses/${courseId}/mock-exams`;
const examUrl = new RegExp(`${mockExams}/[a-z0-9]+(\\?same=1)?$`);
async function fillLogIn(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}
async function logIn(page: Page, email: string) {
  await page.goto("/login");
  await fillLogIn(page, email);
  await expect(page).toHaveURL(/\/my-courses$/);
}
// Fills the form and generates an exam.
async function generate(page: Page, settings: { topics?: string[]; length: string; difficulty: string; generated?: boolean }) {
  await page.goto(mockExams);
  for (const topic of settings.topics ?? []) await page.getByRole("checkbox", { name: new RegExp(`^${topic} \\(`) }).check();
  await page.getByLabel("Number of questions").fill(settings.length);
  await page.getByLabel("Difficulty").selectOption({ label: settings.difficulty });
  if (settings.generated) await page.getByRole("checkbox", { name: /Include my generated practice questions/ }).check();
  await page.getByRole("button", { name: "Generate mock exam" }).click();
}
const questions = (page: Page) => page.locator("ol.question-list > li");
// The question texts of the exam on screen.
const shown = (page: Page) => page.locator("ol.question-list > li > p:first-of-type").allTextContents();
const answer = (page: Page, position: number) => page.getByRole("textbox", { name: `Your answer to question ${position}`, exact: true });
// Next's route announcer is an alert too, so notices are read inside <main>.
const status = (page: Page) => page.locator("main").getByRole("status");
const alert = (page: Page) => page.locator("main").getByRole("alert");
const examCount = () => db.mockExam.count({ where: { courseId } });
const mixLine = (page: Page) => page.getByTestId("mock-mix");
const FREQUENCY_ONLY = "You have no ratings or practice results in this course yet, so the mix follows how often each topic comes up in past papers.";

test("a student chooses a topic, a length and a difficulty, and the exam follows them (acceptance test)", async ({ page }) => {
  // A visitor sees what the page is for, logs in, and comes back to the form.
  await page.goto(mockExams);
  await expect(page.getByRole("heading", { name: "Mock Exams", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate mock exam" })).toHaveCount(0);
  await page.locator("main").getByRole("link", { name: "Log in" }).click();
  await fillLogIn(page, students.a.email);
  await expect(page).toHaveURL(new RegExp(`${mockExams}$`));
  await expect(page.getByRole("checkbox", { name: "TCP (4 questions)" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "DNS (3 questions)" })).toBeVisible();
  await expect(page.getByText("Difficulty is estimated from each question's length and number of parts")).toBeVisible();

  // Easier, TCP, three questions: the three simplest TCP questions and nothing else.
  await generate(page, { topics: ["TCP"], length: "3", difficulty: "Easier" });
  await expect(page).toHaveURL(examUrl);
  await expect(page.getByRole("heading", { name: "Mock Exam", level: 1 })).toBeVisible();
  await expect(page.locator("main")).toContainText("3 questions · Easier · TCP");
  await expect(questions(page)).toHaveCount(3);
  await expect(questions(page).locator(".eyebrow")).toHaveText([/Question 1 · TCP/, /Question 2 · TCP/, /Question 3 · TCP/]);
  expect((await shown(page)).sort()).toEqual(tcp.slice(0, 3).sort());
  await expect(questions(page).first()).toContainText(`Appeared in 1 of 2 papers: TCP final ${stamp} (2024)`);

  // Harder, same topic and length: the three most complex ones.
  await generate(page, { topics: ["TCP"], length: "3", difficulty: "Harder" });
  await expect(page.locator("main")).toContainText("3 questions · Harder · TCP");
  expect((await shown(page)).sort()).toEqual(tcp.slice(1).sort());

  // No topic ticked: every topic, and exactly the length asked for.
  await generate(page, { length: "5", difficulty: "Mixed" });
  await expect(page.locator("main")).toContainText("5 questions · Mixed · All topics");
  await expect(questions(page)).toHaveCount(5);
  const texts = await shown(page);
  expect(texts.some(text => tcp.includes(text)) && texts.some(text => dns.includes(text))).toBe(true);
  // This student rated nothing, so the mix follows exam frequency only, and the page says so.
  await expect(mixLine(page)).toHaveText(FREQUENCY_ONLY);

  // A length that needs every question of the topic: the page says the difficulty could not choose.
  await generate(page, { topics: ["DNS"], length: "3", difficulty: "Easier" });
  await expect(page).toHaveURL(/\?same=1$/);
  await expect(status(page)).toContainText("the difficulty could not choose between them");
  expect((await shown(page)).sort()).toEqual([...dns].sort());

  // The list shows the student's exams with their settings.
  await page.getByRole("link", { name: "← Back to Mock Exams" }).click();
  await expect(page.getByRole("link", { name: "3 questions · Harder · TCP" })).toBeVisible();
  await expect(page.getByRole("link", { name: "5 questions · Mixed · All topics" })).toBeVisible();
  await expect(page.getByText(/^In progress · created/)).toHaveCount(4);
});

test("the sitting flow: answers are saved, kept after a reload, and locked on submit", async ({ page, context }) => {
  await logIn(page, students.a.email);
  await generate(page, { topics: ["TCP"], length: "3", difficulty: "Easier" });
  await expect(page).toHaveURL(examUrl);
  const url = page.url();
  await expect(page.getByText("0 of 3 answers saved.")).toBeVisible();

  await answer(page, 1).fill("A segment is the unit TCP sends.\nIt has a header and data.");
  await answer(page, 2).fill("SYN, SYN-ACK, ACK.");
  await page.getByRole("button", { name: "Save progress" }).click();
  await expect(status(page)).toHaveText("Your answers were saved.");
  await expect(page.getByText("2 of 3 answers saved.")).toBeVisible();

  // The answers are still there after a reload, and can be changed.
  await page.goto(url);
  await expect(answer(page, 1)).toHaveValue("A segment is the unit TCP sends.\nIt has a header and data.");
  await expect(answer(page, 2)).toHaveValue("SYN, SYN-ACK, ACK.");
  await expect(answer(page, 3)).toHaveValue("");
  await expect(status(page)).toHaveCount(0);

  // A second tab opens the same exam before it is submitted.
  const stale = await context.newPage();
  await stale.goto(url);
  await expect(stale.getByRole("button", { name: "Save progress" })).toBeVisible();

  await answer(page, 2).fill("SYN, then SYN-ACK, then ACK.");
  await answer(page, 3).fill("Slow start doubles the window each round trip.");
  await page.getByRole("button", { name: "Submit exam" }).click();
  await expect(status(page)).toHaveText("Your exam was submitted.");
  await expect(page.getByText("3 of 3 answers saved.")).toBeVisible();
  await expect(page.getByText("Submitted. Your answers are locked.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save progress" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Submit exam" })).toHaveCount(0);
  for (const position of [1, 2, 3]) await expect(answer(page, position)).not.toBeEditable();
  await expect(answer(page, 2)).toHaveValue("SYN, then SYN-ACK, then ACK.");

  // The stale tab cannot change the submitted exam.
  await answer(stale, 1).fill("Changed after submitting.");
  await stale.getByRole("button", { name: "Save progress" }).click();
  await expect(alert(stale)).toHaveText("This exam was already submitted, so its answers can't change.");
  await expect(answer(stale, 1)).toHaveValue("A segment is the unit TCP sends.\nIt has a header and data.");
  await stale.close();

  const id = url.split("/").pop()!.split("?")[0];
  const saved = await db.mockExam.findUniqueOrThrow({ where: { id }, select: { status: true, userId: true, questions: { orderBy: { position: "asc" }, select: { answer: true } } } });
  expect(saved).toMatchObject({ status: "SUBMITTED", userId: students.a.id });
  expect(saved.questions.map(question => question.answer)).toEqual([
    "A segment is the unit TCP sends.\nIt has a header and data.", "SYN, then SYN-ACK, then ACK.", "Slow start doubles the window each round trip.",
  ]);
  await page.getByRole("link", { name: "← Back to Mock Exams" }).click();
  await expect(page.getByText(/^Submitted · created/)).toHaveCount(1);
});

test("only its student can open an exam, and the other student's list is empty", async ({ page }) => {
  const exam = await db.mockExam.findFirstOrThrow({ where: { courseId, userId: students.a.id }, select: { id: true } });
  await logIn(page, students.b.email);
  const response = await page.goto(`${mockExams}/${exam.id}`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await expect(page.locator("textarea")).toHaveCount(0);
  await page.goto(mockExams);
  await expect(page.getByRole("heading", { name: "Your mock exams" })).toHaveCount(0);
});

test("a request larger than the topics allow gets the largest exam, with a message (US-45)", async ({ page }) => {
  await logIn(page, students.a.email);
  const before = await examCount();
  await generate(page, { topics: ["DNS"], length: "5", difficulty: "Harder" });
  await expect(page).toHaveURL(examUrl);
  const message = "You asked for 5 questions, but your topics have only 3 that fit, so this exam has 3.";
  await expect(status(page)).toHaveText(message);
  await expect(page.locator("main")).toContainText("3 questions · Harder · DNS");
  await expect(questions(page)).toHaveCount(3);
  expect((await shown(page)).sort()).toEqual([...dns].sort());
  await page.screenshot({ path: "test-results/mock-exam-shorter.png", fullPage: true });
  // Still there after a reload, and the exam keeps both lengths.
  await page.reload();
  await expect(status(page)).toHaveText(message);
  const id = page.url().split("/").pop()!.split("?")[0];
  expect(await db.mockExam.findUniqueOrThrow({ where: { id }, select: { length: true, requestedLength: true } })).toEqual({ length: 3, requestedLength: 5 });
  expect(await examCount()).toBe(before + 1);
});

test("tampered settings are refused with a message and save nothing", async ({ page }) => {
  await logIn(page, students.a.email);
  const before = await examCount();

  // A length outside the limits, sent past the browser's own check.
  await page.goto(mockExams);
  await page.getByLabel("Number of questions").evaluate((input: HTMLInputElement) => { input.removeAttribute("max"); input.value = "999"; });
  await page.getByRole("button", { name: "Generate mock exam" }).click();
  await expect(alert(page)).toHaveText("Choose between 3 and 50 questions.");

  // A difficulty and a topic that are not in the lists.
  await page.goto(mockExams);
  await page.getByLabel("Difficulty").evaluate((select: HTMLSelectElement) => { select.options[0].value = "IMPOSSIBLE"; select.selectedIndex = 0; });
  await page.getByRole("button", { name: "Generate mock exam" }).click();
  await expect(alert(page)).toHaveText("Choose a difficulty from the list.");
  await page.goto(mockExams);
  await page.getByRole("checkbox", { name: "TCP (4 questions)" }).evaluate((box: HTMLInputElement) => { box.value = "a topic of another course"; box.checked = true; });
  await page.getByRole("button", { name: "Generate mock exam" }).click();
  await expect(alert(page)).toHaveText("One of the topics you picked isn't a topic of this course. Choose again.");

  expect(await examCount()).toBe(before);
});

test("generated practice questions are mixed in only when the student asks", async ({ page }) => {
  await logIn(page, students.a.email);
  await page.goto(mockExams);
  await expect(page.getByText("You have no generated practice questions for this course.")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Include my generated practice questions/ })).toHaveCount(0);

  // Two easy generated questions on TCP for this student, and one for the other student.
  expect(await generatePracticeQuestions(students.a.id, courseId, { count: 2, difficulty: "EASY", topicKey: "tcp" })).toMatchObject({ ok: true });
  expect(await generatePracticeQuestions(students.b.id, courseId, { count: 1, difficulty: "EASY", topicKey: "tcp" })).toMatchObject({ ok: true });
  await page.goto(mockExams);
  await expect(page.getByRole("checkbox", { name: "Include my generated practice questions (2 available)" })).not.toBeChecked();

  // Not ticked: past papers only, as before.
  await generate(page, { topics: ["TCP"], length: "4", difficulty: "Easier" });
  await expect(questions(page)).toHaveCount(4);
  await expect(page.locator('li[data-kind="generated"]')).toHaveCount(0);

  // Ticked: half of the four are the student's generated questions, after the past-paper ones.
  await generate(page, { topics: ["TCP"], length: "4", difficulty: "Easier", generated: true });
  await expect(page.locator("main")).toContainText("4 questions · Easier · TCP · with generated questions");
  await expect(questions(page)).toHaveCount(4);
  await expect(questions(page).nth(0)).toHaveAttribute("data-kind", "past-paper");
  await expect(questions(page).nth(1)).toHaveAttribute("data-kind", "past-paper");
  await expect(page.locator('li[data-kind="generated"]')).toHaveCount(2);
  await expect(questions(page).nth(2)).toContainText(`Generated practice question, based on TCP final ${stamp}. It did not appear in a past paper.`);
  const id = page.url().split("/").pop()!.split("?")[0];
  const rows = await db.mockExamQuestion.findMany({ where: { mockExamId: id, generatedQuestionId: { not: null } }, select: { generatedQuestion: { select: { userId: true } } } });
  expect(rows.map(row => row.generatedQuestion?.userId)).toEqual([students.a.id, students.a.id]);

  // No generated question is on DNS, so a DNS exam stays past papers only.
  await generate(page, { topics: ["DNS"], length: "3", difficulty: "Mixed", generated: true });
  await expect(questions(page)).toHaveCount(3);
  await expect(page.locator('li[data-kind="generated"]')).toHaveCount(0);
});

test("a student who rated a topic weak gets more of it, alongside the frequent topics, and is told why (US-47)", async ({ page }) => {
  await logIn(page, students.c.email);
  await page.goto(`/courses/${courseId}/confidence`);
  await page.getByRole("group", { name: "DNS", exact: true }).getByRole("radio", { name: "1 · Not confident", exact: true }).check();
  await page.getByRole("group", { name: "TCP", exact: true }).getByRole("radio", { name: "5 · Very confident", exact: true }).check();
  await page.getByRole("button", { name: "Save ratings" }).click();
  await expect(page.locator("main").getByRole("status")).toContainText("Your ratings were saved.");

  await generate(page, { length: "4", difficulty: "Mixed" });
  await expect(page).toHaveURL(examUrl);
  await expect(mixLine(page)).toHaveText("Weighted toward your weaker topic: DNS, and toward the topics that come up most in past papers.");
  await expect(questions(page)).toHaveCount(4);
  // Both topics come up in one paper each; without ratings the four questions split 2 and 2 (the first student's exam).
  // Rated weak, DNS gets three, and TCP still has one.
  const topics = await questions(page).locator(".eyebrow").allTextContents();
  expect(topics.filter(text => text.endsWith("· DNS"))).toHaveLength(3);
  expect(topics.filter(text => text.endsWith("· TCP"))).toHaveLength(1);
  await page.screenshot({ path: "test-results/mock-exam-weighted.png", fullPage: true });

  // The other student, without ratings, gets the frequency mix for the same settings.
  await logIn(page, students.a.email);
  await generate(page, { length: "4", difficulty: "Mixed" });
  await expect(mixLine(page)).toHaveText(FREQUENCY_ONLY);
  const plain = await questions(page).locator(".eyebrow").allTextContents();
  expect(plain.filter(text => text.endsWith("· DNS"))).toHaveLength(2);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the form and the sitting fit a 375 px phone in ${colorScheme} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.emulateMedia({ colorScheme });
    await logIn(page, students.a.email);
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    const inside = async (selector: string) => {
      for (const box of await page.locator(selector).evaluateAll(elements => elements.map(element => element.getBoundingClientRect()).map(rect => ({ left: rect.left, right: rect.right })))) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(375);
      }
    };
    await page.goto(mockExams);
    await expect(page.getByRole("button", { name: "Generate mock exam" })).toBeVisible();
    expect(await fits()).toBe(true);
    await inside("main form input, main form select, main form button, main form label");
    await page.screenshot({ path: `test-results/mock-exams-form-375-${colorScheme}.png`, fullPage: true });

    const exam = await db.mockExam.findFirstOrThrow({ where: { courseId, userId: students.a.id, status: "IN_PROGRESS", length: 4 }, orderBy: { createdAt: "desc" }, select: { id: true } });
    await page.goto(`${mockExams}/${exam.id}`);
    await expect(page.getByRole("button", { name: "Submit exam" })).toBeVisible();
    expect(await fits()).toBe(true);
    await inside("main form textarea, main form button, ol.question-list > li");
    // Text and background differ, so the question is readable in this colour scheme.
    const colours = await questions(page).first().evaluate(element => [getComputedStyle(element).color, getComputedStyle(element).backgroundColor]);
    expect(colours[0]).not.toBe(colours[1]);
    await page.screenshot({ path: `test-results/mock-exams-sitting-375-${colorScheme}.png`, fullPage: true });
  });
}
