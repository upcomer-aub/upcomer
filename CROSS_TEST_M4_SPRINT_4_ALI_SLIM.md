# Cross-test of Ali Slim's Sprint 4 stories (US-25, US-29, US-44, US-73)

Tester: Mohammed Al-Haiqi (M4). Developer: Ali Slim (M5). Code under test: `origin/main` at `c578ba0` (PR #37 and Ali Slim's Sprint 4 commits `5c5e5a4`, `0af30df`, `6cc59ca`).

The sprint plan's checks, tested independently of Ali Slim's own tests, in `tests/integration/cross-test-m4-sprint4.test.ts` (15 tests, real PostgreSQL, real PDFs processed by the pipeline):

| Story | Tester's check (plan) | Verdict |
| --- | --- | --- |
| US-25 | Question and mock outcomes update the correct student/course/topic, without duplicate events | **Pass** (7 tests) |
| US-29 | Rationale matches saved confidence, correct/incorrect outcomes and exam frequency | **Pass** (2 tests) |
| US-44 | Generated questions reflect the course papers, stay in course scope and avoid exact repeats | **Pass** (3 tests) |
| US-73 | Admin replaces/removes a file without leaving stale source links or incorrect rankings | **Pass** (3 tests); one e2e test defect fixed (finding 1) |

## What was checked

**US-25**
- A question-bank outcome updates only that student, that course, and the question's paper topic. Another student, another course and another topic get no profile row.
- Replaying the same event is a duplicate and changes nothing. Replaying it with the other outcome is refused (`duplicate_conflict`). Three deliveries of the same event at once record it once.
- A `MOCK_EXAM` outcome for a past-paper question updates the same topic once. A generated item's outcome goes through `recordMockOutcomes` once, and is refused for another student (a stolen item).
- An outcome for another course's question is refused and changes nothing.
- The stored weakness equals the documented formula `(2 x baseline + incorrect) / (2 + correct + incorrect)`.

**US-29**
- After a confidence save (2 of 5) and 1 correct + 2 incorrect outcomes, the rationale states "Saved confidence: 2 of 5", "1 correct and 2 incorrect recorded outcomes", "Appeared in 1 of 2 published exam papers", and the same priority the sorting uses (`personalPriority`). It also says history is not a guarantee.
- With no evidence it claims nothing: "No saved confidence rating", "No recorded performance evidence", and a neutral weakness.

**US-44**
- Every generated task's source is a question of this course's published exam papers with the requested topic. A pending paper and another course's paper are never used. Each task contains its source's words.
- Generating again and again never returns the same task twice. Once the sources are used up it refuses (`insufficient_novel_questions`) instead of repeating.
- Each student's library is private and stays in its course.

**US-73**
- Replacing a paper replaces its questions. The consolidated exam no longer has the old question and has the new one. The practice items generated from the old question are gone.
- Removing a paper lowers the course's paper count. A question that was also in the removed paper now says "1 of" instead of "2 of" and no longer lists that paper. No empty question group is left, and earlier learning events keep their history.
- A stale page (`stale`) and an unconfirmed removal (`confirmation_required`) are refused and change nothing.

## Findings

1. **Fixed (test defect, made main's CI red).** `tests/e2e/ali-slim-sprint4.spec.ts:96` used `page.getByRole("alert")`. That also matches Next.js's route announcer, so the US-73 e2e test failed in strict mode ("resolved to 2 elements") on main's CI since 2026-11-15. It is now scoped to `main`. It is the first commit of this branch and of my Sprint 4 PRs, so they merge in any order. With it, the spec passes 4/4 and the whole e2e suite passes 111/111 on main + this fix.
2. **Design note, US-25 contract (not a failure).** `recordLearningEvents` is all or nothing. One event whose source is no longer published refuses the whole batch with `not_found`. A producer that sends a batch (a marked mock exam) must fall back to one event at a time. US-49 does this, but every future producer has to know it. Suggestion: return a result per event, or document the fallback next to the function.
3. **Integration now available (acceptance boundary).** The plan accepts US-25 only partly until the mock-exam producer exists. US-49 (my PR) now produces `MOCK_EXAM` events from marked exams, with stable IDs, and its integration and e2e tests check that the profile changes once per marked question and never for an unkeyed one. Flashcards and AI events (E5) remain out of this sprint, as the plan says.
4. **Team note (seen while building US-38).** `lib/rate-limit.ts` keeps its counters in a module-level `Map`. Next.js bundles server actions apart from pages, so a limit counted in an action and checked on a page (or the reverse) would see different counters. No current limit crosses the two. The advice feed cache had this bug and now lives on `globalThis`.

## Results

- Cross-test: 15/15 pass (integration, real database).
- Ali Slim's own suites on main + fix: `tests/integration/sprint4-ali-slim.test.ts` 21/21; `tests/e2e/ali-slim-sprint4.spec.ts` 4/4.
- Full suites on this branch (main + the fix + this test): tsc and lint clean, build passes; unit 1,290/1,290; integration 177/177; e2e 111/111 (production build, 1 worker).
