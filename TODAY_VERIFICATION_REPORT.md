# Verification of today's merges and ranking fix

Date: 2026-11-16. Result: all final automated checks passed.

## Verified code and GitHub state

- Tested `.integration-work`, branch `fix/non-question-extraction`, application revision `6fec728`, including the original ranking fix `93374e7`. The audit follow-up commit contains only two browser-test assertion corrections and this report.
- All eight PR heads (#33, #34, #35, #36, #38, #39, #40, #41) are ancestors of the tested checkout, including Lea's PR.
- GitHub main remains `54e78d8`. Its [CI run completed successfully](https://github.com/upcomer-aub/upcomer/actions/runs/43805310683). No open PRs remained when checked during this audit.
- The ranking fix and audit follow-up remain local; they have not been pushed or merged into GitHub main.
- The original checkout's older unfinished merge and uncommitted work were preserved. That checkout was not used as the application under test.

## Final results

| Check | Result |
| --- | --- |
| Unit/component tests | 1,653 / 1,653 passed, 106 files |
| Integration tests | 269 / 269 passed, 29 files |
| Full browser suite | 178 / 178 passed, no skipped tests or retries |
| Production build | Passed, including route compilation and type/lint validation |
| Final TypeScript and ESLint | Passed |
| Grouping accuracy gate | Passed; precision 100%, recall 86.8%, F1 92.9%, rank correlation 94.2% on the committed synthetic evaluation set |
| Fresh database installation | All 29 migrations applied |
| Upgrade from populated main schema | Passed; preserved question IDs, groups, correction history, outcomes, profiles and generated questions |
| Schema drift after upgrade | No difference detected |
| Dependency consistency | Installed Next, React, Prisma/client, Vitest and Playwright match package-lock.json |

The final browser run started a fresh production server from the unchanged build of the tested application revision. Its random-course regression replayed `EXAM_E2E_SEED=189170`, the exact previously failing seed. Coverage includes login/permissions, upload/extraction/grouping/ranking, confidence and learning evidence, generated practice, advice/search/votes/discussions/reports/moderation, mock configuration/versions/personalization/timers/marking/results, and mobile light/dark layouts. Existing extraction/retry reliability trials ran as part of the full browser suite.

All database work used disposable PostgreSQL on 127.0.0.1:55435 in the Asia/Beirut timezone, exercising the earlier UTC timer fix. The shared database was not migrated, seeded or cleaned. Outbound email and alert webhooks were disabled. No test thresholds, evaluation gold data, dependencies or repository CI configuration were relaxed or changed. The disposable audit databases were stopped and removed afterward.

## Findings corrected

1. **Application regression: ungrouped papers appeared to have no exams.** The initial ranking fix required a non-null group ID when counting papers. That hid valid papers awaiting grouping instead of showing the preparation state. Counts now use non-excluded source entries without requiring grouping to have finished. Regrouping persistently excludes definite non-questions, including empty numbered labels, while retaining the original source text. This keeps instruction-only papers out of frequency counts after cleanup and preserves valid pending papers. Added a database regression and replayed the failing browser seed.
2. **Ambiguous admin-test assertion.** The new test assumed only one excluded entry was visible. Both automatic and manual exclusions now appear. The assertion targets its own entry and retains the visibility check.
3. **Parallel-test coupling in moderation.** A test assumed the entire queue would be empty after keeping its own post, although another suite could create reports concurrently. It now checks that its own post leaves the queue and has no open reports, preserving the dismissed-report and visible-feed assertions.

The final complete runs supersede the initial failures. No unresolved automated-test failure remains.

## Activation and limits

The verified fix is local in `.integration-work`. Shared-user activation still requires publishing/merging the fix, running `npx prisma generate` and `npx prisma migrate deploy` in the intended environment, then **Admin > Question Bank > Regroup and rank** for affected courses. This audit did not perform those production actions.

Filtering is conservative: known boilerplate is removed; unfamiliar ambiguous content may still need an admin's reversible exclusion. This verification covers the implemented behavior and fixtures, not every possible real PDF layout.

Evidence: the original checkout's ignored `reports/today-audit-*` logs. Final browser HTML report: `.integration-work/playwright-report/today-audit`.
