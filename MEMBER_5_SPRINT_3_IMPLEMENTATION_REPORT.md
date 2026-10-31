# Ali Slim - Sprint 3 implementation and verification

Branch: `ali_slim_sprint_3`, created from current GitHub `main` at `62dae61` on 2026-10-31. Work was implemented and tested with AI assistance for Ali Slim to review.

## Assigned scope

- US-14: fix automatic question extraction (8 SP, carried from Sprint 2).
- US-76: failed-file processing visibility and retry (3 SP, carried from Sprint 2).
- Monitor extraction failures, failed-run records and retry outcomes.
- Cross-test Ali Shammakh's US-15b (reworded grouping) and US-23 (question reports).

The Sprint 2 extraction implementation and Mohammed's fixes were already in `main`, through PR #27. They were retained and verified rather than recreated. They include the PDF.js reader, question storage, processing-run schema, upload/publish integration, admin processing page, safe failure reasons, per-file retry lock, page-furniture filtering, and numbered-instruction filtering.

## What changed here

### US-14

Extraction now also accepts colon-numbered and compact labels, such as `1: Define latency.`, `2)Explain throughput.`, `(3)Describe jitter.` and `Q4.Explain ARP.`. The question-bank cleaner recognizes the same forms, so printed numbering does not leak into the displayed question or affect grouping. A decimal (`3.5 Mbps`), a time (`1:20`) or an alphabetic sub-part is kept inside the current question. The new unit test uses a real generated typed PDF and compares the full extracted strings.

The existing real-PDF/database tests were rerun for all earlier findings: page footers, section headings, numbered instructions, scanner watermarks, questions crossing pages, separately drawn numbers/text, numbering beyond 9, image-only/blank/corrupt/question-less PDFs, and upload/publish integration.

### US-76 and monitoring

- Added `exam_processing_started` and `exam_processing_completed`, including file/course/run IDs, retry flag, counts and duration.
- Failure events now carry the retry outcome and timing when a run started.
- Added `exam_processing_record_failed`: a failure to save the failed-run record was previously swallowed silently. The console/shared monitoring now records that separate problem.
- Added `exam_processing_retrieval_failed` for a processing-list read error.
- Added `exam_retry_refused` for duplicate/ineligible retry attempts.
- A database error when looking up the latest failed run now returns the controlled `unexpected` result instead of escaping from the retry action.
- The processing page ignores a run that disappears between the file and relation reads. The retry reliability test exposed this concurrent-deletion crash during database-test cleanup; a regression test covers the empty relation.
- Tests verify that retrying failed grouping preserves existing questions, unauthorized actions never invoke the retry service, and logs omit extracted text and error messages.

Existing behavior remains: failed attempts are retained, each accepted retry creates a new run, a successful or recent running attempt cannot be retried, and simultaneous retry clicks start one run under the existing per-file database lock. An interrupted run can be retried after the existing 15-minute cutoff. The processing page continues to show file, status, stage, reason and Retry.

### Integration repairs and assigned cross-test findings

Validation exposed existing merge errors on `main`. Repairs were necessary to build and verify the assigned features:

- Removed the extra semicolon inside the shared logger's event union.
- Removed duplicate Course fields from Prisma, retaining every relation from both sides of the merge. No new migration was required.
- Removed duplicate imports and the duplicate `ranked` declaration in the question-bank rebuild. Kept the corrected-question grouping path, batched persistence and rewording monitoring together.
- Gave explicit split groups the `reworded: []` field expected by grouping monitoring.
- Updated old test fixtures for the merged group interfaces and batched writes. The evaluation-metrics test now uses an unsupported expanded acronym for its deliberately missed match, since Explain/Describe is supported by US-15b.
- The assigned accuracy cross-test found two false merges: different subnet counts and different approximation accuracy requirements. The matcher now preserves those task constraints. Neither the US-93 gold set nor its thresholds/baseline was changed.
- Excluded generated Playwright reports/results and coverage from ESLint, so source checks work after browser tests and do not scan transient generated files.

Detailed checks, defects and accuracy numbers are in `CROSS_TEST_ALI_SLIM_US15B_US23.md`.

## Validation

Tests use a disposable PostgreSQL 16.14 instance on localhost port 55432, with a new `upcomer_sprint3_test` database. No existing/shared database or `.env` was used. The portable database runtime was installed under the OS temporary directory; project dependencies and lockfile were unchanged. The standard seed created the test-only admin and course fixtures.

After the final run, Ali Slim's test prefixes had zero remaining courses, files, students or faculties. The temporary database server was stopped. Test-only database settings were passed to the commands, not saved in the repository.

