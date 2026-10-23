import { describe, expect, it } from "vitest";
import {
  capacity, classify, degradation, lowerBound95, nines, percentile, summarize, summarizeStage, yearlyDowntime, type Sample, type StageResult,
} from "../availability/metrics";

// npm run availability: the availability and reliability numbers, worked out by hand.

const sample = (api: string, outcome: Sample["outcome"], ms = 100, status = 200): Sample => ({ api, outcome, ms, status, at: 0 });

describe("classify", () => {
  it.each([
    [{ status: 200, ms: 120 }, [200], true, "ok"],
    [{ status: 200, ms: 1500 }, [200], true, "slow"],
    [{ status: 200, ms: 120 }, [200], false, "wrong_content"],
    [{ status: 500, ms: 120 }, [200], true, "http_5xx"],
    [{ status: 404, ms: 120 }, [200], true, "unexpected_status"],
    [{ status: 303, ms: 120 }, [303], true, "ok"],
    [{ error: "timeout" as const }, [200], true, "timeout"],
    [{ error: "network" as const }, [200], true, "network"],
  ])("%j with expected %j and correct %s is %s", (reply, expected, correct, outcome) => expect(classify(reply, expected, correct, 1000)).toBe(outcome));
});

describe("summarize", () => {
  it("counts availability from unavailable outcomes only, and reliability from fast, correct replies only", () => {
    // 10 requests: 6 ok, 1 slow, 1 wrong content (available but unreliable), 1 timeout, 1 5xx (unavailable).
    const samples = [
      ...Array.from({ length: 6 }, (_, index) => sample("GET /x", "ok", 100 + index * 10)),
      sample("GET /x", "slow", 1500), sample("GET /x", "wrong_content", 90),
      sample("GET /x", "timeout", 10_000, 0), sample("GET /x", "http_5xx", 50, 500),
    ];
    const stats = summarize("GET /x", samples, 5);
    expect(stats).toMatchObject({
      total: 10, successful: 8, failed: 2, availability: 0.8, errorRate: 0.2, correct: 7, reliable: 6, reliability: 0.6,
      timeouts: 1, timeoutRate: 0.1, throughput: 2, errorTypes: { slow: 1, wrong_content: 1, timeout: 1, http_5xx: 1 },
    });
    expect(stats.latency).toMatchObject({ p50: 120, p95: 10_000, p99: 10_000, max: 10_000 });
    expect(stats.examples).toEqual(["wrong_content: 200", "timeout: 0", "http_5xx: 500"]);
  });

  it("matches the 99.99% login example: 10 failures in 100,000 requests", () => {
    const samples = [...Array.from({ length: 99_990 }, () => sample("POST /login", "ok")), ...Array.from({ length: 10 }, () => sample("POST /login", "http_5xx", 100, 500))];
    expect(summarize("POST /login", samples, 100).availability).toBeCloseTo(0.9999, 10);
  });

  it("reports an API with no requests as available, not as a division by zero", () => {
    expect(summarize("GET /none", [], 10)).toMatchObject({ total: 0, availability: 1, errorRate: 0, timeoutRate: 0, throughput: 0 });
  });

  it("splits a stage per API and adds the overall line", () => {
    const stage = summarizeStage([sample("B", "ok"), sample("A", "ok"), sample("A", "network", 5, 0)], 1);
    expect(stage.apis.map(api => [api.api, api.availability])).toEqual([["A", 0.5], ["B", 1]]);
    expect(stage.overall).toMatchObject({ api: "All APIs", total: 3, failed: 1 });
  });
});

describe("percentile", () => {
  it("uses the nearest-rank method", () => {
    const sorted = Array.from({ length: 100 }, (_, index) => index + 1);
    expect([percentile(sorted, 0.5), percentile(sorted, 0.95), percentile(sorted, 0.99), percentile(sorted, 1)]).toEqual([50, 95, 99, 100]);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("downtime and nines", () => {
  it.each([[0.99, "3.65 days"], [0.999, "8.77 hours"], [0.9999, "52.6 minutes"], [0.99999, "5.3 minutes"], [0.9999999, "3.2 seconds"]])(
    "%d availability is about %s of downtime a year", (availability, text) => expect(yearlyDowntime(availability)).toBe(text));
  it("counts nines", () => {
    expect(nines(0.999)).toBeCloseTo(3, 10);
    expect(nines(0.9995)).toBeCloseTo(3.3, 1);
    expect(nines(1)).toBe(Infinity);
  });
});

describe("lowerBound95", () => {
  it("uses the rule of three when nothing failed: 1,000 clean requests show at least 99.7%", () => expect(lowerBound95(1000, 1000)).toBeCloseTo(0.997, 10));
  it("is below the measured value when something failed", () => {
    const bound = lowerBound95(99_990, 100_000);
    expect(bound).toBeLessThan(0.9999);
    expect(bound).toBeGreaterThan(0.9998);
  });
  it("is 0 without requests", () => expect(lowerBound95(0, 0)).toBe(0));
});

const stage = (users: number, availability: Record<string, number>, p99: number, errorTypes: Record<string, Partial<Record<Sample["outcome"], number>>> = {}): StageResult => {
  const apis = Object.entries(availability).map(([api, value]) => ({ ...summarize(api, [], 1), api, availability: value, errorTypes: errorTypes[api] ?? {} }));
  return { users, seconds: 1, apis, overall: { ...summarize("All APIs", [], 1), latency: { average: 0, p50: 0, p95: 0, p99, max: 0 } } };
};

describe("capacity and degradation", () => {
  const stages = [
    stage(1, { login: 1, page: 1 }, 200),
    stage(10, { login: 1, page: 0.9995 }, 600, { page: { slow: 3 } }),
    stage(50, { login: 0.98, page: 0.97 }, 2500, { login: { timeout: 40 }, page: { slow: 9, http_5xx: 2 } }),
    stage(100, { login: 1, page: 1 }, 300),
  ];
  it("is the last stage before the first miss, even if a later stage passes again", () => expect(capacity(stages, 0.999, 1000)).toBe(10));
  it("is 0 when the first stage already misses", () => expect(capacity([stage(1, { page: 0.9 }, 100)], 0.999, 1000)).toBe(0));
  it("lists availability at both ends and failures that only showed up under more load", () => {
    expect(degradation(stages)).toEqual([
      { api: "login", firstAvailability: 1, lastAvailability: 1, firstP99: 0, lastP99: 0, appeared: ["timeout"] },
      { api: "page", firstAvailability: 1, lastAvailability: 1, firstP99: 0, lastP99: 0, appeared: ["slow", "http_5xx"] },
    ]);
    expect(degradation(stages.slice(0, 1))).toEqual([]);
  });
});
