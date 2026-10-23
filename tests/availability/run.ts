import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { actionIdFor, Client, type Reply } from "../reliability/client";
import { cleanUp, storageRoot } from "../reliability/data";
import { createRng, type Rng } from "../reliability/rng";
import {
  capacity, classify, degradation, lowerBound95, nines, summarizeStage, yearlyDowntime, type Outcome, type Sample, type StageResult,
} from "./metrics";

// npm run availability: availability and reliability of every API as the number of concurrent users grows.
// It builds and starts the production app, then runs a realistic mix of student requests (catalog search, course pages,
// exam lists, question bank, ordered exam, opening files, My Courses, profile, logging in, adding a course) with 1, 10, 25,
// 50, and 100 users at once. Every request is recorded per API as available or not (timeout, connection error, 5xx, or an
// unexpected status), correct or not, and how long it took. The report compares availability, error rates, latency
// percentiles, throughput, timeouts, and error types across the user counts, with machine CPU, server memory, database
// connections, and the recovery time after the heaviest stage. It writes reports/availability-<date>.md and .json and deletes
// everything it created. It needs a migrated, seeded database and a free port 3000.
//
// AVAILABILITY_STAGES (default "1,10,25,50,100") users per stage, AVAILABILITY_SECONDS (default 20) per stage,
// AVAILABILITY_TIMEOUT_MS (default 10000) per request, AVAILABILITY_LATENCY_MS (default 1000) the latency target,
// AVAILABILITY_TARGET (default 0.999), AVAILABILITY_THINK_MS (default 0) pause between a user's requests,
// AVAILABILITY_SEED for a repeatable mix, AVAILABILITY_SKIP_BUILD=1 to start the last build without rebuilding.

try {
  process.loadEnvFile?.(".env");
} catch {
  // No .env file; rely on the environment.
}

const PORT = 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const number = (name: string, fallback: number) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
const STAGES = (process.env.AVAILABILITY_STAGES ?? "1,10,25,50,100").split(",").map(Number).filter(value => Number.isInteger(value) && value > 0);
const SECONDS = number("AVAILABILITY_SECONDS", 20);
const TIMEOUT_MS = number("AVAILABILITY_TIMEOUT_MS", 10_000);
const LATENCY_MS = number("AVAILABILITY_LATENCY_MS", 1000);
const TARGET = Number(process.env.AVAILABILITY_TARGET) > 0 && Number(process.env.AVAILABILITY_TARGET) <= 1 ? Number(process.env.AVAILABILITY_TARGET) : 0.999;
const THINK_MS = Number(process.env.AVAILABILITY_THINK_MS) >= 0 ? Number(process.env.AVAILABILITY_THINK_MS) : 0;
const SEED = Number(process.env.AVAILABILITY_SEED) >= 0 && process.env.AVAILABILITY_SEED ? Number(process.env.AVAILABILITY_SEED) : Math.floor(Math.random() * 2 ** 31);
const PASSWORD = "availability-pass-123";

type Course = { id: string; code: string };
type User = { id: string; email: string; name: string; client: Client };
type World = { courses: Course[]; files: string[]; users: User[]; actions: { logIn: string; addCourse: string } };
type Api = { name: string; weight: number; run(user: User, world: World, rng: Rng): Promise<{ reply: Reply; expected: number[]; correct: boolean }> };

