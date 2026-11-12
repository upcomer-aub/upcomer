# Report inappropriate advice (US-43): Sprint 4 report

Mohammed Al-Haiqi (M4). Acceptance tester: Mustafa Ergaibi (M1).

**Acceptance check (sprint plan):** reports include reason and linked post; duplicate submissions handled.

This builds on the course advice feed (US-38, PR #33) and editing and deleting one's own advice (US-36). It adds the `AdviceReport` model (migration `20261113000000_advice_reports`). The admin review of reports is US-77.

## What changed

| Area | Change |
| --- | --- |
| Schema | `AdviceReport` (advice, course, reporter, reason, optional note, status, who closed it and when), enums `AdviceReportReason` and `AdviceReportStatus`; one migration, additions only |
| Service | `lib/advice-reports.ts`: `reportAdvice`, `getReportableAdvice` (the report page), `getOpenReportedAdviceIds` (the feed), the report limit |
| Rules | `lib/advice-report-rules.ts`: five reasons, the 500-character note, refusal messages |
| Action | `lib/advice-report-actions.ts`: `reportAdviceAction` (a plain form, redirect with the outcome) |
| Pages | `/courses/:courseId/advice/:adviceId/report` (`app/courses/[courseId]/advice/[adviceId]/report/page.tsx`) and its form (`components/report-advice.tsx`); the feed links each other student's advice to it, or says "You reported this advice" |
| Monitoring and logs | Timings `advice_report`, `advice_reportable_read`, `advice_reported_read`; events `advice_report_submitted` (info), `advice_report_refused`, `advice_report_rate_limited` (warn), `advice_report_failed` (error) |
| Load and availability | `npm run load -- advice-feed` now loads the feed as a student reading others' advice, so it includes the report check; `npm run availability` sends reports |
| Docs | README (routes, a US-43 section, events), `.env.example` (`ADVICE_REPORT_RATE_LIMIT_PER_MINUTE`) |

## Rules

1. **Reason and linked post.** A report has one of five reasons (insulting, spam or off-topic, personal information, encouraging cheating, something else) and optional details for the admin (at most 500 characters; only spaces or invisible characters count as none). It is linked to the advice by its ID, and its course is taken from the stored advice, never from the form.
2. **Duplicates.** A student has at most one open report per advice. The feed shows "You reported this advice" instead of the link, the report page shows it instead of the form, and a second report (for example from a page opened before the first was sent) is refused with "You already reported this advice". Reports of one student on one advice are taken one at a time (a transaction lock), so even reports sent at the same moment open one. After an admin closes the report (US-77), the student can report the advice again.
3. **What can be reported.** Only advice still shown in that course. One's own advice cannot be reported (its author edits or deletes it, US-36). Removed advice and advice that does not exist are a 404 on the report page and refused on submit.
4. **The advice stays up** until an admin decides (US-77). Reporting changes nothing a student sees.
5. **Privacy.** Only admins will see reports. Nothing on a student-facing page says who reported an advice, and the report page shows an anonymous author as "Anonymous student" (no author ID reaches any page). A report is kept when its author deletes the advice, and when the reporter's account is deleted (without a reporter).
6. **Nothing typed is put in a URL or a log.** Refusals come back as a code and are shown by a fixed message; an unknown code gets the general message.
7. **Login.** The report page and the action need a session; a visitor is sent to log in.

**Why the form has its own page.** The first version put a closed form under every advice in the feed. The feed load test then showed a page taking about 40 ms longer at one user (p99 61 → 150 ms), while the report check's query took 3 ms: the cost was rendering 20 forms. With a link instead, the feed is as light as before (p99 31 ms at one user).

## The course checklist applied to this feature

| Item | What this feature does |
| --- | --- |
| **Load testing** (how many users) | `npm run load -- advice-feed`: students open a feed of 500 pieces of advice written by another student, so every page runs the report check. Results below |
| **Availability and reliability** | `npm run availability` sends reports: every user reports the same advice; the first report is sent and later ones are refused as duplicates, and only those two outcomes count as correct. Results below |
| **Clearing stored requests** | Not applicable: a report is a record an admin must decide on, not a pending request; it is closed by the admin (US-77), never expired. Reports of a deleted course are deleted with it |
| **Automated browser tests** (Selenium-like) | Playwright: 6 end-to-end tests (`tests/e2e/advice-reports.spec.ts`) |
| **Responsiveness, 100 ms to 1 s, shown by the logs** | `operation_timed` lines `advice_report`, `advice_reportable_read`, `advice_reported_read`, with `slow_operation` over 1 s on `/admin/monitoring` |
| **Monitoring** | The four events above are saved and shown on `/admin/monitoring`, with IDs, the reason category, and the refusal reason only |
| **Logs** | Never the note or the advice text (unit tested) |
| **Caching** | The feed's cache (US-38) is shared by all students, so whether the viewer reported an advice is read apart from it, in one indexed query per page (`AdviceReport(reporterId, status)`); the cached page itself is unchanged |
| **Security testing: DoS** | At most 10 reports per student per minute (`ADVICE_REPORT_RATE_LIMIT_PER_MINUTE`); past it the report is refused before the database is read. Tested end to end: 10 reports pass, the 11th is refused and not stored. Also tested: a forged form pointing at one's own advice, a reason not on the list, a hand-made course ID in the redirect |

## Tests

| Suite | File | Tests | Result |
| --- | --- | ---: | --- |
| Unit: rules, service, limit, action (mocked database) | `tests/unit/advice-reports.test.ts` | 20 | pass |
| Unit: feed link and the report page | `tests/unit/advice-pages.test.tsx` | 8 new | pass |
| Integration (real PostgreSQL) | `tests/integration/advice-reports.test.ts` | 7 | pass |
| End-to-end (production build) | `tests/e2e/advice-reports.spec.ts` | 6 | pass |

**Mutation check:** with the transaction lock removed, the integration test that sends 10 reports at once stored 10 reports instead of 1, so the duplicate guarantee is really tested. (A first version of that test sent 5 reports once and still passed without the lock; it now runs three rounds of 10.)

## Load (`npm run load -- advice-feed`)

| Users | Requests | Req/s | p50 ms | p99 ms | Errors | Target |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 708 | 70.8 | 12 | 31 | 0 | met |
| 10 | 1,111 | 111.1 | 84 | 163 | 0 | met |
| 25 | 750 | 75.0 | 245 | 1,028 | 0 | missed by 28 ms |
| 50 | 350 | 35.0 | 1,293 | 1,619 | 0 | missed |
| 100 | 368 | 36.8 | 2,317 | 3,346 | 0 | missed |

The target (p99 within 1 s, no errors) was met up to **10** concurrent users, and missed at 25 by 28 ms, with no error at any step. Throughput fell from 10 users on (1,111 → 350 requests), which is the busy machine (other programs used much of the CPU, as in the US-38 and US-36 reports), not this feature: the report check took p50 14 ms, p95 150 ms for the whole run, and cached feed reads 0 ms. At one and ten users the feed is faster than in the US-38 report (p99 31 and 163 ms against 64 and 345 ms).

## Availability (`npm run availability`)

All 14 student APIs mixed like a student's visit, 20 s per stage:

| Users | Requests | Availability | 95% lower bound | Failed | Reliability | Report advice: requests / available / correct |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 1,006 | 100.000% | 99.702% | 0 | 100.0% | 52 / 52 / 52 |
| 10 | 1,690 | 100.000% | 99.822% | 0 | 100.0% | 80 / 80 / 80 |
| 25 | 1,643 | 100.000% | 99.817% | 0 | 99.4% | 65 / 65 / 65 |
| 50 | 1,100 | 100.000% | 99.727% | 0 | 56.0% | 45 / 45 / 45 |
| 100 | 1,911 | 100.000% | 99.843% | 0 | 52.0% | 68 / 68 / 68 |

- **Availability** was 100% at every stage for every API: 7,350 requests with no timeout, connection error, or 5xx.
- **Correctness:** every report was either sent (75) or refused as a duplicate (237); no other outcome, and only one report per user was ever stored.
- **Server timings** for the whole run: `advice_report` p50 77 ms, p95 638 ms; the feed's report check p50 12 ms, p95 121 ms; cached feed reads 0 ms (458) against 133 database reads.
- **Reliability** (correct and within 1 s) held to 25 users and fell at 50 and 100, the same for every API; recovery after the 100-user stage took 1.1 s.
- **Found by this run:** the availability tool first posted reports to the feed page, which has no report form since the form moved; Next.js answers an action on a page that does not hold it with a 500. The tool now posts to the report page, as the browser does.

The run raises `ADVICE_REPORT_RATE_LIMIT_PER_MINUTE` for its server; the limit itself is tested end to end.

## Full check results (local, 2026-11-12)

| Check | Result |
| --- | --- |
| `npm test` | 71 files, 1,122 tests pass (27 new since US-36) |
| `npm run lint`, `npx tsc --noEmit` | clean |
| `npm run test:integration` | 13 files, 117 tests pass (7 new) |
| `npm run test:e2e` (advice specs, `APP_URL` as in CI) | 23 pass (6 new) |

## Shared files touched

- `prisma/schema.prisma`: the new model and enums, and their relations on `User`, `Course`, and `Advice` (additions only, no reformatting).
- `lib/logger.ts`: four events.
- `components/advice-list.tsx`, `components/advice-list.module.css`, `app/courses/[courseId]/advice/page.tsx` (US-38's feed): the report link and the outcome notice.
- `tests/availability/run.ts`: the report API; `tests/load/scenarios/advice-feed.ts`: the advice is now by another student, with one report by the viewer.
- `README.md`, `.env.example`.

## Open items

- **US-77:** the admin queue and decisions on these reports.
- Notifications: the plan says anonymity also holds in notifications; there are none yet, and reports send none.
- Load numbers should be repeated on a quiet machine.
