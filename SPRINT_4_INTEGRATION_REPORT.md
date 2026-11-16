# Sprint 4 integration - 2026-11-16

Integrated the eight open PRs into a branch based on freshly fetched `origin/main` at `9f46e4f`. Lea's PR #38 is included following the user's explicit confirmation.

| PR | Feature |
| --- | --- |
| #33 | Course advice feed (US-38) |
| #34 | Edit/delete own advice (US-36) |
| #35 | Report advice (US-43) |
| #36 | Moderate reported advice (US-77) |
| #38 | Weak-topic practice, helpful votes, discussion, opinion/statistics labels, alternate mock versions |
| #39 | Answer keys, mock marking and learning evidence (US-49) |
| #40 | Mock results report (US-50) |
| #41 | Independent automated cross-tests of Ali Slim's stories |

Each PR head is retained as an ancestor through a separate merge commit. No force push or source-branch deletion is required.

## Integration decisions and fixes

- Combined advice editing/reporting/moderation with helpful votes, discussions, labels, feed caching and read limits. Most-helpful sorting bypasses the newest-feed cache, so the cached ordering cannot override vote ranking.
- Combined mock versions and marking/results with main's personalized selection and timer. Alternate versions retain the original time limit and exact length; insufficient unused questions are refused rather than silently shortening a version. A real-database regression covers a timed alternative whose questions stay hidden until Start.
- Corrected timer raw SQL to convert timestamp parameters explicitly to UTC. The initial real-database run in PostgreSQL's Asia/Beirut timezone reproduced a two-hour start/deadline shift and premature finalization inside the grace period. The timer/version regression suite then passed all 46 tests.
- Updated unit fixtures and mocks for the combined interfaces, moved the version rules test to the current selection module, and resolved the Vitest setup path absolutely for an isolated checkout.
- Updated browser tests to select the exact publishing login link and to remove advice through actual admin moderation. The latter now verifies cache invalidation and refusal of a stale reply after real moderation, rather than mutating status directly outside the application.
- Updated README's old branch-only integration notes: mock assembly, marking and results are present. Generated tasks remain NO_KEY without verified rubrics; future E5 profile sources remain outside this integration.

## Verification

A fresh disposable PostgreSQL instance at 127.0.0.1:55435 was used, with the database and storage confined to this local test environment. No shared database was migrated or seeded. Outbound email/webhooks were not configured.

- Prisma generate/validation: successful. All 28 migrations applied from an empty database; schema diff reports no difference.
- TypeScript and ESLint: passed, including the final browser-test changes.
- Unit/component suite: 1,626/1,626 passed. After the UTC correction, the affected timer/version tests passed 56/56.
- Integration coverage: 264 tests. The post-fix full run passed 263/264; the remaining pipeline performance assertion measured 1.138 seconds while browser tests competed for resources. The entire 12-test pipeline suite then passed in isolation, including its unchanged one-second-per-stage target. No threshold was relaxed.
- Browser coverage: 177 tests against a production build. The initial run passed 170, failed the two outdated advice tests described above, and skipped their five serial successors. After correcting the tests, both complete advice suites passed 14/14, covering the failures and all skipped cases. All 177 cases therefore have passing evidence across the full run and focused rerun.
- Production build: passed with type/lint checks and route generation.
- Existing grouping accuracy gate: passed; precision 100%, recall 86.8%, F1 92.9%, and rank correlation 94.2%.

Local logs are in the original checkout's ignored `reports/all-prs-*` files. Earlier feature-owner reports describe their original branches and are historical evidence; this report records the integrated state.

## Workspace preservation

The original checkout was already in an unfinished merge with staged, unstaged and untracked work. It was preserved. Integration and validation were performed in `.integration-work` on `integration/sprint4-all-prs`; the original merge was not aborted or overwritten. Local main and remote main can be advanced to this integrated result without replacing that unfinished working tree.