// The mix of requests, weighted like a student's visit: mostly reading, some logging in and adding courses.
const APIS: Api[] = [
  { name: "GET / (catalog search)", weight: 15, async run(user, world, rng) {
    const course = rng.pick(world.courses);
    const reply = await user.client.get(`/?q=${encodeURIComponent(course.code)}`, TIMEOUT_MS);
    return { reply, expected: [200], correct: reply.body.includes(course.code) };
  } },
  { name: "GET /courses/:courseId", weight: 15, async run(user, world, rng) {
    const course = rng.pick(world.courses);
    const reply = await user.client.get(`/courses/${course.id}`, TIMEOUT_MS);
    return { reply, expected: [200], correct: reply.body.includes(course.code) };
  } },
  { name: "GET /courses/:courseId/exams", weight: 10, async run(user, world, rng) {
    const course = rng.pick(world.courses);
    const reply = await user.client.get(`/courses/${course.id}/exams`, TIMEOUT_MS);
    return { reply, expected: [200], correct: reply.body.includes("Previous Exams") && reply.body.includes(course.code) };
  } },
  { name: "GET /courses/:courseId/questions", weight: 10, async run(user, world, rng) {
    const course = rng.pick(world.courses);
    const reply = await user.client.get(`/courses/${course.id}/questions`, TIMEOUT_MS);
    return { reply, expected: [200], correct: reply.body.includes("Question Bank") && reply.body.includes(course.code) };
  } },
  { name: "GET /courses/:courseId/exam", weight: 10, async run(user, world, rng) {
    const course = rng.pick(world.courses);
    const reply = await user.client.get(`/courses/${course.id}/exam`, TIMEOUT_MS);
    return { reply, expected: [200], correct: reply.body.includes("Upcomer Exam") && reply.body.includes(course.code) };
  } },
  { name: "GET /files/:fileId", weight: 10, async run(user, world, rng) {
    const reply = await user.client.get(`/files/${rng.pick(world.files)}`, TIMEOUT_MS);
    return { reply, expected: [200], correct: reply.contentType.includes("pdf") && reply.bytes.subarray(0, 5).toString("latin1") === "%PDF-" };
  } },
  { name: "GET /my-courses", weight: 10, async run(user) {
    const reply = await user.client.get("/my-courses", TIMEOUT_MS);
    return { reply, expected: [200], correct: reply.body.includes("My Courses") };
  } },
  { name: "GET /profile", weight: 5, async run(user) {
    const reply = await user.client.get("/profile", TIMEOUT_MS);
    return { reply, expected: [200], correct: reply.body.includes("My Profile") && reply.body.includes(user.name) };
  } },
  // A fresh client, so the user's own session stays as it is.
  { name: "POST /login (log in)", weight: 5, async run(user, world) {
    const reply = await new Client(BASE_URL).postAction("/login", world.actions.logIn, { email: user.email, password: PASSWORD }, TIMEOUT_MS);
    return { reply, expected: [303], correct: reply.location === "/my-courses" };
  } },
  { name: "POST /courses/:courseId (add to My Courses)", weight: 10, async run(user, world, rng) {
    const course = rng.pick(world.courses);
    const reply = await user.client.postAction(`/courses/${course.id}`, world.actions.addCourse, { courseId: course.id }, TIMEOUT_MS);
    return { reply, expected: [303], correct: [`/courses/${course.id}?added=1`, `/courses/${course.id}?added=already`].includes(reply.location) };
  } },
];

const pickApi = (rng: Rng) => {
  let roll = rng.int(1, APIS.reduce((sum, api) => sum + api.weight, 0));
  for (const api of APIS) if ((roll -= api.weight) <= 0) return api;
  return APIS[0];
};

async function request(api: Api, user: User, world: World, rng: Rng): Promise<Sample> {
  const started = performance.now();
  try {
    const { reply, expected, correct } = await api.run(user, world, rng);
    const outcome = classify(reply, expected, correct, LATENCY_MS);
    return { api: api.name, outcome, ms: reply.ms, status: reply.status, at: Date.now(), detail: reply.location ? `${reply.status} -> ${reply.location}` : String(reply.status) };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    const outcome: Outcome = timedOut ? "timeout" : "network";
    return { api: api.name, outcome, ms: performance.now() - started, status: 0, at: Date.now(), detail: error instanceof Error ? `${error.name}: ${(error.cause as Error | undefined)?.message ?? error.message}`.slice(0, 120) : "unknown" };
  }
}

// Machine CPU (all processes, so other programs count too), the server's memory, and the database's open connections.
type Resources = { cpuPercent: number; serverMemoryMb: number | null; dbConnections: number | null };

function cpuTimes() {
  return os.cpus().reduce((sum, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    return { idle: sum.idle + cpu.times.idle, total: sum.total + total };
  }, { idle: 0, total: 0 });
}

function serverMemoryMb(): number | null {
  try {
    if (process.platform === "win32") {
      const line = execSync(`netstat -ano -p tcp`, { encoding: "utf8" }).split(/\r?\n/).find(row => row.includes(`:${PORT} `) && row.includes("LISTENING"));
      const pid = line?.trim().split(/\s+/).at(-1);
      if (!pid) return null;
      const csv = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: "utf8" });
      const kb = Number(csv.split('","').at(-1)?.replace(/[^\d]/g, ""));
      return kb ? Math.round(kb / 1024) : null;
    }
    const pid = execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN`, { encoding: "utf8" }).trim().split("\n")[0];
    const kb = Number(execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8" }).trim());
    return kb ? Math.round(kb / 1024) : null;
  } catch {
    return null;
  }
}

async function sampleResources(db: PrismaClient, previous: ReturnType<typeof cpuTimes>) {
  const now = cpuTimes();
  const cpuPercent = now.total > previous.total ? 100 * (1 - (now.idle - previous.idle) / (now.total - previous.total)) : 0;
  let dbConnections: number | null = null;
  try {
    const rows = await db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`;
    // Minus this tool's own connection.
    dbConnections = Math.max(0, (rows[0]?.n ?? 1) - 1);
  } catch {
    // Not allowed to read pg_stat_activity; reported as unknown.
  }
  return { sample: { cpuPercent, serverMemoryMb: serverMemoryMb(), dbConnections } satisfies Resources, times: now };
}