| Check | Result |
| --- | --- |
| `npx prisma generate` | Passed |
| `npx prisma migrate deploy` on the empty test database | All 14 existing migrations applied |
| `npm run db:seed` | Passed |
| `npm.cmd test -- --maxWorkers=2` | Second pass: 938 tests passed in 62 files, including variable-label and queued-retry regressions |
| `npm run test:integration` | Second pass: 91 tests passed in 9 files, including retries of a scan that immediately fails again |
| `npm run lint`, `npx tsc --noEmit`, `git diff --check` | Passed |
| `npm run build` | Passed; browser verification also builds afresh |
| `npm run eval:grouping` | Passed, with the existing baseline/thresholds |
| `npx.cmd playwright test --workers 2`, `CI=true` | Second pass: 85 passed, no failures or skipped tests, against a fresh production build (4.7 minutes including build) |
| Schema versus migrated database | Passed: `prisma migrate diff` reported no difference |

The committed synthetic accuracy set gives **100% pair precision, 86.8% recall, 92.9% F1, 94.2% rank correlation and 100% top-5 precision**. Some equivalent rewordings are still missed; the report names them. This does not establish accuracy on arbitrary real exams.

### Reliability and timing

`tests/e2e/exam-processing-reliability.spec.ts` adds 50 seeded randomized trials per owned feature against a production server:

- US-14, seed `271003`: typed PDFs with varying question counts/label formats; scans, blank pages, corrupt PDFs and typed pages with no questions. Checks exact stored question text/count, or the expected failure stage/reason.
- US-76, seed `271076`: upload a failing scan, then retry through the actual admin page after replacing it with typed text, leaving it scanned, removing it, corrupting it, or replacing it with unnumbered text. Checks two run records, the new outcome/reason, question count and Retry visibility. Also checks that start, successful-retry and failed-retry events reach the persisted log store.

Both feature trials passed **50/50**. Extraction cases: 16 typed, 9 scans, 8 blank, 10 corrupt and 7 unnumbered PDFs. Retry cases: 12 fixed, 9 still scanned, 9 missing, 10 corrupt and 10 unnumbered PDFs. The monitoring persistence assertions also passed. These are bounded correctness trials on generated fixtures, not a production availability guarantee or a load-capacity test.

Earlier verification failures were investigated rather than hidden: the first new browser helper did not send production's Secure cookie through Playwright's HTTP API client, so it was changed to use the authenticated browser; all 82 existing browser tests had passed. The next run passed 83 tests and found the concurrent-deletion processing-page crash described above. An integration run overlapping the browser/reliability load also exceeded the existing 1-second pipeline timing assertion. Final integration and browser runs are performed separately; that timing threshold was not relaxed.

The final real-database extraction cross-test's local timing samples were 112 ms for a 10-page/30-question upload, 249 ms for a 40-page/160-question upload, and 1,941 ms to reject a 2,000-page blank PDF (496,138 bytes). These are single-run observations on this machine. Processing still runs before the upload response; there is no background worker or queue.

## Second review pass

A second comparison with the plan checked US-14/US-76 behavior, monitoring, the US-15b/US-23 cross-tests, and the 50-trial reliability requirement. It found two additional edge cases, confirmed with failing regression tests before fixing them:

- Compact-label recognition also matched variables such as `Q2value`, splitting a wrapped question and dropping part of the variable during question-bank cleanup. Compact labels now require preceding label punctuation; whitespace-separated and standalone labels remain supported.
- A queued retry could start another attempt if the first retry had already failed again. The admin form now includes the displayed run ID, and both the initial lookup and the per-file locked check verify the run identity. A stale tab is refused; a later deliberate retry of the latest failed run still works. Added unit, real-database burst, and two-tab browser regressions.

`lib/exam-processing-actions.ts` now forwards the displayed run ID after checking admin access. Additional regressions are in `tests/integration/cross-test-us14-us76.test.ts` and `tests/e2e/admin-exam-processing.spec.ts`. No schema, dependency or migration change was required by the second pass. Its final check totals supersede the first-pass totals above.

The second pass passed all 938 unit/component tests, 91 integration tests, 85 browser tests, both 50-trial reliability checks, lint, TypeScript, the production build and the unchanged grouping-accuracy thresholds. The added two-tab browser regression passed. Cleanup checks found zero remaining courses, files, students or faculties under the `slim-`, `qa-proc-` and `it-m4-` test prefixes, and the temporary database was stopped again.

## Final requirement-by-requirement audit

The third pass compared the actual Sprint 3 plan with the implementation, test assertions, saved full-suite results and branch history. No further application-code changes were needed. Application and test source still match `7075bb7`, the commit validated by the full second-pass runs. Lint, TypeScript and the committed grouping evaluation were checked again; the unchanged full database/browser suites were not rerun merely to repeat their results.

