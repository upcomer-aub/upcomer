// Availability and reliability numbers for `npm run availability` (tests/availability/run.ts). Pure functions, unit tested.
//
// Availability = successful requests / total requests, per API. A request fails availability when it times out, the connection
// fails, the server answers 5xx, or it answers a status the API never gives for that request (for example a login form that
// errors instead of redirecting). Reliability is broader: an available request must also be correct (the page shows what it
// should) and fast enough (within the latency target) to count as reliable.

export type Outcome = "ok" | "wrong_content" | "slow" | "http_5xx" | "unexpected_status" | "timeout" | "network";
export type Sample = { api: string; outcome: Outcome; ms: number; status: number; at: number; detail?: string };

// Outcomes that make a request unavailable; wrong_content and slow requests were answered, but not reliably.
export const UNAVAILABLE: ReadonlySet<Outcome> = new Set(["http_5xx", "unexpected_status", "timeout", "network"]);

export type ApiStats = {
  api: string; total: number; successful: number; failed: number; availability: number; errorRate: number;
  correct: number; reliable: number; reliability: number; timeouts: number; timeoutRate: number;
  latency: { average: number; p50: number; p95: number; p99: number; max: number }; throughput: number;
  errorTypes: Partial<Record<Outcome, number>>; examples: string[];
};

export const percentile = (sorted: number[], fraction: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] ?? 0;
const ratio = (part: number, whole: number) => (whole === 0 ? 1 : part / whole);

// Classifies one reply. `expected` lists the statuses the API gives for this request; `correct` checks the body when it is one.
export function classify(reply: { status: number; ms: number } | { error: "timeout" | "network" }, expected: number[], correct: boolean, latencyTargetMs: number): Outcome {
  if ("error" in reply) return reply.error;
  if (reply.status >= 500) return "http_5xx";
  if (!expected.includes(reply.status)) return "unexpected_status";
  if (!correct) return "wrong_content";
  return reply.ms > latencyTargetMs ? "slow" : "ok";
}

export function summarize(api: string, samples: Sample[], seconds: number): ApiStats {
  const total = samples.length;
  const failed = samples.filter(sample => UNAVAILABLE.has(sample.outcome)).length;
  const correct = samples.filter(sample => sample.outcome === "ok" || sample.outcome === "slow").length;
  const reliable = samples.filter(sample => sample.outcome === "ok").length;
  const timeouts = samples.filter(sample => sample.outcome === "timeout").length;
  const sorted = samples.map(sample => sample.ms).sort((a, b) => a - b);
  const errorTypes: Partial<Record<Outcome, number>> = {};
  for (const sample of samples) if (sample.outcome !== "ok") errorTypes[sample.outcome] = (errorTypes[sample.outcome] ?? 0) + 1;
  const examples = [...new Set(samples.filter(sample => sample.outcome !== "ok" && sample.outcome !== "slow").map(sample => `${sample.outcome}: ${sample.detail ?? sample.status}`))].slice(0, 3);
  return {
    api, total, successful: total - failed, failed, availability: ratio(total - failed, total), errorRate: total ? failed / total : 0,
    correct, reliable, reliability: ratio(reliable, total), timeouts, timeoutRate: total ? timeouts / total : 0,
    latency: {
      average: total ? sorted.reduce((sum, ms) => sum + ms, 0) / total : 0,
      p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: sorted.at(-1) ?? 0,
    },
    throughput: seconds > 0 ? total / seconds : 0, errorTypes, examples,
  };
}

// Every API of a stage, plus "All APIs".
export function summarizeStage(samples: Sample[], seconds: number) {
  const apis = [...new Set(samples.map(sample => sample.api))].sort();
  return { apis: apis.map(api => summarize(api, samples.filter(sample => sample.api === api), seconds)), overall: summarize("All APIs", samples, seconds) };
}

const MINUTES_PER_YEAR = 365.25 * 24 * 60;

// The downtime per year an availability corresponds to, in words: 99.99% is about 52.6 minutes.
export function yearlyDowntime(availability: number) {
  const minutes = (1 - availability) * MINUTES_PER_YEAR;
  if (minutes < 1) return `${(minutes * 60).toFixed(1)} seconds`;
  if (minutes < 120) return `${minutes.toFixed(1)} minutes`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(2)} hours`;
  return `${(minutes / 60 / 24).toFixed(2)} days`;
}

// "Nines": 99.9% is 3 nines, 99.95% is 3.3. 100% (no failures seen) has no finite number of nines.
export const nines = (availability: number) => (availability >= 1 ? Infinity : -Math.log10(1 - availability));

// The fewest failures that would have been visible: with N requests and no failure, the measurement can only claim
// availability of at least about 1 - 3/N at 95% confidence (the "rule of three"). So 100% over 1,000 requests means >= 99.7%.
export const lowerBound95 = (successful: number, total: number) => {
  if (total === 0) return 0;
  if (successful === total) return 1 - 3 / total;
  // Wilson score lower bound for a proportion.
  const z = 1.96, p = successful / total, n = total;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n);
};

export type StageResult = { users: number; seconds: number; apis: ApiStats[]; overall: ApiStats };

// The most concurrent users at which every API met the availability target and the overall p99 stayed within the latency
// target; 0 if even the first stage missed. Later stages that pass again do not count, since capacity was already exceeded.
export function capacity(stages: StageResult[], availabilityTarget: number, latencyTargetMs: number) {
  let supported = 0;
  for (const stage of stages) {
    const met = stage.apis.every(api => api.availability >= availabilityTarget) && stage.overall.latency.p99 <= latencyTargetMs;
    if (!met) break;
    supported = stage.users;
  }
  return supported;
}

// What changed as users grew: for each API, its availability at the first and last stage and the outcomes that only appeared
// at higher load (failures a small test would never have seen).
export function degradation(stages: StageResult[]) {
  if (stages.length < 2) return [];
  const first = stages[0], last = stages.at(-1)!;
  const apis = [...new Set(stages.flatMap(stage => stage.apis.map(api => api.api)))].sort();
  return apis.map(api => {
    const at = (stage: StageResult) => stage.apis.find(item => item.api === api);
    const seenAtFirst = new Set(Object.keys(at(first)?.errorTypes ?? {}));
    const appeared = [...new Set(stages.slice(1).flatMap(stage => Object.keys(at(stage)?.errorTypes ?? {})))].filter(type => !seenAtFirst.has(type)) as Outcome[];
    return {
      api, firstAvailability: at(first)?.availability ?? null, lastAvailability: at(last)?.availability ?? null,
      firstP99: at(first)?.latency.p99 ?? null, lastP99: at(last)?.latency.p99 ?? null, appeared,
    };
  });
}
