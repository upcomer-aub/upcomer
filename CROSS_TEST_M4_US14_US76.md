# Sprint 2 cross-test: M4 tests M5 (US-14, US-76), and integration check

Tester: Mohammed Al-Haiqi (M4), also Integration Lead. Code tested: PR #26 (`ali_slim_sprint_2`, Ali Slim, M5) on top of `main` at `056b7d8`. Real PostgreSQL, real stored files, the real PDF.js extractor, a production build, and Chromium.

## Verdict

| Story | What the plan says the tester checks | Result |
| --- | --- | --- |
| US-14 Automatic question extraction | A typed PDF gives the correct question count; an image-only PDF fails with "no extractable text" | **Pass.** Correct counts on every layout tried. Image-only gives `no_text`, shown as "No extractable text was found in this PDF." Four extraction issues found, all fixed on this branch (see "Fixes on this branch") |
| US-76 See failed file processing | Failed runs show the stage and reason; retry works | **Pass.** The page shows status, stage, and reason; retry after fixing the file completes and the questions reach the ordered exam. One race under simultaneous retries found, fixed on this branch |
| PR #26 as a whole | CI green before merge | **Fail: blocks the merge.** One e2e test fails in CI, and the 3 after it in the same serial spec never run. See "CI failure". The fix is on this branch |

**Recommendation:** merge PR #26 together with the fixes on this branch (`test/m4-cross-test-us14-us76`), or have Ali apply them to `ali_slim_sprint_2`. At minimum the CI fix must go in before the merge; the other fixes can follow.

## Fixes on this branch

Each finding below was fixed after the cross-test, in its own commit on top of PR #26:

| Commit | Finding | Fix | Code owner to review |
| --- | --- | --- | --- |
| `bdb5874` | CI failure | `APP_URL: http://127.0.0.1:3000` added to the `e2e` job's `env` in `.github/workflows/ci.yml` | Ali Slim (M5) |
| `20345eb` | Issues 1-4 | `lib/exam-extraction.ts` skips page numbers ("Page 1 of 2", "- 3 -") and short scanner-app watermark lines; a section heading ("Part B", "Section II: Problems", "Questions") ends the question before it and is not kept; numbered items under an "Instructions" heading are held back and dropped once a section heading or numbering restarting at 1 shows the questions have begun (if neither comes, they are kept as questions). A page with only furniture now fails with `no_text` | Ali Slim (M5) |
| `9872856` | Issue 5 | `lib/exam-processing.ts` starts a run under `pg_advisory_xact_lock` on the file ID and, for a retry, checks again under the lock that the latest run is failed or stale. Of 5 simultaneous retries exactly one starts a run; the others get `not_failed` | Ali Slim (M5) |
| `85ed1cd` | Issue 6 (regroup part) | `rebuildQuestionBank` in `lib/question-bank.ts` writes new groups with one `createManyAndReturn`, updates only groups whose text, count, or rank changed, and moves questions with one `UPDATE ... FROM unnest(...)` instead of one statement per group | Ali Shammakh (M2) |
| `980b3ec` | Issues 1-5 | The `it.fails` known-issue tests in `tests/integration/cross-test-us14-us76.test.ts` are now normal tests of the fixed behavior; the retry race test now requires exactly one run to start | — |

Unit tests for each fix were added or updated in `tests/unit/exam-extraction.test.ts`, `exam-processing.test.ts`, and `question-bank.test.ts`. Issue 6 is only partly addressed: the upload still waits for extraction and regrouping, and the large-exam timings have not been measured again after the batching change.

## CI failure (blocks the merge)

`tests/e2e/password-reset.spec.ts`, "a registered email gets a single-use link that expires" fails with `Expected: 1, Received: 0`, then 3 tests do not run (61 of 64 in CI).

- **Cause.** PR #26 added `expect.poll(... passwordResetToken.count ...).toBe(1)` right after requesting a reset through the page. CI sets no `APP_URL`, so `requestPasswordReset` stops at `app_url_not_configured` before creating a link, as it does on `main`, and the count stays 0. Reproduced locally; with `APP_URL` set, all 4 tests pass.
- **Fix, either:** add `APP_URL: http://127.0.0.1:3000` to the `e2e` job's `env` in `.github/workflows/ci.yml`, or drop the new `expect.poll` line.
- **Also for Mustafa (M1):** PR #26 changes US-03 code outside US-14 and US-76. `requestResetAction` now runs the whole request after the response (`after()`), and the "sent" log is now written only after the email is accepted. These look reasonable, but it is Mustafa's story, so he should review them.

## US-14: extraction

`tests/integration/cross-test-us14-us76.test.ts` (real database, real PDFs built in code by `tests/integration/fixtures/layout-pdf.ts`).

| Layout | Result |
| --- | --- |
| Header full of numbers ("EECE 350 - Fall 2024", "Duration: 2 hours", "Page 1 of 1") and 12 questions numbered past 9 | 12, correct |
| Number and text drawn as separate pieces on one line | Joined correctly |
| Wrapped lines, `(a)`, `b)`, and `i.` sub-parts | Kept with their question |
| Lines starting with a decimal (`3.5 Mbps`) or a plain number (`100 packets`) | Not counted as questions |
| A question running across a page break | Counted once, text joined |
| Sections that restart numbering (Part A 1-2, Part B 1-2) | 4, correct |
| Image-only PDF | `FAILED`, stage `EXTRACTION`, `no_text`, "No extractable text was found in this PDF." |
| Blank pages, corrupt PDF, typed PDF with no numbered questions | `no_text`, `unreadable_pdf`, `no_questions` |