const max = (values: Array<number | null>) => {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? Math.max(...known) : null;
};

type StageRecord = StageResult & { resources: { cpuAverage: number; cpuMax: number; serverMemoryMaxMb: number | null; dbConnectionsMax: number | null }; maxInFlight: number };

async function runStage(users: number, world: World, db: PrismaClient): Promise<StageRecord> {
  const samples: Sample[] = [];
  const resources: Resources[] = [];
  let inFlight = 0, maxInFlight = 0;
  const ends = Date.now() + SECONDS * 1000;
  let times = cpuTimes();
  const sampler = setInterval(async () => {
    const result = await sampleResources(db, times);
    times = result.times;
    resources.push(result.sample);
  }, 1000);
  await Promise.all(world.users.slice(0, users).map(async (user, index) => {
    const userRng = createRng(SEED + users * 1000 + index);
    while (Date.now() < ends) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      samples.push(await request(pickApi(userRng), user, world, userRng));
      inFlight--;
      if (THINK_MS) await new Promise(resolve => setTimeout(resolve, THINK_MS));
    }
  }));
  clearInterval(sampler);
  const seconds = SECONDS;
  const cpu = resources.map(item => item.cpuPercent);
  return {
    users, seconds, ...summarizeStage(samples, seconds), maxInFlight,
    resources: {
      cpuAverage: cpu.length ? cpu.reduce((a, b) => a + b, 0) / cpu.length : 0, cpuMax: cpu.length ? Math.max(...cpu) : 0,
      serverMemoryMaxMb: max(resources.map(item => item.serverMemoryMb)), dbConnectionsMax: max(resources.map(item => item.dbConnections)),
    },
  };
}

