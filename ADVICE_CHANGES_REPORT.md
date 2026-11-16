# Editing and deleting one's own advice (US-36) - Sprint 4

Owner: Mohammed Al-Haiqi (M4). Tester: Mustafa Ergaibi (M1).

**Story:** as a student, I want to edit or delete advice I published, so I can correct or withdraw it.
**Tester's check:** only the author can change their advice, and the feed shows the change at once.

Built on the team's `Advice` model (US-34) and the feed (US-38, the previous PR). The first version (PR #34, 2026-11-13) used the model in PR #33 and is replaced by this one.

## What it guarantees

| Guarantee | How | Checked by |
| --- | --- | --- |
| Only the author can edit or delete | every read and write matches ID + session user as author + `VISIBLE`; the form's user ID and course are ignored | unit (actions), integration (another student, an admin), e2e (no link, edit page 404) |
| Another student's advice looks the same as advice that does not exist | one `not_found` for all | unit, integration, e2e |
| Same rules as publishing; scope and anonymity never change | `checkAdviceDraft` uses Ali's validators; the update has no scope or `isAnonymous` field | unit, integration, e2e (anonymous stays anonymous) |
| Unsafe links refused | `parseResourceLink` (https only) | unit (6 schemes), e2e (`javascript:` with the field type removed, as an attacker would) |
| Unchanged save writes nothing, is not marked edited | compared before writing | unit, e2e |
| Deleted or admin-removed advice never comes back | write matches `VISIBLE` again; deleting is `REMOVED` by the author, kept for moderation | integration (edit + delete race), e2e |
| The feed shows the change at once | `invalidateCourseAdvice` after every change | integration, e2e |

## Course checklist

- **Caching:** every edit and delete invalidates only that course's cached feed (integration: another course's feed is untouched).
- **DoS:** 20 edits and deletes per student per minute (`ADVICE_CHANGE_RATE_LIMIT_PER_MINUTE`), checked before any database read; another student is not affected (unit).
- **Logs and responsiveness:** `operation_timed` `advice_own_read`, `advice_edit`, `advice_delete`; events `advice_edited`, `advice_deleted`, `advice_change_refused`, `advice_change_rate_limited`, `advice_change_failed`. The title, text and link are never logged (unit checks the log lines).
- **Stored-request cleanup:** not applicable; nothing is stored per request.
- **Availability** (`npm run availability`, two new APIs in the mix: opening one's own edit page, correct only if the user's advice is on it, and a real edit save, correct only if it redirects with `edited=1`):

| Users | Edit page requests | Available | p50 / p99 ms | Edit saves | Available | Wrong outcome | p50 / p99 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 37 | 100% | 13 / 434 | 31 | 100% | 0 | 11 / 23 |
| 10 | 45 | 100% | 152 / 530 | 42 | 100% | 0 | 42 / 471 |
| 25 | 54 | 100% | 442 / 735 | 58 | 100% | 0 | 176 / 648 |
| 50 | 62 | 100% | 833 / 1,148 | 47 | 100% | 0 | 384 / 943 |
| 100 | 87 | 100% | 1,042 / 2,016 | 76 | 100% | 0 | 600 / 1,010 |

  Whole run: 6,665 requests, 100% available, 0 failed. Every save is a write that clears the course's feed cache, so in this run the feed of the first course is read from the database more often than in the US-38 run. That is the cost of showing a change at once. As before, every page slows past 25 users on this machine (single server process, a machine already busy), so latency is inconclusive.
- **Load:** `npm run load -- advice-edit` (the edit page of one's own advice in a course of 500 posts). Results below.

| Users | Requests | p99 ms | Errors | Target (p99 < 1 s) |
| ---: | ---: | ---: | ---: | --- |
| 1 | 1,025 | 23 | 0 | met |
| 10 | 2,101 | 77 | 0 | met |
| 25 | 2,237 | 179 | 0 | met |
| 50 | 2,399 | 422 | 0 | met |
| 100 | 2,293 | 702 | 0 | met |

  Supported within 1 s: 100 users. The saves are server-action POSTs that answer with a redirect, so they are measured in the availability run above, with their outcome checked.

## Tests

- Unit: `tests/unit/advice-changes.test.ts` (25: draft rules, own-advice read, edit, delete, limit, logging, actions and their redirects), `tests/unit/advice-edit-page.test.tsx` (6).
- Integration (real PostgreSQL): `tests/integration/advice-changes.test.ts` (8, including an edit/delete race).
- E2E: `tests/e2e/advice-changes.spec.ts` (6: edit through the form, unchanged save, unsafe link, anonymous stays anonymous, another student, visitor, delete). With the feed spec: 13/13 on the production build.
