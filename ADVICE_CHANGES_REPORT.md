# Edit or delete my own advice (US-36): Sprint 4 report

Mohammed Al-Haiqi (M4). Acceptance tester: Mustafa Ergaibi (M1).

**Acceptance check (sprint plan):** only an author can edit or delete; changes propagate to the feed and search.

This builds on the course advice feed (US-38, PR #33) and its `Advice` model. No schema change: deleting uses the `REMOVED` status that model already has.

## What changed

| Area | Change |
| --- | --- |
| Service | `lib/advice-changes.ts`: `getOwnAdvice`, `editAdvice`, `deleteAdvice`, and the change limit |
| Actions | `lib/advice-actions.ts`: `editAdviceAction`, `deleteAdviceAction` (plain forms, redirect with the outcome) |
| Rules | `lib/advice-rules.ts`: `checkAdviceDraft` (text and link), `MAX_ADVICE_LENGTH` (2,000), `MAX_RESOURCE_URL_LENGTH` (500), refusal messages |
| Feed | `lib/advice.ts`: each item says whether the viewer wrote it (`mine`); `components/advice-list.tsx` shows "Your advice" and "Edit or delete" for it; the feed page shows the outcome of a change |
| Page | `/courses/:courseId/advice/:adviceId/edit` (`app/courses/[courseId]/advice/[adviceId]/edit/page.tsx`): edit form and a separate delete section |
| Monitoring and logs | Timings `advice_own_read`, `advice_edit`, `advice_delete`; events `advice_edited`, `advice_deleted` (info), `advice_change_refused`, `advice_change_rate_limited` (warn), `advice_change_failed` (error) |
| Load and availability | `npm run load -- advice-edit`; two APIs added to `npm run availability` (open and save one's own advice) |
| Fix in US-38 | An empty `ADVICE_FEED_CACHE_SECONDS` (as `.env.example` now has it) turned the cache off, because `Number("")` is 0; it now means the default |
| Docs | README (routes, a US-36 section, events), `.env.example` (the advice limits and cache) |

## Rules

1. **Only the author.** Every read and write matches the advice by its ID **and** the caller's user ID together. Anyone else's advice is "not found", exactly like advice that does not exist, so nobody learns who wrote an anonymous advice by trying IDs. The same holds for a forged form (tested end to end). An admin is not the author either; removing advice is US-77.
2. **Only advice still shown.** Removed advice (deleted by its author or removed by an admin) cannot be edited or deleted. The write repeats the match, so an admin removal or a delete between the read and the write is never undone, and deleted advice never comes back (tested with an edit and a delete racing).
3. **Deleting keeps the row**, marked `REMOVED` with `removedById` = the author. It leaves every list at once, but an open report about it (US-43) can still be checked by an admin. Nothing student-facing shows it again.
4. **Propagation.** Each change calls `invalidateCourseAdvice(courseId)`, so the feed shows it at once, for every viewer. Search (US-39, not built yet) must read through `visibleCourseAdvice` and the current `body`, so edits and deletes reach it the same way.
5. **The draft.** Text is trimmed, keeps its line breaks, and must have something readable (text of only spaces or zero-width characters is empty), at most 2,000 characters (a Windows line break counts once, as the browser counts it). The resource link is optional; left empty it is removed; otherwise it must be a safe `https` URL (same check as the feed), at most 500 characters. Saving without a change writes nothing and does not mark the advice edited.
6. **Anonymity.** The author of anonymous advice can edit it, and it stays anonymous. Only they see "Your advice" on it, with "Others see you as Anonymous student". The feed knows which advice is the viewer's by comparing author IDs that stay on the server, next to the cached page; no author ID reaches any page (checked in the page HTML).
7. **Nothing typed is put in a URL or a log.** Refusals come back as a code (`?error=too_long`) and are shown by a fixed message; an unknown code gets the general message, never the value.
8. **Login.** Both the page and the actions need a session; a visitor is sent to log in and back to the edit page.

The redirect after a save lands on the feed page the author came from (`page`), without an `#advice-…` anchor: Next.js drops the fragment of a server action's redirect (found by the e2e test).

## The course checklist applied to this feature

| Item | What this feature does |
| --- | --- |
| **Load testing** (how many users) | `npm run load -- advice-edit`: students open the edit page of their own advice in a course with 500 pieces of advice, 1 to 100 concurrent users. The saves are POST server actions that answer with a redirect, which this runner counts as errors, so they are measured by the availability run instead. Results below |
| **Availability and reliability** | `npm run availability` now opens and saves each user's own advice. A save counts as correct only when it lands on the feed with "edited"; the edit page only when it shows the user's own advice. Results below |
| **Clearing stored requests** | Not applicable: a change stores nothing per request (no pending requests, tokens, or files). A deleted advice is kept on purpose, for moderation (rule 3); it is one row per advice, not per request |
| **Automated browser tests** (Selenium-like) | Playwright: 9 end-to-end tests (`tests/e2e/advice-changes.spec.ts`) |
| **Responsiveness, 100 ms to 1 s, shown by the logs** | `operation_timed` lines `advice_own_read`, `advice_edit`, `advice_delete`, with `slow_operation` over 1 s on `/admin/monitoring` |
| **Monitoring** | The five events above are saved and shown on `/admin/monitoring`, with IDs, the operation, and the refusal reason only |
| **Logs** | Never the old or new text, never the link (unit tested) |
| **Caching** | Each change invalidates the course's feed cache, so the cache never shows a stale or deleted advice. Marking the viewer's own advice works from the cached page, so it costs no extra database read |
| **Security testing: DoS** | At most 20 edits and deletes per student per minute (`ADVICE_CHANGE_RATE_LIMIT_PER_MINUTE`); past it the change is refused before the database is read. Tested end to end: 20 saves pass, the 21st is refused and not saved. Also tested: a forged form, another student's edit URL (404), a hand-made course or advice ID in the redirect (kept inside its path segment) |

## Tests

| Suite | File | Tests | Result |
| --- | --- | ---: | --- |
| Unit: rules, service, limit (mocked database) | `tests/unit/advice-changes.test.ts` | 20 | pass |
| Unit: actions | `tests/unit/advice-actions.test.ts` | 10 | pass |
| Unit: feed marks and the edit page | `tests/unit/advice.test.ts`, `tests/unit/advice-pages.test.tsx` | 12 new | pass |
| Integration (real PostgreSQL) | `tests/integration/advice-changes.test.ts` | 8 | pass |
| End-to-end (production build) | `tests/e2e/advice-changes.spec.ts` | 9 | pass |

**Mutation check:** with the author dropped from the match (any student could change the advice), the integration test "refuses another student's edit and delete" and two unit tests failed, so rule 1 is really tested.

## Full check results (local, 2026-11-12)

| Check | Result |
| --- | --- |
| `npm test` | 70 files, 1,095 tests pass |
| `npm run lint` | clean |
| `npx tsc --noEmit` | clean |
| `npm run build` | pass (built by the e2e run) |
| `npm run test:integration` | 12 files, 110 tests pass |
| `npm run test:e2e` (`APP_URL=http://127.0.0.1:3000` as in CI) | 107 tests pass (7.8 min, `--workers=1` on a low-memory machine) |

## Load (`npm run load -- advice-edit`)

The machine was busy again during these runs: about 75% CPU with 1 user, from other programs (as in the US-38 report). The end-to-end numbers measure that machine; the server's own timings show the feature's share.

| Users | Requests | Req/s | p50 ms | p99 ms | Errors | Target | Server `advice_own_read` p50 / p95 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | 283 | 28.3 | 32 | 86 | 0 | met | 7 / 18 |
| 10 | 397 | 39.7 | 239 | 512 | 0 | met | 44 / 76 |
| 25 | 449 | 44.9 | 526 | 710 | 0 | met | 64 / 96 |
| 50 | 450 | 45.0 | 1,022 | 1,191 | 0 | missed | 109 / 139 |
| 100 | 462 | 46.2 | 2,008 | 2,699 | 0 | missed | 227 / 509 |

The target (p99 within 1 s, no errors) was met up to **25** concurrent users, with no error at any step. Throughput levels off at about 45 requests a second from 25 users on, while the database read stays near 0.1 s at 50 users: the rest of the time is spent waiting for the one Node.js server on a busy machine (session check and rendering), not in this feature's query.

## Availability (`npm run availability`)

All 13 student APIs mixed like a student's visit, the two new ones among them, 20 s per stage:

| Users | Requests (all APIs) | Availability | Failed | Open own advice: requests / available | Save own advice: requests / available / correct | Machine CPU avg |
| ---: | ---: | ---: | ---: | --- | --- | ---: |
| 1 | 160 | 100.000% | 0 | 6 / 6 | 6 / 6 / 6 | 77% |
| 10 | 247 | 100.000% | 0 | 9 / 9 | 11 / 11 / 11 | 72% |
| 25 | 427 | 100.000% | 0 | 14 / 14 | 16 / 16 / 16 | 77% |
| 50 | 541 | 100.000% | 0 | 30 / 30 | 23 / 23 / 23 | 56% |
| 100 | 643 | 100.000% | 0 | 27 / 27 | 26 / 26 / 26 | 48% |

- **Availability** was 100% at every stage for every API: 2,018 requests with no timeout, connection error, or 5xx (at least about 99.5% proven at 100 users, the 95% lower bound).
- **Correctness:** no reply had wrong content: every save landed on the feed with "edited", every edit page showed the user's own advice, and the feed (now with 100 users' own anonymous advice in it) never showed a removed advice, another course's advice, or the anonymous author's name.
- **Server timings** for the whole run: `advice_edit` (read + write) p50 296 ms, p95 1,045 ms; `advice_own_read` p50 253 ms, p95 870 ms; the feed's cached reads 0 ms (128 of them) against 163 ms for its 43 database reads, so the edits' invalidations did not make the feed read the database on every request.
- **Reliability** (correct and within 1 s) fell as users grew, the same for every API, because the whole app levelled off at about 32 requests a second on this machine. Recovery after the 100-user stage took 1.2 s.

The run raises `ADVICE_CHANGE_RATE_LIMIT_PER_MINUTE` for its server, because its users save far more often than people do; the limit itself is tested end to end.

## Shared files touched

- `lib/advice.ts` (US-38's service): the `mine` mark, and the cache setting fix.
- `components/advice-list.tsx`: the own-advice line; `AdviceAbout` exported for the edit page.
- `app/courses/[courseId]/advice/page.tsx`: the outcome notice.
- `lib/logger.ts`: five events.
- `tests/availability/run.ts`: two APIs, each user's own advice (deleted by its stamp at the end), and the raised change limit.
- `README.md`, `.env.example`.

## Open items

- **US-34 (publishing):** the length limits here (2,000 and 500 characters) are proposed for publishing too, so a published advice can always be saved again unchanged.
- **US-39 (search):** must use `visibleCourseAdvice` so deleted advice never shows and edits show at once.
- **US-43 / US-77:** a report on advice its author then deleted should still reach the admin; the row is kept for that.
- Changing the scope, target, or anonymity of advice is not part of this story; only the text and the link can be edited.
- Load numbers should be repeated on a quiet machine.