| Requested or assigned work | Completion and evidence |
| --- | --- |
| Create a new implementation branch from main | Complete: `ali_slim_sprint_3`, based on `62dae61`; main unchanged |
| US-14: correct typed-PDF question count and content | Complete for supported numbered text layouts: real-PDF unit tests and `cross-test-us14-us76.test.ts`; published uploads feed the ranked exam |
| US-14: image-only PDF fails with no extractable text | Complete: database and browser assertions check `no_text`, its displayed reason, and no stored questions |
| US-14: earlier extraction defects are gone | Regression checks cover page furniture, scanner watermarks, section headings, numbered instructions, split text items, wrapped questions and sub-parts |
| US-76: show file, failed stage and reason | Complete: admin processing page, page tests and `admin-exam-processing.spec.ts` |
| US-76: retry creates a new run and updates the list | Complete: missing/replaced files, successful and unsuccessful retries, preserved history, stale/racing requests and access control are tested |
| Monitor extraction, failed-run records and retry outcomes | Complete: start/completion/refusal/error events; unit checks for failure-record/read errors; production reliability tests verify persisted successful and failed retry events |
| Cross-test US-15b | Automated cross-tests complete: rewording, changed sample values, distinct same-topic questions, course isolation, stable rebuilding and unchanged US-93 acceptance thresholds |
| Cross-test US-23 | Automated cross-tests complete: actual question/course in the admin queue, two students in one queue item, duplicate/racing report refusal, invalid input and report snapshots after regrouping |
| Run 50 randomized production-build trials per owned feature | Complete: US-14 50/50 and US-76 50/50, with fixed seeds and case counts above |
| Test the implementation and retain regressions | Complete: latest full runs passed 938 unit/component, 91 integration and 85 browser tests; build, lint, types, accuracy and schema checks passed |
| Report what changed, shared files, results and unfinished items | Complete: this report, the separate cross-test report and README; no supplied PDF or project dependency changes |
| Ali Slim's demo step | Locally exercised by the production browser tests: typed upload, scanned failure, visible reason, file repair and successful retry; live deployed presentation remains a team activity |

The original request's local coding, automated testing and reporting work is complete. This does **not** mark every row of the sprint's team Definition of Done complete:

- Mohammed's independent acceptance and a teammate's PR approval are still pending; rerunning tests cannot supply their personal sign-off.
- Ali Slim's review of the AI-assisted code and results is still pending.
- Remote CI, merging, branch-rule enforcement and the deployed full-sprint journey remain unverified. No push, PR, merge, repository-setting change or deployment was requested or performed.
- Jira status and the live review/demo were not updated or performed.
- No private real-paper accuracy set was supplied. The assigned accuracy check passed on the available versioned synthetic set; no claim of arbitrary real-paper accuracy is made.

## Files touched outside Ali Slim's extraction/processing files

- `lib/logger.ts`: event-union repair and processing monitoring events/levels.
- `lib/question-bank.ts`: duplicate merge repair; preserve corrections, batching and monitoring.
- `lib/question-grouping.ts`: extraction-label cleanup, split-group metadata and the two accuracy defects.
- `prisma/schema.prisma`: duplicate Course-field repair, retaining corrections/reports/progress/profile relations.
- `tests/unit/question-bank.test.ts`, `tests/unit/question-grouping.test.ts`, `tests/unit/grouping-eval.test.ts`: interface/batching fixes and regressions above.
- `tests/integration/cross-test-us14-us76.test.ts`, `tests/e2e/admin-exam-processing.spec.ts`: appended fast-failure burst and stale-tab regressions; retained the earlier cross-test checks.
- `eslint.config.mjs`: ignore generated test artifacts.
- `README.md`: behavior, events, verification commands and report links.

Ali Slim's other changes are in `lib/exam-extraction.ts`, `lib/exam-processing.ts`, `lib/exam-processing-actions.ts`, `app/admin/processing/page.tsx`, the three extraction/processing unit test files, `tests/integration/cross-test-us15b-us23.test.ts`, `tests/e2e/exam-processing-reliability.spec.ts`, and these two new reports.

## Not done / hand-off

- No OCR, arbitrary document-layout support, non-PDF extraction, asynchronous job queue or replacement-file upload UI was added. Scans fail clearly and need a typed/searchable replacement before retry.
- No private real-paper evaluation set was supplied, so only the committed synthetic US-93 set and generated PDFs were evaluated.
- Mustafa's confidence/priorities implementation and deployment, the Integration Lead's branch ruleset/merging tasks, and other members' assigned stories were not implemented here.
- Mohammed still needs to perform/review the independent acceptance cross-test of Ali Slim's US-14/US-76. Automated reruns of his existing tests do not claim his personal sign-off.
- Ali Slim must review the AI-assisted changes/results. Shared grouping/schema repairs need their owners' review.
- No Jira updates, teammate messages, pull requests, pushes, merges, branch deletions, GitHub settings or deployment changes were made. `main` was left unchanged. CI on a pushed branch and the complete deployed Sprint 3 journey remain unverified.
- The supplied `Upcomer_Sprint_3_Plan.pdf` remains an unchanged, untracked local input and is excluded from commits.
