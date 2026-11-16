# Mock exam results report (US-50) - Sprint 4

Owner: Mohammed Al-Haiqi (M4). Tester: Mustafa Ergaibi (M1).

**Acceptance (sprint plan):** after grading, the score and the topic breakdown reflect the actual answers and the missed items.

Built on US-49 (the marking), on the previous PR. No schema change.

## What it guarantees

| Guarantee | How | Checked by |
| --- | --- | --- |
| Score and breakdown come only from the stored marking | `buildResultsReport` (pure) from each question's outcome and key points | unit (every outcome, ties, empty), integration, e2e (numbers on the page), availability (numbers checked on every request) |
| Unmarked questions never count, and are listed apart | `NO_KEY` excluded from the score; "not marked" list | unit, integration, e2e |
| Partly correct answers count in part | credit = key points covered / key points | unit (37.5% case), e2e (38%) |
| Weakest topic first | sorted by credit, unmarkable last, ties by name | unit, e2e |
| Never built from unmarked answers | a submitted, unmarked exam is marked first | integration |
| Only the owner | read by exam ID + session user | unit, integration, e2e (404 for another student; visitor to log in) |

## Course checklist

- **Caching:** none. One student's report, built in memory from at most 50 stored rows.
- **DoS:** 60 results pages per student per minute (`MOCK_RESULTS_RATE_LIMIT_PER_MINUTE`); over it nothing is read (unit).
- **Logs and responsiveness:** `operation_timed` `mock_results`; events `mock_results_rate_limited`, `mock_results_retrieval_failed`. No answers logged.
- **Stored-request cleanup:** not applicable.
- **Availability** (`npm run availability`, new API: each user opens their marked exam's results; correct only when "1 of 2 marked questions fully correct · 75% of the key points covered" and "1 of 3 questions was not marked" are on the page):

| Users | Requests | Available | Wrong content | p50 / p99 ms |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 39 | 100% | 0 | 13 / 377 |
| 10 | 79 | 100% | 0 | 97 / 519 |
| 25 | 86 | 100% | 0 | 257 / 684 |
| 50 | 89 | 100% | 0 | 506 / 1,138 |
| 100 | 98 | 100% | 0 | 1,036 / 1,419 |

  Whole run: 8,641 requests, 100% available, 0 failed, reliability 99.9% up to 25 users.
- **Load** (`npm run load -- mock-results`, the results of a 50-question marked exam over five topics):

| Users | Requests | p99 ms | Errors | Target (p99 < 1 s) |
| ---: | ---: | ---: | ---: | --- |
| 1 | 666 | 33 | 0 | met |
| 10 | 1,154 | 169 | 0 | met |
| 25 | 1,292 | 308 | 0 | met |
| 50 | 1,257 | 641 | 0 | met |
| 100 | 1,295 | 889 | 0 | met |

  Supported within 1 s: 100 users.

## Bug found by the tests and fixed

The page test caught a wrong agreement: with 1 of 3 questions unmarked the page said "1 of 3 questions were not marked". The e2e then caught the next try ("1 of 5 question was"). It now reads "1 of 5 questions was not marked".

## Tests

- Unit: `tests/unit/mock-results-rules.test.ts` (5), `tests/unit/mock-results-page.test.tsx` (4).
- Integration: `tests/integration/mock-results.test.ts` (3).
- E2E: `tests/e2e/mock-results.spec.ts` (4). With US-49's and US-45's specs: 15/15.

## Full suites on this branch (local)

- tsc and lint clean; production build passes.
- Unit 1,331/1,331; integration 173/173; e2e 119/119 (production build, 1 worker).