**Issues found** (first written as `it.fails` tests; all fixed in `20345eb` and now normal tests):

| # | Issue | Effect | Status |
| --- | --- | --- | --- |
| 1 | A page footer ("Page 1 of 2") is appended to the question before it | Footers appear in question text, and can stop two copies of a question from grouping | Fixed (`20345eb`) |
| 2 | A section heading ("Part B: Problems") is appended to the previous question | Same | Fixed (`20345eb`) |
| 3 | Numbered instructions before the first question ("1. Calculators are not allowed.") are counted as questions | Wrong count: 5 instead of 3 in the test | Fixed (`20345eb`) |
| 4 | A scan with a scanner-app watermark ("Scanned with CamScanner") fails with `no_questions`, not `no_text` | Common with phone scans; the admin is told "No numbered questions were found" for what is really an image | Fixed (`20345eb`) |

## US-76: failed runs and retry

| Check | Result |
| --- | --- |
| Image-only, blank, corrupt, and question-less PDFs each record their own reason at the extraction stage | Pass |
| Retry after the admin replaces the file with a typed copy | Pass: runs `FAILED, SUCCEEDED`, questions stored, exam updated |
| Stored file missing: `missing_file`; retry after it is restored | Pass |
| Retry of a successful run, an unknown file, or a material | Refused, no new run |
| Student submission: not processed while pending or after rejection; processed once published (with US-74) | Pass |
| An exam's runs are deleted with it | Pass |
| `/admin/processing` in the browser: Failed, "Text extraction", reason, Retry; Completed with no Retry; Retry then Completed; visitors sent to log in; students do not see it | Pass (`tests/e2e/admin-exam-processing.spec.ts`, 4 tests) |

**Issue 5: simultaneous retries (fixed in `9872856`).** Nothing locks between reading the latest run and starting a new one. With 5 retries at the same moment, 3 ran at once in local runs. In about 1 in 10 runs, the latest run then ended as `FAILED` ("Processing failed unexpectedly") although another run had extracted the questions, so the page showed a false failure. The questions themselves were always right (checked 30 times). It only happens with a double click or two admins at once. Fixed with a per-file `pg_advisory_xact_lock`, as `rebuildQuestionBank` does per course: exactly one of the 5 retries starts a run.

## Speed

The upload now waits for extraction and for the course regroup before it answers.

| Upload | Time |
| --- | --- |
| Typical exam: 10 pages, 30 questions | 63 to 211 ms |
| Large exam: 40 pages, 160 questions | 300 to 820 ms in the test runs; 1.16 to 1.3 s when measured alone. About 0.5 s is extraction and about 0.8 s is `rebuildQuestionBank` saving 160 groups one by one |
| 2,000 blank pages (0.5 MB) | 1.1 to 1.8 s, then `no_text` |

**Issue 6 (partly addressed in `85ed1cd`):** large exams can go past the 1 s target, because the admin waits for extraction and regrouping. Running the processing after the response (as PR #26 already does for password reset with `after()`), or saving groups in batches, would keep uploads fast. Groups are now saved in batches; processing still runs before the response. The timings above are from before that change.

## Integration Lead: the whole sprint end to end

One realistic journey on `main` + PR #26, with a production server, a real database, and Chromium. **22 of 22 checks passed:**

- **US-04:** a new student edits name and major; both are saved and shown.
- **US-03:** a registered and an unknown email get the same page; only the registered one gets a link row.
- **US-14:** two admin uploads give 3 and 2 questions, each with one succeeded run.
- **US-13:** a typed and a scanned exam are submitted and stay pending, unprocessed, and hidden from other students; a Word file is refused.
- **US-74:** the queue lists them oldest first; publishing the typed one extracts its 2 questions.
- **US-76:** the scan shows "Failed", "Text extraction", "No extractable text"; after the file is fixed, Retry completes.
- **US-15a, US-16, US-20:** case and numbering variants are grouped; the question in the most papers ranks first; a keyword search keeps only matches, in ranking order.
- **US-17, US-18, US-19:** each question appears once, in ranking order, with "Appeared in 4 of 4 papers" and "2 of 4"; tiers are shown; an empty course shows its empty message.
- **Logs:** processing failures are logged with stage and reason; no titles, emails, or passwords appear in the logs.

## Results

Before the fixes (PR #26 + cross-tests):

| Command | Result |
| --- | --- |
| `npm run lint`, `npx tsc --noEmit` | Passed |
| `npm test` | 701 passed |
| `npm run test:integration` | 31 (PR #26) + 21 cross-tests passed; the cross-tests passed 30 runs in a row |
| `npm run test:e2e` | 64 passed, including the 4 new processing tests; the 1 password-reset failure and 3 not run are the CI failure above |

After the fixes (this branch at `980b3ec`):

| Command | Result |
| --- | --- |
| `npm run lint`, `npx tsc --noEmit` | Passed |
| `npm test` | 709 of 710 passed. The 1 failure is the random-course test in `consolidated-exam-edge-cases.test.tsx` timing out at 25 s under full-suite load; it passes alone in 1.3 s and its code is not changed here |
| `npm run build`, `npm run test:integration`, `npm run test:e2e` | Not run again yet (no local database); CI runs them on push |
