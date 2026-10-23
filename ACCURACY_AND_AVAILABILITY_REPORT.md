# Accuracy evaluation set (US-93) and availability measurement (Sprint 3)

Built by Mohammed Al-Haiqi on branch `accuracy-evaluation-sprint-3`, from `main`.

## Part 1: US-93 accuracy evaluation set for grouping and ranking

> As a developer, I want a hand-checked set of exams with the correct question groupings so that I can measure grouping and ranking accuracy and detect regressions when the model or prompt changes. (SCRUM-95 E8, Must, 8 points)

### Acceptance tests

| Acceptance test | How it is met | Tested in |
| --- | --- | --- |
| Given the hand-checked set, when grouping runs on it, then precision and recall are reported | `npm run eval:grouping` runs the app's grouping and ranking on the set and prints pair precision, recall, F1, exact groups, paper-count accuracy, rank correlation, and top-5 precision, and writes `reports/eval-grouping-<set>-<date>.md` | `tests/unit/grouping-eval.test.ts` (metrics worked out by hand on small sets) |
| Given a change to the grouping logic, model or prompt, when evaluated, then accuracy is compared with the previous result and a drop below the threshold fails the check | Each set has a `baseline.json`. A metric more than 0.02 below it, or under its floor, fails the run (exit code 1). It runs in CI, so the PR fails. A model or prompt is a `Grouper` and is evaluated the same way | Unit tests for every pass and fail case; CI step in the `checks` job |
| Given the set, when stored, then it is versioned alongside the code | `eval/grouping/synthetic/dataset.json` is in git with a `version`; a baseline from another version is refused | Unit test that the committed set is valid |

### The sets

| Set | Where | Papers | Questions | Gold groups | Pair precision | Pair recall | Pair F1 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Synthetic | `eval/grouping/synthetic` (committed) | 16 (two courses) | 78 | 32 | 100% | 56.6% | 72.3% |
| Real MATH 201 Quiz 1 / Exam 1, 2008 to 2020 | `eval/grouping/local/math201-quiz1` (not committed) | 20 | 103 | 97 | 100% | 83.3% | 90.9% |

- **Why two sets.** The repository is public, so real exam text is kept out of it: the real set lives in the gitignored `eval/grouping/local/`. The synthetic set, which CI uses, was written to contain the same kinds of cases. That includes copies the rules catch (renumbering, marks, case, spacing, one-letter typos). It also includes copies they cannot catch yet (rewording, word order, hyphens and apostrophes), and different questions that must stay apart (other numbers, IPv4 and IPv6, CSMA/CD and CSMA/CA).
- **The real set** was transcribed by hand from the 21 PDFs collected in Sprint 0. The extractor (US-14) reads text from only 4 of them; 11 are image-only scans. Summer 2019 is a phone photo that cannot be read reliably, so it is left out rather than guessed. Each question is a whole numbered problem, as the extractor stores it.
- **What the real papers show.** Whole problems rarely repeat across MATH 201 quizzes: the only gold pairs are the Fall 2016 exam, which appears twice (blank and a student copy), and one reworded question (Fall 2013 Khachadourian Q3 and Fall 2015 Problem 6). Repeats are mostly at the level of a part, for example `n(7^(1/n) - 1)` or "use (ln(1+x))' = 1/(1+x) to expand ln(1+x)". So whole-problem grouping finds little frequency in these papers; grouping by part would be worth considering for US-15b.
- **What the rules miss.** On both sets, every miss is a rewording; precision is 100%, so nothing different was merged. That is the gap US-15b is meant to close, and this set measures it.

### Gold review

The gold groups were drafted by Claude with a note for each decision a reviewer could read either way. The baseline (`eval/grouping/synthetic/baseline.json`) was recorded from them so the CI check can run, and **the gold groups are reviewed in this PR**: `npm run eval:grouping -- eval/grouping/synthetic --gold` lists them by group. A change to them goes with a higher `version` and a new baseline.

## Part 2: Availability and reliability measurement

`npm run availability` measures every API's availability (successful / total requests) and reliability (also correct and within 1 s) with 1, 10, 25, 50, and 100 concurrent logged-in students. Each student repeats a weighted mix of 10 APIs. Details are in the README section "Availability and reliability".

### Result (local, 2026-10-24, production build, 20 s per stage)

| Users | Requests | Req/s | Availability | 95% lower bound | Reliability | p50 ms | p99 ms | Machine CPU avg / max | Server memory | DB connections |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 218 | 10.9 | 100% | 98.6% | 100% | 40 | 681 | 58% / 86% | 188 MB | 4 |
| 10 | 454 | 22.7 | 100% | 99.3% | 99.6% | 390 | 967 | 55% / 73% | 284 MB | 8 |
| 25 | 567 | 28.4 | 100% | 99.5% | 57.0% | 965 | 1,267 | 57% / 90% | 313 MB | 8 |
| 50 | 676 | 33.8 | 100% | 99.6% | 22.8% | 1,644 | 2,306 | 66% / 88% | 340 MB | 9 |
| 100 | 803 | 40.1 | 100% | 99.6% | 3.6% | 2,841 | 4,070 | 71% / 92% | 403 MB | 9 |

- **Availability held at 100%:** no timeout, connection error, 5xx, or unexpected status in 2,718 requests. That only proves about 99.6% at the largest stage (the 95% lower bound), so a claim of 99.9% or better needs longer runs.
- **Reliability did not hold:** from 25 users, most replies were correct but slower than 1 s. This is the "available but unreliable" case. The app supports **10 concurrent users** within both targets on this machine.
- **The bottleneck:** throughput levels off near 40 requests a second while latency grows roughly in line with users. Requests are queueing behind something with a fixed capacity. Database connections never went above 9, which suggests the Prisma connection pool or the single Node.js process. That is a hypothesis to test, not a finding.
- **Recovery:** after 100 users, normal replies returned within 1.2 s.
- **Machine load:** the machine was already busy with other programs (58% CPU at 1 user), so absolute numbers are low. The run should be repeated on a quiet machine or a server like the deployment target.
- **Found while running:** the first request to each route on a fresh server took up to 2.5 s, which made even 1 user miss the latency target. The tool now warms each API up before measuring.

## Results of the checks

| Command | Result |
| --- | --- |
| `npm run lint`, `npx tsc --noEmit` | Passed |
| `npm test` | 726 passed with `--maxWorkers=2` (44 new: 19 for the accuracy metrics, 25 for the availability numbers). With the default worker count on the loaded machine, the existing random-course test in `consolidated-exam-edge-cases.test.tsx` timed out, as on the other Sprint 3 branch |
| `npm run eval:grouping` | Passed against the recorded baseline (synthetic set); also runs in the CI `checks` job |
| `npm run availability` | Ran once (above); every stamped student and session was deleted afterwards (checked: 0 left) |
