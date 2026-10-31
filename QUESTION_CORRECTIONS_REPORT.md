# Question corrections (Sprint 3)

> As an admin, I want to correct wrongly extracted or grouped questions so that the frequency ranking stays accurate.

Jira: SCRUM-14 E7 (Admin), Must, 5 points. Built by Mohammed Al-Haiqi on branch `question-corrections-sprint-3`, on top of PR #26 (US-14 extraction, US-76 processing runs) and the M4 cross-test fixes for it.

## Acceptance tests

| Acceptance test | How it is met | Tested in |
| --- | --- | --- |
| Given a wrongly grouped question, when the admin moves it to another group or splits it out, then the counts and ranking update | "Move to group" pins the question to a question of the target group; "Split into its own group" marks it split. Both regroup and re-rank the course right away (`rebuildQuestionBank`) | Integration: a move takes OSI from 2 to 3 papers and to rank 1, and the old group disappears; a split takes TCP from 3 to 2 papers and adds a 1-paper group. e2e: the same through the pages |
| Given a wrongly extracted question, when the admin edits its text, then the corrected text shows to students | The edit replaces `Question.text` and regroups, so the question bank and the ordered exam show the new text, and the fixed wording groups with matching questions | Integration: "Explian TCP slow strat." becomes "Explain TCP slow start." in the ordered exam and search finds it. e2e: a visitor's `/courses/:id/exam` shows the new text and not the old one |
| Given any correction, when the pipeline runs again, then the correction survives and is recorded in the activity log | Moves and splits are stored on the question and applied by every rebuild after the automatic grouping; a corrected text is never re-extracted. Every correction is a row in `QuestionCorrection` with the admin, paper, question number, and before and after values | Integration: after reprocessing every paper, "Regroup and rank", and uploading a new paper through the real route, every correction is still in place, the new paper's copies join the corrected groups, and the log has exactly the three corrections. e2e: the same after "Regroup and rank", with the log table |

## What was built

- **Schema** (`prisma/migrations/20261023000000_question_corrections`): `Question.pinnedToQuestionId` (self-relation, set to null when the pinned-to question is deleted), `Question.splitOut`, `Question.textCorrectedAt`, the `CorrectionKind` enum, and the `QuestionCorrection` activity log.
- **Grouping** (`groupCorrectedQuestions` in `lib/question-grouping.ts`): automatic grouping of the uncorrected questions first, then split questions as groups of their own (a key that no automatic key can equal), then pinned questions into the group of the question their pin chain ends at. A missing pinned-to question or a loop of pins counts as no pin. `rebuildQuestionBank` uses it, so every existing caller (upload, processing, retry, publish, "Regroup and rank") applies corrections.
- **Pinning to a question, not a group.** A group's key comes from its first question's text and can change when papers come and go; a question ID does not. Moving a question picks an anchor that is in the target group by its own text. Before a question leaves its group, questions that were moved onto it are re-pinned to one that stays, so they are not dragged along.
- **Service** (`lib/question-corrections.ts`): each correction runs in a transaction under the same per-course advisory lock as `rebuildQuestionBank`, checks that the question is a published exam question of the course (and the target group belongs to it), saves the change and its log row, then regroups. A failed regroup keeps the correction and says so. An edit carries the text the admin saw; if it changed meanwhile, the edit is refused as stale instead of overwriting another admin's fix.
- **Pages:** `/admin/questions/:courseId` (groups 20 per page, keyword search, correction tags, activity log) and `/admin/questions/:courseId/:questionId` (edit, move, split, undo, history), linked from `/admin/questions` as "Correct questions". Plain POST forms and server actions, `requireAdmin()` first.

## Shared files touched

