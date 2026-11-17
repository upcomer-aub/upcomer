import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// US-51 on the Upcomer Exam: which stored question a card's "Step-by-step walkthrough" link opens, and the link itself (only
// when the page asks for it, with an accessible name naming the question). No database: the forms are mocked.

vi.mock("@/components/mark-done", () => ({ MarkDoneForm: () => null }));
vi.mock("@/components/report-question", () => ({ ReportQuestionForm: () => null }));
import { ConsolidatedExamView, PersonalExamView } from "@/components/consolidated-exam";
import { walkthroughSourceOf, type ExamQuestion } from "@/lib/consolidated-exam";

const paper = (id: string) => ({ id, title: `Paper ${id}`, year: 2024, examType: null, term: null, professor: null });
const question = (over: Partial<ExamQuestion> = {}): ExamQuestion => ({
  id: "group-1", position: 3, rank: 3, text: "Explain the TCP handshake.", paperCount: 1, totalPapers: 2, papers: [paper("p1")], tier: "LIKELY",
  sourceQuestionId: "q-shown", ...over,
});

describe("walkthroughSourceOf (US-51)", () => {
  const group = {
    text: "Explain the TCP handshake",
    questions: [
      { id: "q-new", number: 1, text: "Q1. explain the  TCP   handshake", fileId: "p-new" },
      { id: "q-shown", number: 4, text: "Explain the TCP handshake (5 points)", fileId: "p-old" },
    ],
  };

  it("opens the source question whose text the card shows, when its paper is counted", () => {
    expect(walkthroughSourceOf(group, [{ id: "p-new" }, { id: "p-old" }])).toBe("q-shown");
  });

  it("falls back to the group's source question as mock exams choose it when that paper is not counted", () => {
    expect(walkthroughSourceOf(group, [{ id: "p-new" }])).toBe("q-new");
    expect(walkthroughSourceOf({ ...group, text: "something else" }, [{ id: "p-old" }, { id: "p-new" }])).toBe("q-shown");
  });

  it("gives null when no question is on a counted paper", () => {
    expect(walkthroughSourceOf(group, [{ id: "p-other" }])).toBeNull();
    expect(walkthroughSourceOf({ text: "x", questions: [] }, [{ id: "p-new" }])).toBeNull();
  });
});

describe("the walkthrough link on an Upcomer Exam card (US-51)", () => {
  const frequency = (item: ExamQuestion, walkthrough?: { courseId: string }) =>
    renderToStaticMarkup(<ConsolidatedExamView sections={[{ tier: item.tier, questions: [item] }]} walkthrough={walkthrough} />);

  it("links the card's source question in this course, labelled AI-generated", () => {
    const html = frequency(question(), { courseId: "course-a" });
    expect(html).toContain('<a aria-label="Step-by-step walkthrough of question 3" href="/courses/course-a/questions/q-shown/walkthrough">Step-by-step walkthrough</a>');
    expect(html).toContain('<span class="muted">(AI-generated)</span>');
  });

  it("encodes the IDs in the address", () => {
    expect(frequency(question({ sourceQuestionId: "q/1?x" }), { courseId: "c 1" })).toContain('href="/courses/c%201/questions/q%2F1%3Fx/walkthrough"');
  });

  it("shows no link when the page does not ask for it, or when the card has no source question", () => {
    expect(frequency(question())).not.toContain("walkthrough");
    expect(frequency(question({ sourceQuestionId: null }), { courseId: "course-a" })).not.toContain("Step-by-step walkthrough");
    expect(frequency(question({ sourceQuestionId: undefined }), { courseId: "course-a" })).not.toContain("Step-by-step walkthrough");
  });

  it("is on every card of the personal order too", () => {
    const html = renderToStaticMarkup(<PersonalExamView questions={[question(), question({ id: "group-2", position: 7, sourceQuestionId: "q-7" })]} walkthrough={{ courseId: "course-a" }} />);
    expect(html).toContain('aria-label="Step-by-step walkthrough of question 3" href="/courses/course-a/questions/q-shown/walkthrough"');
    expect(html).toContain('aria-label="Step-by-step walkthrough of question 7" href="/courses/course-a/questions/q-7/walkthrough"');
  });
});
