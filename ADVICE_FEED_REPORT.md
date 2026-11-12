# Course advice feed (US-38) - Sprint 4

Mohammed Al-Haiqi (M4). Cross-tester: Mustafa Ergaibi (M1).

**Story.** As a student, I browse a course's advice from previous students. **Tester's check (sprint plan):** the feed displays only relevant visible advice with the correct course and scope.

## What changed

| Area | Change |
| --- | --- |
| Schema | New `Advice` model with `AdviceScope` (`COURSE`, `EXAM`, `SESSION`, `TOPIC`, `QUESTION`) and `AdviceStatus` (`VISIBLE`, `REMOVED`); migration `20261112000000_advice` (new table only, nothing else changes) |
| Service | `lib/advice.ts`: `visibleCourseAdvice(courseId)`, `toAdviceItem(row)`, `getCourseAdvice(courseId, page)`, the feed cache with `invalidateCourseAdvice(courseId)`, and the read limit `allowAdviceFeedRead(userId)` |
| Rules | `lib/advice-rules.ts`: author line, scope label, `https`-only resources, page clamping, date format |
| Page | `/courses/:courseId/advice` (`app/courses/[courseId]/advice/page.tsx`) with `components/advice-list.tsx`; a "Student Advice" card on the course page |
| Monitoring and logs | `advice_feed` (database read) and `advice_feed_cached` timings (`operation_timed`, plus `slow_operation` over 1 s, which shows on `/admin/monitoring`); events `advice_feed_retrieval_failed` (error) and `advice_feed_rate_limited` (warn) |
| Load and availability | `npm run load -- advice-feed`; the feed added to `npm run availability` with its own correctness check |
| Docs | README: route, events, and a new "Advice from previous students" section |

## The Advice model is the proposed shared contract for E3

US-38 reads advice that US-34 (Ali Shammakh, publishing) writes, and US-34 has not started yet. So this PR adds the smallest model that covers every advice story in the Sprint 4 plan, for Ali to build publishing on instead of making a second one:

| Field | For |
| --- | --- |
| `courseId`, `body`, `createdAt` | Every story |
| `scope` + `fileId` / `termId` / `topic` / `questionGroupId` | US-34 (scoped advice), US-38, US-39 (search by topic, exam, session) |
| `authorId`, `anonymous` | US-34, US-36 (only the author edits), US-37 (anonymous) |
| `resourceUrl` | US-35 |
| `status`, `removedAt`, `removedById` | US-36 (delete), US-77 (admin removal) |
| `editedAt` | US-36 |

Ratings (US-40), comments (US-41), and reports (US-43) will be their own tables pointing at `Advice.id`.

**Assumption to confirm:** the plan's "session" scope is read as a term (`Term`, for example "Fall 2024"). If the team means something else (for example an exam sitting such as "Final, Fall 2024"), `termId` is the only field to change.

**For every story that writes advice (US-34, US-36, US-77, ...):** call `invalidateCourseAdvice(courseId)` after the write, or the change shows only when the cached page expires (30 s). Publishing (US-34) should also check that a scope's target belongs to the advice's course; the feed defends against it anyway (rule 2), but such advice would silently not appear.

## Rules the feed follows

