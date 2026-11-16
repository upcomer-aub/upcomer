# Course advice feed (US-38) - Sprint 4

Owner: Mohammed Al-Haiqi (M4). Tester: Mustafa Ergaibi (M1).

**Story:** as a student, I want to browse a course's advice from previous students, so I can prepare better.
**Tester's check (sprint plan):** the feed displays only relevant visible advice with the correct course and scope.

## Rebuilt on the team's Advice model

The first version of this story (PR #33, 2026-11-12) brought its own `Advice` model, because US-34 had not started. US-34, US-35, US-37 and US-39 then landed on main with Ali Shammakh's model (`20261102000000_advice`) and the advice page. This version drops the first model and builds the feed on main's: no schema change, no new page. `searchAdvice` keeps its signature and behaviour.

## What the feed guarantees

| Guarantee | Where | Checked by |
| --- | --- | --- |
| Only this course's `VISIBLE` advice; removed advice never shows | `visibleCourseAdvice` in every student query | unit, integration, e2e, availability |
| Advice pointing at another course's paper or question (bad data) is left out, also from counts | `visibleCourseAdvice` (`NOT` on `file`/`group`) | integration (mutation-checked: fails without the guard), e2e |
| Newest first, ties broken by ID; stable pages of 20, no item twice | `readPage` | integration (45 posts with the same time), e2e |
| Invalid page gives page 1, past the end gives the last page | `pageKey`, `readPage` | unit, integration, e2e |
| Scope shown with each post | Ali's `AdviceList` | e2e (all five scopes) |
| Anonymous author's name and every author ID never in the page | `toPublicAdvice` | integration, e2e (whole HTML), availability |
| A new post shows at once although the feed is cached | `invalidateCourseAdvice` in `publishAdvice` | unit, integration, e2e (through the real form) |

## Course checklist

- **Caching:** unfiltered feed pages cached for `ADVICE_FEED_CACHE_SECONDS` (30 s), at most 500 courses x 50 pages. Rows are cached and `isMine` is worked out per viewer. Searches and filters are not cached. Writers must call `invalidateCourseAdvice(courseId)`.
- **Bug found and fixed while testing:** with the cache in a module-level `Map`, the e2e "new post shows at once" test failed on the production build. The post was saved, but the page still showed the old cached feed. Next.js bundles server actions apart from pages, so the publish action had its own copy of the map. The cache now sits on `globalThis`, like the Prisma client. **Team note:** `lib/rate-limit.ts` keeps its windows in a module-level map too, so a limit counted in an action and checked in a page (or the reverse) would not see the same counts. No current limit crosses the two, but keep it in mind.
- **DoS:** 120 advice page reads per logged-in student per minute (`ADVICE_FEED_RATE_LIMIT_PER_MINUTE`). E2E: 120 reads served, read 121 gets the limit message and nothing is read, and another student is still served. Visitors are served from the cache.
- **Logs and responsiveness:** `operation_timed` lines `advice_feed` / `advice_feed_cached`, `slow_operation` over 1 s, and the new `advice_feed_rate_limited` event on `/admin/monitoring`. No advice text or names are logged.
- **Stored-request cleanup:** not applicable, the feed stores nothing per request.
- **Availability** (`npm run availability`, the feed in the mix with a correctness check: the course's visible and anonymous advice present, no removed advice, no other course's advice, no anonymous author's name):

| Users | Advice requests | Available | Wrong content | p50 ms | p99 ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 94 | 100% | 0 | 15 | 436 |
| 10 | 128 | 100% | 0 | 140 | 614 |
| 25 | 126 | 100% | 0 | 380 | 741 |
| 50 | 162 | 100% | 0 | 697 | 1,100 |
| 100 | 196 | 100% | 0 | 1,039 | 2,070 |

  Whole run: 7,468 requests, 100% available, 0 failed. Past 25 users every page slows the same way (at 100 users `/profile` has p50 1,040 ms and the advice page 1,039 ms), so the limit is the single server process on this machine, not the feed. The machine also runs other programs (it idles at a high CPU load), so the latency numbers are inconclusive. Rerun on a quiet machine before quoting them.
- **Load:** `npm run load -- advice-feed` (500 posts of every scope in one course, one logged-in student, cache on; `ADVICE_FEED_CACHE_SECONDS=0` measures database reads). Results below.

| Users | Requests | p99 ms | Errors | Target (p99 < 1 s) |
| ---: | ---: | ---: | ---: | --- |
| 1 | 599 | 37 | 0 | met |
| 10 | 1,041 | 182 | 0 | met |
| 25 | 1,099 | 399 | 0 | met |
| 50 | 1,299 | 656 | 0 | met |
| 100 | 1,382 | 848 | 0 | met |

  Server timings: every cached read took 0 ms (p99 at most 4 ms); the few database reads (when a page expired) took a p95 of 131 ms. Supported within 1 s: 100 users.

## Tests

- Unit: `tests/unit/advice-feed.test.ts` (14: guard, cache per page, per viewer, expiry, off switch, invalidation, failure not cached, limit), `tests/unit/advice-feed-page.test.tsx` (5: feed, limit message reads nothing, visitor, not found, pages). Ali's `tests/unit/advice.test.ts` gets one line (reset the cache between tests) and still passes all 25.
- Integration (real PostgreSQL): `tests/integration/advice-feed.test.ts` (5). Ali's `tests/integration/advice.test.ts` still passes all 13.
- E2E: `tests/e2e/advice-feed.spec.ts` (7): course link, only visible advice of this course newest first, every scope label, safe https link, anonymity in the whole HTML, visitor, two pages and clamped page numbers, new post through the form shows at once, read flood.

## Checks (local)

- tsc and lint clean; production build passes.
- Advice unit tests 44/44 (25 of Ali's + 14 + 5 new); advice integration 18/18 on PostgreSQL; feed e2e 7/7 on the production build.
- The full suites are run once at the top of the stacked advice branches; see `ADVICE_MODERATION_REPORT.md`.
