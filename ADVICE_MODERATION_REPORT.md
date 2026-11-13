# Review and remove reported advice (US-77): Sprint 4 report

Mohammed Al-Haiqi (M4). Acceptance tester: Mustafa Ergaibi (M1).

**Acceptance check (sprint plan):** admin reviews and resolves reports; non-admin blocked from moderation actions.

This builds on reporting advice (US-43). No schema change: it uses the `AdviceReport` status (`OPEN`, `RESOLVED`, `DISMISSED`) and the `Advice` status `REMOVED`.

## What changed

| Area | Change |
| --- | --- |
| Service | `lib/advice-moderation.ts`: `getAdviceReportQueue`, `moderateAdvice`, the decision limit |
| Action | `lib/advice-moderation-actions.ts`: `moderateAdviceAction` (admins only, redirect with the outcome) |
| Page | `/admin/advice-reports` (`app/admin/advice-reports/page.tsx`), linked from the admin catalog as "Advice reports" |
| Monitoring and logs | Timings `advice_report_queue`, `advice_moderation`; events `advice_removed_by_admin`, `advice_reports_dismissed` (info), `advice_moderation_refused`, `advice_moderation_rate_limited` (warn), `advice_moderation_failed`, `advice_report_queue_failed` (error) |
| Load and availability | `npm run load -- advice-moderation`; `npm run availability` checks students are refused the queue |
| Docs | README (route, a US-77 section, events), `.env.example` (`ADVICE_MODERATION_RATE_LIMIT_PER_MINUTE`) |

## Rules

1. **Admins only.** The page and the action call `requireAdmin()` first. A student gets the not-found page, also when sending the admin's form with its real action ID (the ID is the same for everyone, so this is the realistic attack; tested end to end). A visitor is sent to log in.
2. **The queue.** Each advice with open reports is shown once, the one reported longest ago first, 20 a page: the advice as students see it, how many students reported it, the reasons with counts, and the notes.
3. **Minimum information** (plan: "admins keep only the minimum permissions needed for abuse handling"). An anonymous author stays anonymous in the queue, reporters are never shown, and no user ID reaches the page. Both are kept in the database.
4. **Remove** makes the advice `REMOVED` (`removedById` = the admin), resolves all its open reports, and clears the course's feed cache, so the advice leaves the feed, its report page, and its edit page at once. **Keep** dismisses the reports and leaves the advice; students can report it again. Advice its author already deleted is marked so, with only **Close reports**, which keeps the author's deletion as it is.
5. **One decision.** A decision only closes open reports, in one transaction, so when two admins decide at once (or from a page opened before another's decision) the second changes nothing and is told the advice has no open reports any more. An admin cannot remove advice nobody reported from this page.
6. **Nothing typed is logged.** Logs carry IDs, the decision, and how many reports were closed.

## The course checklist applied to this feature

| Item | What this feature does |
| --- | --- |
| **Load testing** (how many users) | `npm run load -- advice-moderation`: admins open the queue with 100 reported pieces of advice (300 open reports). Results below |
| **Availability and reliability** | `npm run availability` adds "GET /admin/advice-reports (student refused)": correct only when a student gets a 404 without the queue. Results below |
| **Clearing stored requests** | Not applicable: decisions store nothing per request; closed reports stay as the record of the decision |
| **Automated browser tests** (Selenium-like) | Playwright: 5 end-to-end tests (`tests/e2e/advice-moderation.spec.ts`), including demo step 3 (a student reports, the admin removes, the feed updates) |
| **Responsiveness, 100 ms to 1 s, shown by the logs** | `operation_timed` lines `advice_report_queue`, `advice_moderation`, with `slow_operation` over 1 s on `/admin/monitoring` |
| **Monitoring** | The six events above on `/admin/monitoring` |
| **Logs** | Never the advice text or a note (unit tested) |
| **Caching** | A removal clears the course's feed cache, so the cached feed never shows removed advice (end-to-end and integration tested) |
| **Security testing: DoS** | At most 60 decisions per admin per minute; past it the decision is refused before the database is read (unit tested). Also tested: a student with the real action ID, a stale page, two admins at once |

## Tests

| Suite | File | Tests | Result |
| --- | --- | ---: | --- |
| Unit: queue, decisions, limit, action (mocked database) | `tests/unit/advice-moderation.test.ts` | 15 | pass |
| Unit: the page | `tests/unit/advice-moderation-page.test.tsx` | 5 | pass |
| Integration (real PostgreSQL) | `tests/integration/advice-moderation.test.ts` | 6 | pass |
| End-to-end (production build) | `tests/e2e/advice-moderation.spec.ts` | 5 | pass |

**Mutation check:** with the "open reports only" condition removed from the decision, the integration test with two admins deciding at once failed, so rule 5 is really tested.

## Load (`npm run load -- advice-moderation`)

| Users | Requests | Req/s | p50 ms | p99 ms | Errors | Target |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 221 | 22.1 | 42 | 95 | 0 | met |
| 10 | 315 | 31.5 | 299 | 539 | 0 | met |
| 25 | 211 | 21.1 | 1,107 | 1,669 | 0 | missed |
| 50 | 200 | 20.0 | 2,131 | 2,586 | 0 | missed |
| 100 | 200 | 20.0 | 3,398 | 5,094 | 0 | missed |

The target was met up to **10** concurrent admins, with no error at any step. The queue read took p50 151 ms, p95 552 ms: each request reads every open report to group them. The team has one or two admins, so this is enough; if the queue grows, grouping in the database (one page of advice at a time) is the next step.

## Availability (`npm run availability`)

All 15 student APIs, 20 s per stage: 100% availability at every stage (4,082 requests, 0 failed). The new check got a 404 without the queue every time. Reliability (within 1 s) held to 10 users on a busy machine.

| Users | Requests | Availability | Failed | Reliability |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 884 | 100.000% | 0 | 100.0% |
| 10 | 584 | 100.000% | 0 | 99.3% |
| 25 | 701 | 100.000% | 0 | 86.2% |
| 50 | 786 | 100.000% | 0 | 38.0% |
| 100 | 1,127 | 100.000% | 0 | 18.3% |

## Full check results (local)

| Check | Result |
| --- | --- |
| `npm test` | 73 files, 1,142 tests pass |
| `npm run lint`, `npx tsc --noEmit` | clean |
| `npm run test:integration` | 14 files, 123 tests pass |
| `npm run test:e2e` (`APP_URL` as in CI) | 118 tests pass (5 new; 6.8 min, `--workers=1`) |

## Open items

- Notifications: none exist yet, so authors are not told their advice was removed.
- Grouping the queue in the database if it grows past a few hundred open reports.
- Load numbers should be repeated on a quiet machine.
