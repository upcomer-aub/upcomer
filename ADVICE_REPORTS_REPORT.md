# Reporting inappropriate advice (US-43) - Sprint 4

Owner: Mohammed Al-Haiqi (M4). Tester: Mustafa Ergaibi (M1).

**Story:** as a student, I want to report inappropriate advice, so admins can review it.
**Tester's check:** a report is stored with its reason, linked to the advice, and waits for an admin (US-77).

Built on the team's `Advice` model (US-34) and on US-38/US-36 (the previous PRs). It replaces the first version (PR #35, 2026-11-13). The only difference is the advice model it reads through: `toPublicAdvice` and `adviceSelect` from `lib/advice.ts`. The `AdviceReport` model is the same.

## What it guarantees

| Guarantee | How | Checked by |
| --- | --- | --- |
| Stored with its reason and optional details, linked to the advice and its course | `AdviceReport` (`adviceId`, `courseId` from the stored advice) | unit, integration, e2e |
| Only advice students can see can be reported | `VISIBLE` read inside the transaction | integration, e2e (advice deleted after the page was opened) |
| Not one's own advice; no reason off the list | refused as `own_advice` / `invalid_reason` | unit, integration, e2e (forged form) |
| One open report per student and advice, also for two clicks at once | advisory lock per student and advice, then check | integration (concurrent reports), e2e (stale second tab) |
| An anonymous author stays anonymous on the report page and in the feed | `toPublicAdvice` | unit, e2e (whole HTML has no author ID or name) |
| The feed says the student already reported it | `getOpenReportedAdviceIds` (one query per page) | unit, e2e |

## Course checklist

- **DoS:** 10 reports per student per minute (`ADVICE_REPORT_RATE_LIMIT_PER_MINUTE`). E2E: report 11 in a minute gets "Too many reports in a minute" and stores nothing.
- **Logs and responsiveness:** `operation_timed` `advice_report`, `advice_reportable_read`, `advice_reported_read`; events `advice_report_submitted`, `advice_report_refused`, `advice_report_rate_limited`, `advice_report_failed`. The note and the advice text are never logged.
- **Caching:** none needed. A report does not change what students see until an admin acts (US-77, which invalidates the feed).
- **Stored-request cleanup:** reports are records an admin must handle, so they are kept, not cleaned up. Closing them is US-77.
- **Availability and load:** results below.

**Availability** (`npm run availability`; the new API is a real report POST in which every user reports the same advice; correct only when it redirects with `reported=1` for the first report or `report_error=duplicate` for the rest):

| Users | Report requests | Available | Wrong outcome | p50 / p99 ms |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 42 | 100% | 0 | 9 / 17 |
| 10 | 55 | 100% | 0 | 43 / 460 |
| 25 | 47 | 100% | 0 | 223 / 858 |
| 50 | 61 | 100% | 0 | 454 / 1,124 |
| 100 | 97 | 100% | 0 | 923 / 1,117 |

Whole run: 7,306 requests, 100% available, 0 failed. As in the earlier runs, every page slows past 25 users on this machine, so latency is inconclusive.

**Load** (`npm run load -- advice-report`, the report page of another student's advice in a course of 500 posts):

| Users | Requests | p99 ms | Errors | Target (p99 < 1 s) |
| ---: | ---: | ---: | ---: | --- |
| 1 | 855 | 24 | 0 | met |
| 10 | 1,691 | 122 | 0 | met |
| 25 | 2,258 | 207 | 0 | met |
| 50 | 2,691 | 240 | 0 | met |
| 100 | 2,600 | 520 | 0 | met |

## Tests

- Unit: `tests/unit/advice-reports.test.ts` (19), plus 2 report cases in `tests/unit/advice-feed-page.test.tsx`.
- Integration (real PostgreSQL): `tests/integration/advice-reports.test.ts` (7).
- E2E: `tests/e2e/advice-reports.spec.ts` (6). With the feed and change specs: 19/19 on the production build.
