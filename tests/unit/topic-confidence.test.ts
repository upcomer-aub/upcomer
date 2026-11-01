import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// US-24: the confidence scale, its conversion to weakness, the form's validation, and saving through setTopicWeakness in
// one transaction. The database and setTopicWeakness are mocked; a transaction keeps its writes only if it succeeds.

const mocks = vi.hoisted(() => ({
  courseFile: { findMany: vi.fn() },
  learningTopic: { findMany: vi.fn() },
  transaction: vi.fn(),
  setTopicWeakness: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { courseFile: mocks.courseFile, learningTopic: mocks.learningTopic, $transaction: mocks.transaction } }));
vi.mock("@/lib/learning-profile", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/learning-profile")>()), setTopicWeakness: mocks.setTopicWeakness }));
import { NEUTRAL_WEAKNESS } from "@/lib/learning-profile";
import { EVENT_LEVELS } from "@/lib/logger";
import { resetRateLimits } from "@/lib/rate-limit";
import { getCourseTopics, getTopicConfidence, SAVE_TRANSACTION, saveTopicConfidence } from "@/lib/topic-confidence";
import { CONFIDENCE_SCALE, confidenceMessage, parseRatings, weaknessFromRating } from "@/lib/topic-confidence-rules";

let errors: ReturnType<typeof vi.spyOn>;
const logged = () => errors.mock.calls.map(call => JSON.parse(String(call[0])));
const courseKeys = new Set(["tcp", "routing", "dns"]);
// The course's papers, newest first: TCP twice (spelled two ways), Routing, DNS.
const papers = [{ topic: "TCP" }, { topic: " tcp " }, { topic: "Routing" }, { topic: "DNS" }];
// Rows already in the student's profile, by topic key, as the transaction reads them.
let rows: Array<{ topicKey: string; confidence: number | null }>;
// Writes of the transaction in progress, and of committed transactions.
let staged: unknown[][];
let committed: unknown[][];

beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  resetRateLimits();
  rows = [];
  staged = [];
  committed = [];
  mocks.courseFile.findMany.mockReset().mockResolvedValue(papers);
  mocks.learningTopic.findMany.mockReset().mockImplementation(async () => rows);
  mocks.setTopicWeakness.mockReset().mockImplementation(async (...args: unknown[]) => {
    staged.push(args);
    return { ok: true };
  });
  mocks.transaction.mockReset().mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
    staged = [];
    const result = await work({ learningTopic: mocks.learningTopic });
    committed.push(...staged);
    return result;
  });
});
afterEach(() => {
  errors.mockRestore();
  vi.unstubAllEnvs();
});

describe("the confidence scale (US-24)", () => {
  it("turns ratings 1 to 5 into weakness (5 - rating) / 4", () => {
    expect(CONFIDENCE_SCALE.map(step => step.rating)).toEqual([1, 2, 3, 4, 5]);
    expect(CONFIDENCE_SCALE.map(step => weaknessFromRating(step.rating))).toEqual([1, 0.75, 0.5, 0.25, 0]);
  });
  it("labels the ends Not confident and Very confident", () => {
    expect(CONFIDENCE_SCALE[0].label).toBe("Not confident");
    expect(CONFIDENCE_SCALE[4].label).toBe("Very confident");
  });
  it("uses one neutral default of one half for a skipped topic", () => {
    expect(NEUTRAL_WEAKNESS).toBe(0.5);
  });
});

