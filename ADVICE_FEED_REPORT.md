# Course advice feed (US-38) - Sprint 4

Mohammed Al-Haiqi (M4). Cross-tester: Mustafa Ergaibi (M1).

**Story.** As a student, I browse a course's advice from previous students. **Tester's check (sprint plan):** the feed displays only relevant visible advice with the correct course and scope.

## What changed

| Area | Change |
| --- | --- |
| Schema | New `Advice` model with `AdviceScope` (`COURSE`, `EXAM`, `SESSION`, `TOPIC`, `QUESTION`) and `AdviceStatus` (`VISIBLE`, `REMOVED`); migration `20261112000000_advice` (new table only, nothing else changes) |
| Service | `lib/advice.ts`: `visibleCourseAdvice(courseId)`, `toAdviceItem(row)`, `getCourseAdvice(courseId, page)` |
| Rules | `lib/advice-rules.ts`: author line, scope label, `https`-only resources, page clamping, date format |
| Page | `/courses/:courseId/advice` (`app/courses/[courseId]/advice/page.tsx`) with `components/advice-list.tsx`; a "Student Advice" card on the course page |
| Monitoring | `advice_feed` timing (`operation_timed`, `slow_operation` over 1 s) and the `advice_feed_retrieval_failed` error event |
| Docs | README: route, event, and a new "Advice from previous students" section |

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

**For US-34 (Ali):** check that a scope's target belongs to the advice's course when publishing. The feed defends against it anyway (below), but bad rows would silently disappear from the feed.

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

## Tests

| Suite | File | Tests | Result |
| --- | --- | ---: | --- |
| Unit: rules | `tests/unit/advice-rules.test.ts` | 26 | pass |
| Unit: service (mocked database) | `tests/unit/advice.test.ts` | 9 | pass |
| Unit: pages | `tests/unit/advice-pages.test.tsx` | 10 | pass |
| Integration (real PostgreSQL) | `tests/integration/advice-feed.test.ts` | 7 | pass |
| End-to-end (production build) | `tests/e2e/advice-feed.spec.ts` | 7 | pass |

The integration test was also run with the other-course guard removed from `visibleCourseAdvice`: it failed, so the test really checks rule 2.

What the tests cover, by rule: course isolation and removed advice (1), another course's exam paper and question (2), a deleted paper, a pending paper, a deleted account (3, 4), anonymity checked in the service output and in the page's whole HTML, including author IDs (4), `https` and unsafe links (5), `<script>` in the text (6), 41 advice over 3 pages each shown once, page 99 and `abc` (7), the login redirect and the 404 (8), and the labels (9). All test data is deleted at the end; a count after the runs found none left.

## Full check results (local, 2026-11-12)

| Check | Result |
| --- | --- |
| `npm test` | 68 files, 1,044 tests pass |
| `npm run lint` | clean |
| `npx tsc --noEmit` | clean |
| `npm run build` | pass (built by the e2e run) |
| `npm run test:integration` | 11 files, 102 tests pass |
| `npm run test:e2e` (`--workers=2`) | 91 pass, 2 fail, both outside this feature and both pass when rerun: `password-reset.spec.ts:73` needs `APP_URL`, which CI sets and the local `.env` lacked (4/4 pass with `APP_URL=http://127.0.0.1:3000`); `study-progress.spec.ts:92` timed out under the full run's load and passes alone |

## Load (`npm run load -- advice-feed`)

Logged-in students open page 1 of a course with 500 pieces of advice of every scope (a tenth anonymous, a tenth removed). Target: 99% of responses within 1 s, no errors.

| Users | Requests | Req/s | p50 ms | p99 ms | Errors | Server `advice_feed` p95 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 299 | 29.9 | 31 | 64 | 0 | 25 |
| 10 | 668 | 66.8 | 144 | 345 | 0 | 57 |
| 25 | 739 | 73.9 | 316 | 706 | 0 | 108 |
| 50 | 800 | 80.0 | 612 | 709 | 0 | 140 |

The target is met up to 50 concurrent users, the highest step tested. The query itself stays under 150 ms (p95); the rest is page rendering on a busy laptop. The feed reads only the 20 rows it shows plus a count, using the `(courseId, status, createdAt)` index.

## Shared files touched

- `prisma/schema.prisma`: the new model and enums, plus one back-relation line each on `User` (2), `Course`, `Term`, `CourseFile`, and `QuestionGroup`. No existing field changed.
- `lib/logger.ts`: one new event.
- `app/courses/[courseId]/page.tsx`: one new card.
- `README.md`: route, event, and the new section.

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
