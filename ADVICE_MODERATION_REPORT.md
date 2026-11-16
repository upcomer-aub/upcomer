# Review and remove reported advice (US-77) - Sprint 4

Mohammed Al-Haiqi (M4). Acceptance tester: Mustafa Ergaibi (M1).

**Acceptance check (sprint plan):** admin reviews and resolves reports; non-admin blocked from moderation actions.

This builds on reporting advice (US-43) and the team's `Advice` model (US-34). It replaces the first version (PR #36, 2026-11-13); the rules are the same, only the advice model it reads through changed (`adviceSelect` and `toPublicAdvice` from `lib/advice.ts`). No schema change: it uses the `AdviceReport` status (`OPEN`, `RESOLVED`, `DISMISSED`) and the `Advice` status `REMOVED`.

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

**Mutation check (rerun on this version):** with the "open reports only" condition removed from the decision, 1 of the 6 integration tests failed, so rule 5 is really tested.

## Load (`npm run load -- advice-moderation`)

Admins open the queue with 100 reported pieces of advice (300 open reports).

| Users | Requests | p99 ms | Errors | Target (p99 < 1 s) |
| ---: | ---: | ---: | ---: | --- |
| 1 | 454 | 44 | 0 | met |
| 10 | 824 | 183 | 0 | met |
| 25 | 900 | 488 | 0 | met |
| 50 | 800 | 986 | 0 | met |
| 100 | 899 | 1,191 | 0 | missed |

The queue query itself stays fast: its server timing has a p95 of 221 ms at 100 users, so the rest is the single server process. Supported within 1 s: 50 admins at once (the first version missed the target at 25). A real course has a handful of admins, so this is well beyond its need. The machine was busy with other programs, so treat the 100-user number as an upper bound of the cost.

## Availability (`npm run availability`)

"GET /admin/advice-reports (student refused)" is correct only when a student gets a 404 without the queue:

| Users | Requests | Available | Wrong content | p50 / p99 ms |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 15 | 100% | 0 | 10 / 320 |
| 10 | 29 | 100% | 0 | 77 / 415 |
| 25 | 32 | 100% | 0 | 283 / 524 |
| 50 | 33 | 100% | 0 | 457 / 750 |
| 100 | 42 | 100% | 0 | 966 / 1,732 |

Whole run: 9,008 requests, 100% available, 0 failed, reliability 99.8% up to 25 users.

## Full suites on the top of the four advice PRs (local)

- tsc and lint clean; production build passes.
- Unit: 89 files, 1,379 tests pass.
- Integration (real PostgreSQL): 20 files, 188 tests pass.
- E2E (production build, 1 worker): 135 tests. 134 passed on the first run. The one failure was `ali-slim-sprint4.spec.ts:96`, which also fails on main's CI (strict-mode `getByRole("alert")` matches Next.js's route announcer). With the first commit of #33 it passes (4/4).