describe("parseRatings (US-24)", () => {
  it("reads a rating or Skip for each topic, and ignores other fields", () => {
    const result = parseRatings([["courseId", "course-a"], ["$ACTION_ID_abc", ""], ["rating:tcp", "1"], ["rating:routing", "skip"], ["rating:dns", "5"]], courseKeys);
    expect(result).toEqual({ ok: true, ratings: [{ topicKey: "tcp", rating: 1 }, { topicKey: "routing", rating: null }, { topicKey: "dns", rating: 5 }] });
  });
  it("accepts a form where every topic is skipped, or only some topics are sent", () => {
    expect(parseRatings([["rating:tcp", "skip"], ["rating:dns", "skip"]], courseKeys)).toMatchObject({ ok: true });
    expect(parseRatings([["rating:routing", "3"]], courseKeys)).toEqual({ ok: true, ratings: [{ topicKey: "routing", rating: 3 }] });
  });
  it.each([["0"], ["6"], ["2.5"], ["abc"], [""], [" 3"], ["-1"], ["SKIP"]])("refuses the rating %j", value => {
    expect(parseRatings([["rating:tcp", "3"], ["rating:dns", value]], courseKeys)).toEqual({ ok: false, error: "invalid_rating" });
  });
  it("refuses a topic that is not in this course, including one from another course", () => {
    expect(parseRatings([["rating:tcp", "3"], ["rating:operating systems", "2"]], courseKeys)).toEqual({ ok: false, error: "unknown_topic" });
    expect(parseRatings([["rating:TCP", "3"]], courseKeys)).toEqual({ ok: false, error: "unknown_topic" });
  });
  it("refuses a topic sent twice, a file, and a form without ratings", () => {
    expect(parseRatings([["rating:tcp", "3"], ["rating:tcp", "4"]], courseKeys)).toEqual({ ok: false, error: "invalid_rating" });
    expect(parseRatings([["rating:tcp", new File(["x"], "x.txt")]], courseKeys)).toEqual({ ok: false, error: "invalid_rating" });
    expect(parseRatings([["courseId", "course-a"]], courseKeys)).toEqual({ ok: false, error: "no_ratings" });
  });
  it("shows a fixed message for each refusal, and never echoes a value from the URL", () => {
    expect(confidenceMessage("invalid_rating")).toMatch(/1 to 5/);
    expect(confidenceMessage("<script>alert(1)</script>")).toBe(confidenceMessage("unexpected"));
    expect(confidenceMessage("toString")).toBe(confidenceMessage("unexpected"));
  });
});

describe("getCourseTopics and getTopicConfidence (US-24)", () => {
  it("lists the distinct topics of the course's published exam papers, keyed like the personal order", async () => {
    expect(await getCourseTopics("course-a")).toEqual([
      { topicKey: "dns", topic: "DNS" }, { topicKey: "routing", topic: "Routing" }, { topicKey: "tcp", topic: "TCP" },
    ]);
    expect(mocks.courseFile.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { courseId: "course-a", category: "EXAM", status: "PUBLISHED", topic: { not: null } },
    }));
  });
  it("reads only this student's rows in this course", async () => {
    rows = [{ topicKey: "tcp", confidence: 2 }, { topicKey: "dns", confidence: null }];
    expect(await getTopicConfidence("student-1", "course-a")).toEqual(new Map([["tcp", 2], ["dns", null]]));
    expect(mocks.learningTopic.findMany).toHaveBeenCalledWith({ where: { userId: "student-1", courseId: "course-a" }, select: { topicKey: true, confidence: true } });
  });
});

