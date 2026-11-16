import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRng, type Rng } from "../reliability/rng";

const mocks = vi.hoisted(() => ({ countFiles: vi.fn(), findFiles: vi.fn(), findGroups: vi.fn(), logError: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  courseFile: { count: mocks.countFiles, findMany: mocks.findFiles },
  questionGroup: { findMany: mocks.findGroups },
} }));
vi.mock("@/lib/logger", () => ({ logError: mocks.logError }));
import { ConsolidatedExamView } from "@/components/consolidated-exam";
import { fullQuestionText, getConsolidatedExam, type ExamQuestion } from "@/lib/consolidated-exam";
import { isLowConfidence, LIKELIHOOD_TIERS, tierFor } from "@/lib/likelihood-tiers";

beforeEach(() => Object.values(mocks).forEach(mock => mock.mockReset()));

// Integer-only reference for the tier rule: very likely from half the papers, likely from a quarter.
const expectedTier = (count: number, total: number) => (count * 2 >= total ? "VERY_LIKELY" : count * 4 >= total ? "LIKELY" : "RARE");

describe("tier rule against an integer reference", () => {
  it("agrees for every paper count of every course size up to 500 papers", () => {
    for (let total = 1; total <= 500; total++) {
      for (let count = 1; count <= total; count++) {
        if (tierFor(count, total) !== expectedTier(count, total)) throw new Error(`${count} of ${total}: ${tierFor(count, total)}`);
      }
    }
  });
  it("keeps the same tier when the course and the count grow by the same factor", () => {
    for (let total = 1; total <= 60; total++) {
      for (let count = 1; count <= total; count++) {
        for (const factor of [2, 3, 7, 10]) expect(tierFor(count * factor, total * factor)).toBe(tierFor(count, total));
      }
    }
  });
  it("never throws and always gives a known tier for unusual numbers", () => {
    const values = [0, -0, -1, 0.5, 1e9, Number.MAX_SAFE_INTEGER, Infinity, -Infinity, NaN];
    for (const count of values) for (const total of values) expect(LIKELIHOOD_TIERS).toContain(tierFor(count, total));
    expect([NaN, Infinity, -1].map(isLowConfidence)).toEqual([false, false, false]);
  });
});

describe("fullQuestionText with unusual extracted text", () => {
  it.each([
    ["form feeds from PDF page breaks stay inside the line", "Explain ARP.\fContinued here.", "Explain ARP. Continued here."],
    ["a question that is only marks", "(10 points)", ""],
    ["a question that is only a number", "Q4.", ""],
    ["Arabic text", "١. اشرح بروتوكول ARP\n(أ) الجزء الأول", "١. اشرح بروتوكول ARP\n(أ) الجزء الأول"],
    ["emoji and symbols", "Is x² ≥ 0? 🤔\n(a) Prove it", "Is x² ≥ 0? 🤔\n(a) Prove it"],
    ["a numbered sub-part keeps its number", "Q1. Answer both parts:\n1. What is TCP?\n2. What is UDP?", "Answer both parts:\n1. What is TCP?\n2. What is UDP?"],
    ["blank lines and trailing spaces", "\n\n  Define a socket.   \n\n\n(a)  Give an example.  \n", "Define a socket.\n(a) Give an example."],
    ["old Mac line breaks", "Explain NAT.\r(a) Why?\r(b) How?", "Explain NAT.\n(a) Why?\n(b) How?"],
    ["HTML stays as text", "<b>Bold</b> <script>alert(1)</script>", "<b>Bold</b> <script>alert(1)</script>"],
    ["LIKE wildcards are plain characters", "What does 100% and a_b mean? \\%", "What does 100% and a_b mean? \\%"],
  ])("%s", (_, input, output) => {
    expect(fullQuestionText(input)).toBe(output);
  });
  it("handles a very long question without slowing down", () => {
    const text = `Q1. ${"word ".repeat(20_000)}\n(a) ${"x".repeat(50_000)}`;
    const started = performance.now();
    const result = fullQuestionText(text);
    expect(performance.now() - started).toBeLessThan(500);
    expect(result.split("\n")).toHaveLength(2);
    expect(result.startsWith("word word")).toBe(true);
  });
});

