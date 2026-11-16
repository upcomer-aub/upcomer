import { describe, expect, it } from "vitest";
import {
  ANSWER_KEY_MAX_POINTS, answerKeyMessage, creditOf, eventCorrect, importantStems, markAnswer, normalizeText, parseAnswerKey, stem,
} from "@/lib/mock-marking-rules";

// US-49 marking rules: an answer is marked only against an admin's answer key, by the key points it covers. No key means
// no mark, never a guess.

const key = { keyPoints: ["SYN, SYN-ACK, ACK", "sequence numbers are synchronised", "three-way handshake"], explanation: "TCP opens a connection with a handshake." };

describe("normalizeText and stem", () => {
  it("ignores case, accents, and punctuation", () => {
    expect(normalizeText("  Élan, the TCP/IP-Stack! ")).toBe("elan the tcp ip stack");
  });
  it("treats plurals and simple verb forms as the same word", () => {
    for (const [a, b] of [["packets", "packet"], ["routing", "route"], ["routes", "route"], ["processes", "process"], ["queries", "query"], ["uses", "use"]]) {
      expect(stem(a)).toBe(stem(b));
    }
    expect(stem("1024")).toBe("1024");
  });
  it("drops stopwords from a key point, unless the point is only stopwords", () => {
    expect(importantStems("the sequence numbers are synchronised")).toEqual(["sequenc", "number", "synchronis"]);
    expect(importantStems("it is")).toEqual(["it", "is"]);
  });
});

describe("markAnswer", () => {
  it("never guesses: no key means NO_KEY with a message, and no learning event", () => {
    for (const noKey of [null, { keyPoints: [], explanation: "x" }]) {
      const marking = markAnswer("SYN, SYN-ACK, ACK", noKey);
      expect(marking).toMatchObject({ outcome: "NO_KEY", matchedPoints: [], missedPoints: [] });
      expect(marking.feedback).toContain("no answer key");
      expect(eventCorrect(marking.outcome)).toBeNull();
      expect(creditOf(marking)).toBeNull();
    }
  });

  it("is CORRECT when every key point is covered, in any order and wording of endings", () => {
    const marking = markAnswer("It's the three way handshake: syn, then SYN ACK, then ack; both sides synchronise their sequence number.", key);
    expect(marking.outcome).toBe("CORRECT");
    expect(marking.missedPoints).toEqual([]);
    expect(eventCorrect(marking.outcome)).toBe(true);
    expect(creditOf(marking)).toBe(1);
  });

  it("is PARTIAL with the missed points explained", () => {
    const marking = markAnswer("The three-way handshake.", key);
    expect(marking).toMatchObject({ outcome: "PARTIAL", matchedPoints: ["three-way handshake"], missedPoints: ["SYN, SYN-ACK, ACK", "sequence numbers are synchronised"] });
    expect(marking.feedback).toContain('Your answer does not cover: "SYN, SYN-ACK, ACK"; "sequence numbers are synchronised".');
    expect(marking.feedback).toContain(key.explanation);
    expect(eventCorrect(marking.outcome)).toBe(false);
    expect(creditOf(marking)).toBeCloseTo(1 / 3);
  });

  it("is INCORRECT when no key point is covered", () => {
    expect(markAnswer("UDP is connectionless.", key)).toMatchObject({ outcome: "INCORRECT", matchedPoints: [] });
  });

  it("is UNANSWERED for an empty or blank answer, and lists what a full answer covers", () => {
    for (const answer of [null, "", "   \n ", "?!"]) {
      const marking = markAnswer(answer, key);
      expect(marking.outcome).toBe("UNANSWERED");
      expect(marking.feedback).toContain("You did not answer.");
      expect(eventCorrect(marking.outcome)).toBe(false);
    }
  });

  it("needs every important word of a point, not just one", () => {
    expect(markAnswer("sequence", { keyPoints: ["sequence numbers are synchronised"], explanation: "" }).outcome).toBe("INCORRECT");
  });

  it("does not match a word inside another word", () => {
    expect(markAnswer("acknowledgement", { keyPoints: ["ACK"], explanation: "" }).outcome).toBe("INCORRECT");
  });

  it("keeps the admin's explanation for a correct answer, and none when there is no explanation", () => {
    expect(markAnswer("ack", { keyPoints: ["ACK"], explanation: "Good." }).feedback).toBe("Good.");
    expect(markAnswer("ack", { keyPoints: ["ACK"], explanation: "" }).feedback).toBeNull();
  });
});

describe("parseAnswerKey", () => {
  it("takes one key point per line, collapses spacing, and drops blank lines and repeats", () => {
    expect(parseAnswerKey({ keyPoints: " SYN,  SYN-ACK, ACK \r\n\r\n three-way handshake\nThree-way  handshake\n", explanation: " Why.\r\nBecause. " }))
      .toEqual({ ok: true, keyPoints: ["SYN, SYN-ACK, ACK", "three-way handshake"], explanation: "Why.\nBecause." });
  });
  it("refuses no points, too many, a point too long, and an explanation too long", () => {
    expect(parseAnswerKey({ keyPoints: " \n ", explanation: "" })).toEqual({ ok: false, error: "points_required" });
    expect(parseAnswerKey({ keyPoints: Array.from({ length: ANSWER_KEY_MAX_POINTS + 1 }, (_, i) => `point ${i}`).join("\n"), explanation: "" }))
      .toEqual({ ok: false, error: "too_many_points" });
    expect(parseAnswerKey({ keyPoints: "a".repeat(201), explanation: "" })).toEqual({ ok: false, error: "point_too_long" });
    expect(parseAnswerKey({ keyPoints: "a", explanation: "b".repeat(2001) })).toEqual({ ok: false, error: "explanation_too_long" });
  });
  it("gives each refusal its message, and the general one for anything else", () => {
    expect(answerKeyMessage("points_required")).toBe("Write at least one key point, one per line.");
    expect(answerKeyMessage("<b>")).toBe("The answer key could not be saved. Please try again.");
  });
});