// After the heaviest stage: how long until the app answers normally again (5 correct, fast replies in a row), up to 60 s.
async function recoveryTime(world: World) {
  const started = Date.now();
  let streak = 0;
  const user = world.users[0];
  while (Date.now() - started < 60_000) {
    const sample = await request(APIS[1], user, world, createRng(SEED));
    streak = sample.outcome === "ok" ? streak + 1 : 0;
    if (streak === 5) return Date.now() - started;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

const portInUse = () => new Promise<boolean>(resolve => {
  const socket = net.connect(PORT, "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});

function startServer(logFile: string) {
  const log = createWriteStream(logFile);
  const command = `${process.env.AVAILABILITY_SKIP_BUILD === "1" ? "" : "npm run build && "}npx next start --port ${PORT}`;
  // Logs are not saved to the database during the run, so the run itself does not change what it measures.
  const server = spawn(command, { shell: true, detached: process.platform !== "win32", env: { ...process.env, LOG_PERSIST: "off" }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.pipe(log);
  server.stderr?.pipe(log);
  return server;
}

async function waitForServer(server: ChildProcess) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`The app exited with code ${server.exitCode} before it was ready; see the server log.`);
    try {
      if ((await fetch(BASE_URL, { redirect: "manual" })).status < 500) return;
    } catch {
      // Not listening yet.
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("The app did not start within 5 minutes; see the server log.");
}

function stopServer(server: ChildProcess) {
  if (server.exitCode !== null || !server.pid) return;
  if (process.platform === "win32") execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" });
  else process.kill(-server.pid, "SIGTERM");
}

// Stamped students with sessions made directly in the database the way login does, so setup does not load the server.
async function createUsers(db: PrismaClient, stamp: string, count: number): Promise<User[]> {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const users: User[] = [];
  for (let index = 0; index < count; index++) {
    const email = `${stamp.toLowerCase()}-${index}@availability.test`;
    const name = `${stamp} Student ${index}`;
    const user = await db.user.create({ data: { email, name, passwordHash }, select: { id: true } });
    const token = randomBytes(32).toString("hex");
    await db.session.create({ data: { userId: user.id, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000) } });
    const client = new Client(BASE_URL);
    client.setSession(token);
    users.push({ id: user.id, email, name, client });
  }
  return users;
}

const pct = (value: number, digits = 3) => `${(value * 100).toFixed(digits)}%`;
const ms = (value: number) => `${Math.round(value)}`;
const ninesText = (value: number) => (Number.isFinite(nines(value)) ? nines(value).toFixed(1) : "no failures");

function report(stages: StageRecord[], recoveryMs: number | null, meta: { date: string; commit: string; seed: number }) {
  const supported = capacity(stages, TARGET, LATENCY_MS);
  const lines = [
    `# Availability and reliability (${meta.date})`, "",
    `- **Commit:** \`${meta.commit}\`; seed \`${meta.seed}\` (repeat with \`AVAILABILITY_SEED=${meta.seed}\`)`,
    `- **Workload:** ${APIS.length} APIs mixed like a student's visit, ${SECONDS} s per stage, ${THINK_MS} ms between a user's requests, ${TIMEOUT_MS} ms timeout per request.`,
    `- **Targets:** availability of at least ${pct(TARGET, 2)} for every API and an overall p99 within ${LATENCY_MS} ms.`,
    `- **Result:** up to **${supported}** concurrent users meet both targets${supported === stages.at(-1)?.users ? " (the highest stage tested)" : ""}.`,
    `- **Recovery after the heaviest stage:** ${recoveryMs === null ? "**not within 60 s**" : `${(recoveryMs / 1000).toFixed(1)} s to 5 normal replies in a row`}.`, "",
    "Availability = successful requests / total requests. A request is unavailable when it times out, the connection fails, the server answers 5xx, or it answers a status the API never gives for that request. Reliability counts only requests that were also correct (the page showed what it should) and within the latency target.", "",
    "## By number of users", "",
    "| Users | Requests | Req/s | Availability | 95% lower bound | Nines | Failed | Timeouts | Reliability | p50 ms | p95 ms | p99 ms | Max ms | Machine CPU avg / max | Server memory | DB connections | Max in flight |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |",
    ...stages.map(stage => {
      const all = stage.overall;
      return `| ${stage.users} | ${all.total} | ${all.throughput.toFixed(1)} | ${pct(all.availability)} | ${pct(lowerBound95(all.successful, all.total))} | ${ninesText(all.availability)} | ${all.failed} | ${all.timeouts} | ${pct(all.reliability, 1)} | ${ms(all.latency.p50)} | ${ms(all.latency.p95)} | ${ms(all.latency.p99)} | ${ms(all.latency.max)} | ${stage.resources.cpuAverage.toFixed(0)}% / ${stage.resources.cpuMax.toFixed(0)}% | ${stage.resources.serverMemoryMaxMb ?? "?"} MB | ${stage.resources.dbConnectionsMax ?? "?"} | ${stage.maxInFlight} |`;
    }),
    "", "The 95% lower bound is the availability this many requests can actually show: with no failure in N requests it is about 1 - 3/N, so 1,000 clean requests prove at least 99.7%, not 100%. More users send more requests, which is what makes a high availability measurable at all.", "",
    "## What changed as users grew", "",
    "| API | Availability, fewest users | Availability, most users | p99, fewest users (ms) | p99, most users (ms) | Failures that appeared only under more load |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...degradation(stages).map(item => `| ${item.api} | ${item.firstAvailability === null ? "-" : pct(item.firstAvailability)} | ${item.lastAvailability === null ? "-" : pct(item.lastAvailability)} | ${item.firstP99 === null ? "-" : ms(item.firstP99)} | ${item.lastP99 === null ? "-" : ms(item.lastP99)} | ${item.appeared.join(", ") || "-"} |`),
    "", "## Per API at each stage", "",
    ...stages.flatMap(stage => [
      `### ${stage.users} ${stage.users === 1 ? "user" : "users"}`, "",
      "| API | Requests | Successful | Failed | Availability | Error rate | Timeouts | Reliability | p50 ms | p95 ms | p99 ms | Req/s | Error types |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
      ...[...stage.apis, stage.overall].map(api => `| ${api.api === "All APIs" ? "**All APIs**" : api.api} | ${api.total} | ${api.successful} | ${api.failed} | ${pct(api.availability)} | ${pct(api.errorRate)} | ${api.timeouts} | ${pct(api.reliability, 1)} | ${ms(api.latency.p50)} | ${ms(api.latency.p95)} | ${ms(api.latency.p99)} | ${api.throughput.toFixed(1)} | ${Object.entries(api.errorTypes).map(([type, count]) => `${type} ${count}`).join(", ") || "-"} |`),
      ...stage.apis.filter(api => api.examples.length).map(api => `- ${api.api}: ${api.examples.join("; ")}`), "",
    ]),
    "## Availability and downtime", "",
    "| Availability | Downtime per year |", "| ---: | --- |",
    ...[0.99, 0.999, 0.9999, 0.99999].map(value => `| ${pct(value, 3)} | ${yearlyDowntime(value)} |`),
    ...stages.map(stage => `| ${pct(stage.overall.availability)} (measured, ${stage.users} ${stage.users === 1 ? "user" : "users"}) | ${stage.overall.availability >= 1 ? "none seen" : yearlyDowntime(stage.overall.availability)} |`),
    "", "## Reading these numbers", "",
    "Availability does not rise or fall by itself with the number of users. What grows with more users is the number of requests observed, the share of APIs and paths exercised, the concurrency, and the pressure on CPU, memory, and database connections, so rare failures, races, and bottlenecks become visible. Availability can stay stable, or drop once the app reaches its capacity. Machine CPU is for the whole machine, so other programs running at the same time count too.", "",
  ];
  return { markdown: lines.join("\n"), supported };
}

async function main() {
  if (!STAGES.length) throw new Error("AVAILABILITY_STAGES must list whole numbers, for example 1,10,50.");
  if (await portInUse()) throw new Error(`Port ${PORT} is already in use. Stop the dev server (or any app on that port) and run again.`);
  const db = new PrismaClient();
  const stamp = `AV${Date.now().toString(36).toUpperCase()}`;
  const since = new Date();
  const date = new Date().toISOString().slice(0, 10);
  let commit = "";
  try {
    commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    // Not a git checkout.
  }
  await mkdir("reports", { recursive: true });
  const logFile = path.join("reports", `availability-${date}.server.log`);
  console.log(`Building and starting the app (log: ${logFile})…`);
  const server = startServer(logFile);
  try {
    await waitForServer(server);
    const courses = await db.course.findMany({ where: { files: { some: {} } }, select: { id: true, code: true }, orderBy: { code: "asc" } });
    const files = (await db.courseFile.findMany({ where: { status: "PUBLISHED" }, select: { id: true, storageKey: true } }))
      .filter(file => existsSync(path.join(storageRoot(), file.storageKey))).map(file => file.id);
    if (!courses.length || !files.length) throw new Error("No courses with files. Run npm run db:seed first.");
    const users = await createUsers(db, stamp, Math.max(...STAGES));
    const login = await new Client(BASE_URL).get("/login");
    const coursePage = await users[0].client.get(`/courses/${courses[0].id}`);
    const world: World = { courses, files, users, actions: { logIn: actionIdFor(login.body, "Log in"), addCourse: actionIdFor(coursePage.body, "Add to My Courses") } };
    // Each route's first request on a fresh server is slow (code loaded, caches empty); that is start-up, not availability,
    // so every API is called twice before measuring.
    const warmUp = createRng(SEED);
    for (const api of APIS) for (let round = 0; round < 2; round++) await request(api, users[0], world, warmUp);
    const stages: StageRecord[] = [];
    for (const count of STAGES) {
      const stage = await runStage(count, world, db);
      stages.push(stage);
      console.log(`${count} users: ${stage.overall.total} requests, availability ${pct(stage.overall.availability)}, p99 ${ms(stage.overall.latency.p99)} ms, ${stage.overall.failed} failed, reliability ${pct(stage.overall.reliability, 1)}`);
    }
    const recoveryMs = await recoveryTime(world);
    const { markdown, supported } = report(stages, recoveryMs, { date, commit, seed: SEED });
    const base = path.join("reports", `availability-${date}`);
    await writeFile(`${base}.md`, `${markdown}\n`);
    await writeFile(`${base}.json`, `${JSON.stringify({ date, commit, seed: SEED, stages, recoveryMs, supported, settings: { STAGES, SECONDS, TIMEOUT_MS, LATENCY_MS, TARGET, THINK_MS } }, null, 2)}\n`);
    console.log(`Supported concurrent users: ${supported}. Report: ${base}.md`);
  } finally {
    stopServer(server);
    await cleanUp(db, stamp, { uploadedFileIds: [], since });
    await db.$disconnect();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
