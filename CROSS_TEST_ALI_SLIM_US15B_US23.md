# Sprint 3 cross-test: Ali Slim tests US-15b and US-23

Code under test: Ali Shammakh's reworded grouping and question reports, already merged into `main` at `62dae61`. Verification and repairs are on `ali_slim_sprint_3`. These are AI-assisted automated cross-tests prepared for Ali Slim; they do not represent a teammate's approval or a human-run acceptance session.

## Checks

`tests/integration/cross-test-us15b-us23.test.ts` adds six tests against an isolated PostgreSQL 16 database, using the real grouping, ranking, report and queue services:

| Check | Result |
| --- | --- |
| TCP/UDP rewordings join one group; changed packet sizes/link speeds join one exercise | Passed |
| TCP/IP and TCP congestion control remain separate questions | Passed |
| Rebuilding again preserves IDs, paper counts and ordering | Passed |
| Equal text in different courses stays separate; pending papers do not count | Passed |
| Five simultaneous reports by one student create exactly one open report; four return `duplicate` | Passed |
| The stored report uses the actual question, course and student | Passed |
| Two students' reports appear in one admin queue item, with both notes | Passed |
| Invalid reasons, oversized notes, nonexistent groups and unpublished questions are refused | Passed |
| If a regroup removes the reported group, its question snapshot survives in the queue | Passed |

The existing `tests/e2e/question-reports.spec.ts` covers the browser journey: public reworded exam, student report, duplicate refusal, and admin queue. The full browser run and its result are recorded in `MEMBER_5_SPRINT_3_IMPLEMENTATION_REPORT.md`.

## Defects found and fixed

The initial merged code could not compile: the logger type ended early, the Prisma Course model repeated its fields, and `rebuildQuestionBank` declared its imports and `ranked` twice. The corrected regroup path now preserves admin corrections, batched writes and rewording monitoring together. Explicit split groups now include the empty `reworded` list expected by the monitoring code, avoiding a runtime crash after a split. Stale test fixtures were updated to the merged interfaces; the metric test's missed rewording now expands TCP rather than using the newly supported Explain/Describe synonym.

The first US-93 evaluation failed. It merged the 4-subnet and 8-subnet tasks, and merged approximation requirements of 0.001 and 0.01. Those numbers define distinct tasks in the versioned gold set. The fix retains subnet-count and approximation-accuracy constraints during reworded comparison, while still allowing changed numerical sample values in packet-delay and binary-conversion exercises. Focused regression tests cover both false merges.

## Grouping accuracy

The committed synthetic US-93 set is unchanged: 16 papers, 78 questions, 32 gold groups. Neither the baseline nor the acceptance thresholds was changed.

| Metric | Initial merged behavior | After fixes | Recorded baseline |
| --- | ---: | ---: | ---: |
| Pair precision | 94.7% | 100.0% | 100.0% |
| Pair recall | 86.8% | 86.8% | 56.6% |
| Pair F1 | 90.6% | 92.9% | 72.3% |
| Exact gold groups | 75.0% | 87.5% | 62.5% |
| Correct paper counts | 73.1% | 80.8% | 43.6% |
| Rank correlation | 76.4% | 94.2% | 87.7% |
| Top 5 precision | 90.0% | 100.0% | 80.0% |
| Existing threshold/baseline check | Failed | Passed | - |

Reproduce with `npm run eval:grouping` or `npx tsx eval/run-grouping.ts --details`. The remaining misses on this set are some TCP-handshake, DNS-resolution, HTTP-persistence and Maclaurin/Taylor rewordings. They split equivalent questions rather than merge different gold questions. Passing this synthetic set is not evidence of accuracy on arbitrary real papers; no private real-paper set was supplied in this workspace.

## Hand-off

Ali Shammakh should review the small changes in `lib/question-bank.ts` and `lib/question-grouping.ts`. Mohammed should review the schema merge repair and rerun his acceptance checks of Ali Slim's US-14/US-76. No Jira cards, pull requests, reviews, repository settings or deployments were changed by this work.