| File | Change |
| --- | --- |
| `lib/question-bank.ts` (M2) | The rebuild reads `pinnedToQuestionId` and `splitOut` and groups with `groupCorrectedQuestions`; `courseExams` is exported |
| `lib/question-grouping.ts` (M2) | New `groupCorrectedQuestions` and `splitGroupKey`; the automatic grouping is unchanged |
| `lib/submission-review.ts` (mine, US-74) | The readable-text check moved to `lib/readable-text.ts` so the edit form uses the same rule |
| `lib/logger.ts` | Five `question_correction*` events |
| `app/admin/questions/page.tsx` (M2) | A "Correct questions" link per course |
| `prisma/schema.prisma`, `README.md` | Schema and documentation |

## Professor's checklist

| Point | What this story does |
| --- | --- |
| **Responsiveness (100 ms to 1 s), shown in the logs** | `question_corrections_page` and `question_correction_edit`, `_move`, `_split`, `_reset` print `operation_timed` lines; over 1 s is also `slow_operation`. A correction including the course regroup took 24 to 167 ms (21 corrections against the production server in the e2e runs) |
| **Load testing** | `npm run load -- question-corrections`: a course with 40 papers, 1,000 questions in 200 groups, and 50 logged corrections, opened by 1 to 100 admins at once. Results below |
| **Monitoring and logs** | `question_corrected` (who corrected what, and whether the regroup succeeded), `question_correction_refused`, `question_correction_rate_limited`, `question_correction_failed`, `question_correction_retrieval_failed`. IDs and reason codes only; the question text is never logged or put in a URL |
| **Caching** | Not used: two admins must see each other's corrections at once. The pages are `force-dynamic` |
| **DoS** | Admin-only pages and actions; `CORRECTION_RATE_LIMIT_PER_MINUTE` (default 60) per admin, checked before any database work, since each correction regroups a whole course; the group list is paginated and the log capped at 50 |
| **Automated UI tests (like Selenium)** | Playwright, `tests/e2e/admin-question-corrections.spec.ts` |

### Load test result (local, 2026-10-23, production build)

The machine was heavily loaded during this run (CPU 65 to 83% before the test started, from other processes), so the absolute numbers are low. The same-day run of the existing review-queue scenario is the baseline: on 2026-10-18 it met the target with 25 admins, today it missed at 10.

| Users | Corrections page p99 | Server data p50 | Review queue p99 (baseline, same day) |
| ---: | ---: | ---: | ---: |
| 1 | 300 ms | 51 ms | 180 ms |
| 10 | 2,483 ms | 364 ms | 1,461 ms |
| 25 | 3,961 ms | 562 ms | 2,726 ms |

The corrections page does about 60% of the review queue's throughput (it renders 20 groups with about 100 questions and a 50-row log). After this run, the course lookup and the group count were made to run at the same time. It should be measured again on a quiet machine before drawing conclusions about the number of admins supported.

## Run it

```
npx prisma migrate deploy
npm test
npm run test:integration   # needs DATABASE_URL
npm run build && npm run test:e2e
npm run load -- question-corrections
```

## Results (local, fresh PostgreSQL database)

| Command | Result |
| --- | --- |
| `npm run lint`, `npx tsc --noEmit` | Passed |
| `npm test` | 747 passed (37 new). With the default worker count on the loaded machine, the existing random-course test in `consolidated-exam-edge-cases.test.tsx` timed out once at 20 s; it passes alone and with `--maxWorkers=2` (1.7 s), and none of its code is changed here |
| `npm run test:integration` | 67 passed: 15 new in `question-corrections.test.ts`, and the 52 existing ones, unchanged |
| `npm run build` | Passed |
| `npm run test:e2e` | 72 passed with `--workers=2`, 4 of them new. With the default 6 workers on the loaded machine, admin logins took over the 5 s wait in 7 specs (no login failed in the server log) |

## Found while building

- **A question moved onto another must not leave with it.** The first version let questions pinned to a question follow it when it was moved again, which would silently move several questions. Now they are re-pinned to a question that stays (or, if none stays, kept together by their own text). Integration test: "moves a question back out of a group without taking the questions moved onto it".
- **Two admins editing the same question.** Without a check, the second save would overwrite the first. The edit form carries the text the admin started from, and a changed text is refused as stale. Integration (concurrent) and e2e tests.
