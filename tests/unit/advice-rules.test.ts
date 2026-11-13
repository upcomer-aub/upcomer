import { describe, expect, it } from "vitest";
import {
  ADVICE_PAGE_SIZE, adviceAbout, adviceDate, ANONYMOUS_AUTHOR, authorLabel, clampPage, cutQuestion, DELETED_AUTHOR,
  MAX_QUESTION_LABEL_LENGTH, safeResourceUrl, type AdviceTargets,
} from "@/lib/advice-rules";

// The display rules of the advice feed (US-38).

const none: Omit<AdviceTargets, "scope"> = { file: null, term: null, topic: null, questionGroup: null };

describe("authorLabel", () => {
  it("shows the author's name", () => {
    expect(authorLabel({ anonymous: false, authorName: "Lea Tass" })).toBe("Lea Tass");
  });
  it("never shows the name of an anonymous author, even when it is passed", () => {
    expect(authorLabel({ anonymous: true, authorName: "Lea Tass" })).toBe(ANONYMOUS_AUTHOR);
  });
  it("shows a deleted or blank account as a former student", () => {
    expect(authorLabel({ anonymous: false, authorName: null })).toBe(DELETED_AUTHOR);
    expect(authorLabel({ anonymous: false, authorName: "   " })).toBe(DELETED_AUTHOR);
  });
});

describe("adviceAbout", () => {
  it("shows course advice as course advice", () => {
    expect(adviceAbout({ scope: "COURSE", ...none })).toEqual({ scope: "COURSE", targetGone: false });
  });
  it("ignores a target on course advice", () => {
    expect(adviceAbout({ scope: "COURSE", ...none, file: { id: "f", title: "Final 2024" } })).toEqual({ scope: "COURSE", targetGone: false });
  });
  it("names each scope's target", () => {
    expect(adviceAbout({ scope: "EXAM", ...none, file: { id: "file-1", title: " Final \n 2024 " } })).toEqual({ scope: "EXAM", label: "Final 2024", fileId: "file-1" });
    expect(adviceAbout({ scope: "SESSION", ...none, term: { name: "Fall 2024" } })).toEqual({ scope: "SESSION", label: "Fall 2024" });
    expect(adviceAbout({ scope: "TOPIC", ...none, topic: "  TCP   congestion " })).toEqual({ scope: "TOPIC", label: "TCP congestion" });
    expect(adviceAbout({ scope: "QUESTION", ...none, questionGroup: { id: "g-1", text: "Explain the TCP handshake." } }))
      .toEqual({ scope: "QUESTION", label: "Explain the TCP handshake.", groupId: "g-1" });
  });
  it("shows advice whose target is gone, or blank, as course advice with targetGone", () => {
    for (const scope of ["EXAM", "SESSION", "TOPIC", "QUESTION"] as const) {
      expect(adviceAbout({ scope, ...none })).toEqual({ scope: "COURSE", targetGone: true });
    }
    expect(adviceAbout({ scope: "TOPIC", ...none, topic: " \n " })).toEqual({ scope: "COURSE", targetGone: true });
    expect(adviceAbout({ scope: "EXAM", ...none, file: { id: "f", title: "  " } })).toEqual({ scope: "COURSE", targetGone: true });
  });
  it("does not use another scope's target", () => {
    expect(adviceAbout({ scope: "EXAM", ...none, term: { name: "Fall 2024" }, topic: "TCP" })).toEqual({ scope: "COURSE", targetGone: true });
  });
});

describe("cutQuestion", () => {
  it("keeps a short question on one line", () => {
    expect(cutQuestion("What is\nTCP?")).toBe("What is TCP?");
  });
  it("cuts a long question with an ellipsis", () => {
    const cut = cutQuestion("word ".repeat(100));
    expect(cut.length).toBeLessThanOrEqual(MAX_QUESTION_LABEL_LENGTH);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("safeResourceUrl", () => {
  it("keeps an https link", () => {
    expect(safeResourceUrl(" https://ocw.mit.edu/courses/6-824 ")).toBe("https://ocw.mit.edu/courses/6-824");
  });
  it.each([
    "http://example.com", "javascript:alert(1)", "data:text/html,<b>x</b>", "ftp://example.com", "//example.com", "example.com",
    "https://user:pass@example.com", "", "   ", null, undefined,
  ])("drops %s", value => {
    expect(safeResourceUrl(value)).toBeNull();
  });
});

describe("clampPage", () => {
  it("has one page when there is nothing", () => {
    expect(clampPage(1, 0)).toEqual({ page: 1, totalPages: 1 });
  });
  it("counts whole pages of ADVICE_PAGE_SIZE", () => {
    expect(clampPage(2, ADVICE_PAGE_SIZE + 1)).toEqual({ page: 2, totalPages: 2 });
    expect(clampPage(1, ADVICE_PAGE_SIZE)).toEqual({ page: 1, totalPages: 1 });
  });
  it("sends a page past the end to the last page, and anything else to the first", () => {
    expect(clampPage(99, 45)).toEqual({ page: 3, totalPages: 3 });
    for (const value of ["abc", "1.5", "-2", "0", undefined, null, ""]) expect(clampPage(value, 45).page).toBe(1);
    expect(clampPage("2", 45).page).toBe(2);
  });
});

describe("adviceDate", () => {
  it("shows the day in UTC", () => {
    expect(adviceDate(new Date("2026-11-12T23:30:00Z"))).toBe("12 Nov 2026");
  });
});
