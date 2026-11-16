import { describe, expect, it } from "vitest";
import { parseMockExamConfig, sittingMessage, mockExamMessage } from "@/lib/mock-exam-rules";
import {
  acceptsSave, crossedWarning, deadlineFrom, finishesNow, FINISH_TOLERANCE_MS, formatTimeLeft, isExpired, isTimeLimit, MOCK_EXAM_GRACE_MS, MOCK_EXAM_TIME_LIMITS,
  oldestOpenDeadline, suggestedTimeLimit, TIME_UP_NOTICE, timeLeftMs, timeLimitLabel, timerLevel,
} from "@/lib/mock-exam-timing";

// US-48: the deadline rules of a timed mock exam. Every rule takes the time as an argument (the server's), so the clock
// here is a fixed one.
const start = new Date("2026-11-16T10:00:00.000Z");
const deadline = deadlineFrom(start, 30);
const at = (msAfterDeadline: number) => new Date(deadline.getTime() + msAfterDeadline);

describe("the time limit setting", () => {
  it("offers limits from 10 to 180 minutes, and nothing else", () => {
    expect(MOCK_EXAM_TIME_LIMITS[0]).toBe(10);
    expect(MOCK_EXAM_TIME_LIMITS.at(-1)).toBe(180);
    expect(isTimeLimit(30)).toBe(true);
    for (const minutes of [0, 1, 9, 11, 181, 600, -30, 30.5, Number.NaN]) expect(isTimeLimit(minutes)).toBe(false);
  });

  it("is off unless chosen, and is not part of the settings the questions are chosen by", () => {
    const base = { length: "10", difficulty: "MIXED", topics: [] as string[] };
    const untimed = parseMockExamConfig(base);
    const timed = parseMockExamConfig({ ...base, timeLimit: " 30 " });
    expect(untimed).toMatchObject({ ok: true, timeLimitMinutes: null });
    expect(parseMockExamConfig({ ...base, timeLimit: "" })).toMatchObject({ ok: true, timeLimitMinutes: null });
    expect(timed).toMatchObject({ ok: true, timeLimitMinutes: 30 });
    expect(timed.ok && untimed.ok && timed.config).toEqual(untimed.ok && untimed.config);
  });

  it.each(["7", "0", "181", "-30", "30.5", "abc", "1e2", "30 minutes", "9999"])("refuses the time limit %j", timeLimit => {
    expect(parseMockExamConfig({ length: "10", difficulty: "MIXED", topics: [], timeLimit })).toEqual({ ok: false, error: "time_limit_invalid" });
  });

  it("suggests about three minutes a question, from the offered limits", () => {
    expect([3, 5, 10, 15, 20, 30, 50].map(suggestedTimeLimit)).toEqual([10, 15, 30, 45, 60, 90, 180]);
    expect(suggestedTimeLimit(Number.NaN)).toBe(10);
    expect(suggestedTimeLimit(500)).toBe(180);
  });

  it("names a limit in minutes or hours", () => {
    expect([10, 45, 60, 90, 120, 180].map(timeLimitLabel)).toEqual(["10 minutes", "45 minutes", "1 hour", "90 minutes", "2 hours", "3 hours"]);
    expect(mockExamMessage("time_limit_invalid")).toBe("Choose a time limit from the list (10 to 180 minutes), or no time limit.");
  });
});