1. Only `VISIBLE` advice of the requested course is shown. `REMOVED` advice is never shown.
2. Advice whose exam paper or question belongs to **another course** is left out entirely (bad data; publishing should refuse it).
3. Advice whose target was **deleted** (the foreign key is set to null), or whose exam paper is **pending, rejected, or not an exam**, is shown as course advice with "(what it was about is no longer available)". The target is not named, so an unpublished paper's title never leaks.
4. An **anonymous** author is "Anonymous student". The service drops the name before anything reaches the page, and no author ID is ever handed to the page. A deleted account is "Former student".
5. A resource is shown only if it is an `https` URL without a username or password, opening in a new tab with `rel="noopener noreferrer nofollow"`. `javascript:`, `data:`, `http:`, relative links, and the rest are not shown.
6. Text is rendered as text (React escapes it); line breaks are kept.
7. Newest first; ties broken by ID, so the pages never repeat or skip an advice. 20 per page; an invalid page shows page 1 and a page past the end shows the last page.
8. The page needs a session (it is other students' writing); a visitor is sent to log in and back. An unknown course is a 404.
9. Every item is labelled "Student advice", and the page says it is student opinion, not statistics from previous exams (this also helps US-42).

## The course checklist applied to this feature

| Item | What this feature does |
| --- | --- |
| **Load testing** (how many users) | `npm run load -- advice-feed`: 500 pieces of advice, steps of 1 to 100 concurrent users, reports the highest step with p99 within 1 s. Results below |
| **Availability and reliability** | The feed is one of the APIs in `npm run availability`. Availability = successful / total requests per API and stage; reliability also requires correct content and latency within 1 s. "Correct" here means the course's visible advice is shown, and the removed advice, another course's advice, and the anonymous author's name are not. Results below |
| **Clearing stored requests** | Not applicable: reading the feed stores nothing per request (no rows, no files). The cache is in memory, limited in size, and expires on its own after 30 s |
| **Automated browser tests** (Selenium-like) | Playwright: 8 end-to-end tests against the production build (`tests/e2e/advice-feed.spec.ts`) |
| **Responsiveness, 100 ms to 1 s, shown by the logs** | Every read prints one `operation_timed` JSON line (`advice_feed` or `advice_feed_cached`, with `durationMs`); anything over 1 s is also logged as `slow_operation` and shows on `/admin/monitoring`. The load report reads these lines |
| **Monitoring** | `advice_feed_retrieval_failed` (error) and `advice_feed_rate_limited` (warn) are saved and shown on `/admin/monitoring`; IDs only, never advice text or names |
| **Logs** | As above; the logger's sanitizer also drops sensitive keys and cuts long values |
| **Caching** | Feed pages are cached in memory for 30 s (`ADVICE_FEED_CACHE_SECONDS`), at most 50 pages per course and 500 courses; writers call `invalidateCourseAdvice`. A cached read takes under 1 ms on the server |
| **Security testing: DoS** | At most 120 feed reads per student per minute (`ADVICE_FEED_RATE_LIMIT_PER_MINUTE`); past it, the page says so without touching the database. Tested end to end: a student fetching 125 pages in a row gets the limit message from read 121 on, while another student is still served. Page numbers are clamped, and walking page numbers cannot grow the cache without bound |

## Tests

| Suite | File | Tests | Result |
| --- | --- | ---: | --- |
| Unit: rules | `tests/unit/advice-rules.test.ts` | 26 | pass |
| Unit: service, cache, read limit (mocked database) | `tests/unit/advice.test.ts` | 17 | pass |
| Unit: pages | `tests/unit/advice-pages.test.tsx` | 11 | pass |
| Integration (real PostgreSQL) | `tests/integration/advice-feed.test.ts` | 7 | pass |
| End-to-end (production build) | `tests/e2e/advice-feed.spec.ts` | 8 | pass |

The integration test was also run with the other-course guard removed from `visibleCourseAdvice`: it failed, so the test really checks rule 2.

What the tests cover, by rule: course isolation and removed advice (1), another course's exam paper and question (2), a deleted paper, a pending paper, a deleted account (3, 4), anonymity checked in the service output and in the page's whole HTML, including author IDs (4), `https` and unsafe links (5), `<script>` in the text (6), 41 advice over 3 pages each shown once, page 99 and `abc` (7), the login redirect and the 404 (8), and the labels (9). The cache: hits per course and page, invalidation of one course only, expiry after 30 s, turned off with 0, failed reads never cached, at most 50 pages per course, and on the real database that removed advice disappears once the writer invalidates. The read limit: 120 allowed, the 121st refused and logged with the student's ID only, students counted apart. All test data is deleted at the end; a count after the runs found none left.

## Full check results (local, 2026-11-12)

| Check | Result |
| --- | --- |
| `npm test` | 68 files, 1,053 tests pass |
| `npm run lint` | clean |
| `npx tsc --noEmit` | clean |
| `npm run build` | pass (built by the e2e run) |
| `npm run test:integration` | 11 files, 102 tests pass |
| `npm run test:e2e` (`--workers=2`, `APP_URL=http://127.0.0.1:3000` as in CI) | 98 of 98 pass |

Without `APP_URL` (the local `.env` has none), `password-reset.spec.ts:73` fails because no reset link can be built; CI sets it. One earlier full run also had `study-progress.spec.ts:92` time out under load; it passed alone and in the final run.

## Load (`npm run load -- advice-feed`)

Logged-in students open page 1 of a course with 500 pieces of advice of every scope (a tenth anonymous, a tenth removed). Target: 99% of responses within 1 s, no errors.

**First run, before the cache, with the machine at normal load:**

| Users | Requests | Req/s | p50 ms | p99 ms | Errors | Server `advice_feed` p95 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 299 | 29.9 | 31 | 64 | 0 | 25 |
| 10 | 668 | 66.8 | 144 | 345 | 0 | 57 |
| 25 | 739 | 73.9 | 316 | 706 | 0 | 108 |
| 50 | 800 | 80.0 | 612 | 709 | 0 | 140 |

The target was met up to 50 concurrent users, the highest step of that run.

**Later runs, cache on and off, with the machine busy.** During these runs the laptop's CPU was at about 75% with nothing of ours running (SQL Server, WMI, and Defender). Every page in the app slowed down the same way, so these end-to-end latencies measure the machine, not the feed. The target was met at 10 users in both runs, with 0 errors at every step up to 100 users. The server's own timings from the log still show what the cache does:

| Users | Cache on: database reads / cached reads | Cache on: cached read p95 | Cache off: database read p95 |
| ---: | --- | ---: | ---: |
| 1 | 0 / 158 | 0 ms | 38 ms |
| 10 | 0 / 217 | 0 ms | 225 ms |
| 25 | 25 / 210 (the page expired once) | 0 ms | 515 ms |
| 50 | 0 / 250 | 0 ms | 1,348 ms |
| 100 | 0 / 249 | 0 ms | 1,090 ms |

With the cache, one database read serves every student for 30 s. Without it, the database time grows with the number of users and passes 1 s at 50. These runs should be repeated on a quiet machine before quoting a user count.

## Availability (`npm run availability`)

All of the app's student APIs mixed like a student's visit, the advice feed among them, 20 s per stage, the same busy machine:

| Users | Requests (all APIs) | Availability | Failed | Advice feed: requests / available / wrong content | Advice feed p99 ms |
| ---: | ---: | ---: | ---: | --- | ---: |
| 1 | 189 | 100.000% | 0 | 20 / 20 / 0 | 863 |
| 10 | 307 | 100.000% | 0 | 24 / 24 / 0 | 1,208 |
| 25 | 416 | 100.000% | 0 | 30 / 30 / 0 | 2,242 |
| 50 | 517 | 100.000% | 0 | 48 / 48 / 0 | 3,144 |
| 100 | 542 | 100.000% | 0 | 49 / 49 / 0 | 7,309 |

- **Availability** was 100% at every stage, for the feed and for the whole app: 1,971 requests with no timeout, connection error, or 5xx. With this many requests that proves at least about 99.4% (the 95% lower bound at 100 users). More users and longer runs are what make a figure like 99.99% measurable.
- **Correctness:** the feed never showed wrong content (no removed advice, no other course's advice, no anonymous author's name).
- **Reliability** (correct and within 1 s) fell as users grew, the same for every API: the whole app levelled off at about 27 requests a second on the busy machine, so more users meant more waiting. Recovery after the 100-user stage took 1.2 s.
- A first availability run marked every feed reply as wrong content. That was a mistake in the run's own test data (the named and the anonymous advice had the same author, so that name was rightly on the page), not in the app. It was fixed before the run above.

## Shared files touched

- `prisma/schema.prisma`: the new model and enums, plus one back-relation line each on `User` (2), `Course`, `Term`, `CourseFile`, and `QuestionGroup`. No existing field changed.
- `lib/logger.ts`: two new events.
- `app/courses/[courseId]/page.tsx`: one new card.
- `tests/availability/run.ts`: the feed added to the mix (its advice is created in the seeded courses and deleted by its stamp at the end).
- `README.md`: route, events, and the new section.

## How to try it (no publishing form until US-34)

Advice can be added in Prisma Studio (`npx prisma studio`, table `Advice`) or with a small script. For example, after `npm run db:seed`, save this as `add-advice.ts` in the project folder (do not commit it) and run `npx tsx add-advice.ts`:

```ts
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
async function main() {
  const author = await db.user.findFirstOrThrow(); // any account, for example the seeded admin
  await db.advice.create({ data: { courseId: "course-eece350", authorId: author.id, body: "Do every past final twice." } });
  await db.advice.create({ data: { courseId: "course-eece350", authorId: author.id, anonymous: true, body: "Routing is on every final.", scope: "TOPIC", topic: "Routing" } });
}
main().finally(() => db.$disconnect());
```

Then log in and open the course's "Student Advice".

## Left open

- The schema needs Ali Shammakh's agreement (US-34 owner), and the "session = term" reading needs the team's.
- Filters and search are US-39 (Ali Shammakh); ratings and their sort order are US-40 (Lea Tass). The feed is newest first until then.
- Editing and deleting your own advice (US-36), reporting (US-43), and moderation (US-77) are my next PRs and build on this one.