describe("rendering unusual content safely", () => {
  const paper = { id: "p1", title: "Exam", year: 2025, examType: null, term: null, professor: null };
  const question = (overrides: Partial<ExamQuestion>): ExamQuestion =>
    ({ id: "g1", position: 1, rank: 1, text: "Define a socket.", paperCount: 1, totalPapers: 1, papers: [paper], tier: "VERY_LIKELY", ...overrides });
  const render = (item: ExamQuestion) => renderToStaticMarkup(<ConsolidatedExamView sections={[{ tier: item.tier, questions: [item] }]} />);

  it("escapes HTML in question text and paper titles", () => {
    const html = render(question({
      text: '<script>alert(1)</script><img src=x onerror="alert(2)">',
      papers: [{ ...paper, title: '<a href="javascript:alert(3)">Final</a>', professor: { id: "x", name: "<b>Prof</b>" } }],
    }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;Prof&lt;/b&gt;");
  });
  it("encodes a paper ID with special characters in its link", () => {
    const html = render(question({ papers: [{ ...paper, id: "a b/../%_?#&\"'" }] }));
    expect(html).toContain('href="/files/a%20b%2F..%2F%25_%3F%23%26%22&#x27;"');
  });
  it("renders a paper with no title, year, session, type, or professor", () => {
    const html = render(question({ papers: [{ id: "p1", title: "", year: null, examType: null, term: null, professor: null }] }));
    expect(html).toContain("Year unknown · Session unknown");
  });
});

// Random courses run through the real question bank service on a mocked database, and the result is checked against a
// reference computed straight from the generated rows. Set EXAM_FUZZ_SEED to repeat one run.
describe("getConsolidatedExam on random courses", () => {
  type Paper = { id: string; title: string; year: number | null; examType: "FINAL" | "MIDTERM" | null; term: { id: string; name: string } | null; professor: null };
  function randomCourse(rng: Rng) {
    const papers: Paper[] = Array.from({ length: rng.int(0, 14) }, (_, index) => ({
      id: `p${index}-${rng.letters(3)}`, title: `Paper ${index}`, year: rng.chance(0.15) ? null : rng.int(2010, 2026),
      examType: rng.pick(["FINAL", "MIDTERM", null] as const), term: rng.chance(0.3) ? null : { id: "t", name: rng.pick(["Fall", "Spring", "Summer"]) }, professor: null,
    }));
    // Papers still in the course as exams with questions; the others moved, became materials, or were deleted since the last regroup.
    const current = new Set(papers.filter(() => rng.chance(0.85)).map(paper => paper.id));
    const groups = Array.from({ length: papers.length ? rng.int(0, 25) : 0 }, (_, index) => {
      const sources = Array.from({ length: rng.int(1, 6) }, (__, number) => ({ paper: rng.pick(papers), number }));
      return {
        id: `g${index}`, rank: 0, text: `Explain networking concept ${index}`, normalizedText: `question ${index}`, paperCount: new Set(sources.map(item => item.paper.id)).size,
        courseId: "c", course: { id: "c", code: "C1", name: "Course" },
        questions: sources.map(({ paper, number }, position) => ({ id: `g${index}q${position}`, number, text: rng.chance(0.2) ? `${number}. Part one\n(a) part two` : `Explain networking concept ${index}`, fileId: paper.id, file: paper })),
      };
    });
    // Ranked like the real bank: most papers first. The database returns them in rank order.
    groups.sort((a, b) => b.paperCount - a.paperCount).forEach((group, index) => { group.rank = index + 1; });
    return { papers, current, groups };
  }

  it("matches the reference and keeps every invariant", async () => {
    const seed = Number(process.env.EXAM_FUZZ_SEED) || Date.now() % 1_000_000;
    const rng = createRng(seed);
    for (let run = 0; run < 400; run++) {
      const { current, groups } = randomCourse(rng);
      mocks.countFiles.mockResolvedValue(current.size);
      mocks.findFiles.mockResolvedValue([...current].map(id => ({ id })));
      mocks.findGroups.mockResolvedValue(groups);
      const exam = await getConsolidatedExam("c");
      const context = `seed ${seed}, run ${run}`;

      const expected = groups
        .map(group => ({ id: group.id, rank: group.rank, count: new Set(group.questions.map(item => item.fileId).filter(id => current.has(id))).size }))
        .filter(item => item.count > 0);
      expect(exam.totalPapers, context).toBe(current.size);
      expect(exam.lowConfidence, context).toBe(current.size > 0 && current.size < 5);
      expect(exam.questions.map(item => [item.id, item.paperCount, item.tier]), context)
        .toEqual(expected.map(item => [item.id, item.count, expectedTier(item.count, current.size)]));
      exam.questions.forEach((item, index) => {
        expect(item.position, context).toBe(index + 1);
        expect(item.paperCount, context).toBeGreaterThanOrEqual(1);
        expect(item.paperCount, context).toBeLessThanOrEqual(item.totalPapers);
        expect(item.totalPapers, context).toBe(current.size);
        expect(item.papers.length, context).toBe(item.paperCount);
        expect(new Set(item.papers.map(paper => paper.id)).size, context).toBe(item.papers.length);
        item.papers.forEach(paper => expect(current.has(paper.id), context).toBe(true));
        for (let next = 1; next < item.papers.length; next++) expect((item.papers[next - 1].year ?? 0) >= (item.papers[next].year ?? 0), context).toBe(true);
        expect(item.text.length, context).toBeGreaterThan(0);
        if (index) expect(item.rank, context).toBeGreaterThan(exam.questions[index - 1].rank);
      });
      // The sections hold every question once, in order, and two sections in a row never share a tier.
      expect(exam.sections.flatMap(section => section.questions), context).toEqual(exam.questions);
      exam.sections.forEach((section, index) => {
        expect(section.questions.length, context).toBeGreaterThan(0);
        if (index) expect(section.tier, context).not.toBe(exam.sections[index - 1].tier);
      });
      // With no paper out of date, the tiers only go down the page, so each tier is one section.
      if (groups.every(group => group.questions.every(item => current.has(item.fileId)))) {
        const positions = exam.questions.map(item => LIKELIHOOD_TIERS.indexOf(item.tier));
        expect(positions, context).toEqual([...positions].sort((a, b) => a - b));
        expect(new Set(exam.sections.map(section => section.tier)).size, context).toBe(exam.sections.length);
      }
      // Rendering never throws and shows each question once.
      const html = renderToStaticMarkup(<ConsolidatedExamView sections={exam.sections} />);
      expect(html.match(/data-tier=/g)?.length ?? 0, context).toBe(exam.questions.length);
    }
    expect(mocks.logError).not.toHaveBeenCalled();
    // 400 random courses take about 1 s alone but 5-6 s under the full parallel run, past the 5 s default.
  }, 20_000);
});