describe("the deadline", () => {
  it("is the start plus the limit", () => {
    expect(deadline.toISOString()).toBe("2026-11-16T10:30:00.000Z");
  });

  it("gives the time left from the server's time, never below zero", () => {
    expect(timeLeftMs(deadline, start)).toBe(30 * 60_000);
    expect(timeLeftMs(deadline, at(-1))).toBe(1);
    expect(timeLeftMs(deadline, at(0))).toBe(0);
    expect(timeLeftMs(deadline, at(60_000))).toBe(0);
  });

  it("accepts a save until five seconds after the deadline, and not a millisecond later", () => {
    expect(MOCK_EXAM_GRACE_MS).toBe(5_000);
    expect(acceptsSave(deadline, at(-1))).toBe(true);
    expect(acceptsSave(deadline, at(0))).toBe(true);
    expect(acceptsSave(deadline, at(4_999))).toBe(true);
    expect(acceptsSave(deadline, at(5_000))).toBe(true);
    expect(acceptsSave(deadline, at(5_001))).toBe(false);
    expect(isExpired(deadline, at(5_000))).toBe(false);
    expect(isExpired(deadline, at(5_001))).toBe(true);
  });

  it("never ends an untimed exam", () => {
    const farFuture = new Date("2099-01-01T00:00:00Z");
    expect(acceptsSave(null, farFuture)).toBe(true);
    expect(isExpired(null, farFuture)).toBe(false);
    expect(finishesNow(null, farFuture)).toBe(false);
  });

  it("lets the final save end the exam only when the server's time is at the deadline", () => {
    expect(FINISH_TOLERANCE_MS).toBe(2_000);
    expect(finishesNow(deadline, at(-2_001))).toBe(false);
    expect(finishesNow(deadline, at(-2_000))).toBe(true);
    expect(finishesNow(deadline, at(0))).toBe(true);
    expect(finishesNow(deadline, at(4_000))).toBe(true);
    expect(finishesNow(deadline, start)).toBe(false);
  });

  it("gives the database the oldest deadline that is still open", () => {
    const now = at(3_000);
    expect(oldestOpenDeadline(now).getTime()).toBe(now.getTime() - 5_000);
    // A deadline is open exactly when it is not older than that.
    expect(deadline >= oldestOpenDeadline(at(5_000))).toBe(true);
    expect(deadline >= oldestOpenDeadline(at(5_001))).toBe(false);
  });
});

describe("the countdown", () => {
  it("shows minutes and seconds, and hours from an hour up", () => {
    expect(formatTimeLeft(30 * 60_000)).toBe("30:00");
    expect(formatTimeLeft(9 * 60_000 + 5_000)).toBe("9:05");
    expect(formatTimeLeft(59_000)).toBe("0:59");
    expect(formatTimeLeft(3 * 3600_000)).toBe("3:00:00");
    expect(formatTimeLeft(3723_000)).toBe("1:02:03");
  });

  it("reads 0:00 only when the time is up", () => {
    expect(formatTimeLeft(1)).toBe("0:01");
    expect(formatTimeLeft(999)).toBe("0:01");
    expect(formatTimeLeft(0)).toBe("0:00");
    expect(formatTimeLeft(-5_000)).toBe("0:00");
  });

  it("warns at five minutes and is urgent at one", () => {
    expect(timerLevel(5 * 60_000 + 1)).toBe("normal");
    expect(timerLevel(5 * 60_000)).toBe("warning");
    expect(timerLevel(60_001)).toBe("warning");
    expect(timerLevel(60_000)).toBe("urgent");
    expect(timerLevel(0)).toBe("urgent");
  });

  it("tells a screen reader only at five minutes, one minute and zero, never every second", () => {
    expect(crossedWarning(300_250, 300_000)).toBe("5 minutes left.");
    expect(crossedWarning(60_100, 59_850)).toBe("1 minute left.");
    expect(crossedWarning(200, 0)).toBe("Time is up.");
    // Every other tick says nothing.
    let said = 0;
    for (let ms = 10 * 60_000; ms > 0; ms -= 250) if (crossedWarning(ms, ms - 250)) said++;
    expect(said).toBe(3);
    expect(crossedWarning(300_000, 299_750)).toBeNull();
    expect(crossedWarning(0, 0)).toBeNull();
    // A tab that slept through several warnings says the latest one.
    expect(crossedWarning(400_000, 30_000)).toBe("1 minute left.");
    expect(crossedWarning(400_000, 0)).toBe("Time is up.");
    // Time gained back from the server's answer says nothing.
    expect(crossedWarning(50_000, 70_000)).toBeNull();
  });

  it("says that time ran out differently from a normal submit", () => {
    expect(TIME_UP_NOTICE).toBe("Time is up — your answers were submitted automatically.");
    expect(sittingMessage("time_up")).toBe(TIME_UP_NOTICE);
    expect(sittingMessage("already_submitted")).not.toBe(TIME_UP_NOTICE);
    expect(sittingMessage("not_started")).toBe("Start the exam before you answer.");
  });
});