describe("saveTopicConfidence (US-24)", () => {
  const form = (ratings: Record<string, string>): Array<[string, string]> => [["courseId", "course-a"], ...Object.entries(ratings).map(([key, value]) => [`rating:${key}`, value] as [string, string])];

  it("saves each rating as weakness with setTopicWeakness, with the rating, in one transaction", async () => {
    expect(await saveTopicConfidence("student-1", "course-a", form({ tcp: "1", routing: "4", dns: "skip" }))).toEqual({ ok: true, rated: 2, skipped: 1, unchanged: 0 });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), SAVE_TRANSACTION);
    expect(SAVE_TRANSACTION.timeout).toBeGreaterThan(5_000);
    const tx = { learningTopic: mocks.learningTopic };
    expect(committed).toEqual([
      ["student-1", "course-a", "TCP", 1, { confidence: 1, client: tx }],
      ["student-1", "course-a", "Routing", 0.25, { confidence: 4, client: tx }],
      ["student-1", "course-a", "DNS", NEUTRAL_WEAKNESS, { confidence: null, client: tx }],
    ]);
    expect(logged()).toEqual([{ event: "topic_confidence_saved", level: "info", timestamp: expect.any(String), userId: "student-1", courseId: "course-a", ratedTopics: "2", skippedTopics: "1", unchangedTopics: "0" }]);
  });
  it("on Skip, keeps a weakness written by other code, but clears the student's own earlier rating", async () => {
    rows = [{ topicKey: "tcp", confidence: null }, { topicKey: "routing", confidence: 2 }];
    expect(await saveTopicConfidence("student-1", "course-a", form({ tcp: "skip", routing: "skip", dns: "skip" }))).toEqual({ ok: true, rated: 0, skipped: 2, unchanged: 1 });
    expect(committed.map(args => args[2])).toEqual(["Routing", "DNS"]);
    expect(committed.every(args => args[3] === NEUTRAL_WEAKNESS)).toBe(true);
  });
  it("refuses tampered input, saves nothing, and logs only IDs and the reason", async () => {
    for (const [ratings, reason] of [[{ tcp: "9" }, "invalid_rating"], [{ "secret topic": "3" }, "unknown_topic"], [{}, "no_ratings"]] as const) {
      expect(await saveTopicConfidence("student-1", "course-a", form(ratings))).toEqual({ ok: false, error: reason });
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.setTopicWeakness).not.toHaveBeenCalled();
    expect(logged().map(line => line.reason)).toEqual(["invalid_rating", "unknown_topic", "no_ratings"]);
    for (const line of logged()) expect(Object.keys(line).sort()).toEqual(["courseId", "event", "level", "reason", "timestamp", "userId"]);
    expect(JSON.stringify(logged())).not.toMatch(/secret topic|TCP/i);
  });
  it("keeps nothing when one of several writes fails, and logs the failure", async () => {
    mocks.setTopicWeakness.mockImplementation(async (...args: unknown[]) => {
      staged.push(args);
      return args[2] === "Routing" ? { ok: false, error: "unexpected" } : { ok: true };
    });
    expect(await saveTopicConfidence("student-1", "course-a", form({ tcp: "1", routing: "2", dns: "3" }))).toEqual({ ok: false, error: "unexpected" });
    expect(staged.length).toBeGreaterThan(0);
    expect(committed).toEqual([]);
    expect(logged()).toEqual([expect.objectContaining({ event: "topic_confidence_save_failed", userId: "student-1", courseId: "course-a", errorType: "WriteFailed" })]);
  });
  it("logs a database failure with its error type", async () => {
    mocks.transaction.mockRejectedValue(new TypeError("connection lost"));
    expect(await saveTopicConfidence("student-1", "course-a", form({ tcp: "1" }))).toEqual({ ok: false, error: "unexpected" });
    expect(logged()).toEqual([expect.objectContaining({ event: "topic_confidence_save_failed", errorType: "TypeError" })]);
    expect(JSON.stringify(logged())).not.toContain("connection lost");
  });
  it("limits saves per student per minute, from TOPIC_CONFIDENCE_RATE_LIMIT_PER_MINUTE", async () => {
    vi.stubEnv("TOPIC_CONFIDENCE_RATE_LIMIT_PER_MINUTE", "2");
    for (let i = 0; i < 2; i++) expect(await saveTopicConfidence("student-1", "course-a", form({ tcp: "3" }))).toMatchObject({ ok: true });
    expect(await saveTopicConfidence("student-1", "course-a", form({ tcp: "3" }))).toEqual({ ok: false, error: "rate_limited" });
    expect(logged().at(-1)).toMatchObject({ event: "topic_confidence_rate_limited", userId: "student-1", retryAfterSeconds: expect.any(String) });
    // Another student has their own limit.
    expect(await saveTopicConfidence("student-2", "course-a", form({ tcp: "3" }))).toMatchObject({ ok: true });
  });
  it("defaults to 30 saves per minute", async () => {
    for (let i = 0; i < 30; i++) expect(await saveTopicConfidence("student-3", "course-a", form({ tcp: "3" }))).toMatchObject({ ok: true });
    expect(await saveTopicConfidence("student-3", "course-a", form({ tcp: "3" }))).toEqual({ ok: false, error: "rate_limited" });
  });
  it("logs at the agreed levels", () => {
    expect(EVENT_LEVELS.topic_confidence_saved).toBe("info");
    expect(EVENT_LEVELS.topic_confidence_refused).toBe("warn");
    expect(EVENT_LEVELS.topic_confidence_rate_limited).toBe("warn");
    expect(EVENT_LEVELS.topic_confidence_save_failed).toBe("error");
  });
});
