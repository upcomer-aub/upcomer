# Evaluate answers and explain mistakes (US-49) - Sprint 4

Owner: Mohammed Al-Haiqi (M4). Tester: Mustafa Ergaibi (M1).

**Acceptance (sprint plan):** evidence-based marking and explanations; an absent rubric is flagged rather than guessed.

Built on US-45 (mock exams, Ali Shammakh / Mustafa Ergaibi) and its contract in the README: answers in `MockExamQuestion.answer`, `questionId` for learning events, generated items through their own ID, "Past papers have no answer keys; what an answer is marked against is US-49's decision."

## The decision: admin answer keys, checked by key points

Past papers carry no answer keys, so there is nothing true to mark against unless someone writes it. Three options were weighed:

| Option | Why not / why |
| --- | --- |
| Let a language model judge the answer | No verified key either; it would be a guess presented as a grade. Also an external call with student text. Rejected. |
| Compare with the most similar past answer | There are no stored correct answers. Rejected. |
| **An admin writes key points per question group; the answer is checked for each point** | Evidence-based and transparent: the student sees which points were covered and which were missed. A question without a key is flagged, never marked. **Chosen.** |

The check is simple on purpose: a point is covered when every important word of it is in the answer, in any order. Case, accents, punctuation, stopwords and simple word endings are ignored. It is a check of the key points, not a grade of the whole answer, and the exam page says so. A later sprint can swap `markAnswer` for a better judge without changing the storage or the pages.

## What it guarantees

| Guarantee | How | Checked by |
| --- | --- | --- |
| No key, no mark: flagged "Not marked: no answer key", no learning event | `markAnswer(answer, null)` is `NO_KEY`; generated items never get a key | unit, integration, e2e |
| Marking explains mistakes: points covered, points missed, the admin's explanation | `markAnswer` | unit, integration, e2e |
| Marked once, even with two tabs or a retry | the write claims `SUBMITTED` and `markedAt` null | integration (3 at once; mutation-checked: fails without the claim), unit |
| A marked exam never changes when its key changes later | the marking is copied onto `MockExamQuestion` | integration |
| The student's profile learns from the result (US-25) | one `MOCK_EXAM` event per marked past-paper question, stable event IDs, one-by-one fallback | unit (fallback, failure), integration (2 events, none twice), e2e |
| Only the owner sees the marks; only admins write keys; a key only for a group of that course | reads by exam ID + session user; `requireAdmin`; group checked against the course | unit, integration, e2e |

## Course checklist

- **Caching:** none. A marked exam is read by its one student, and the marking is stored once, so there is nothing to recompute.
- **DoS:** marking runs at most once per exam, and exams are limited by US-45 (20 an hour). Answer keys: 60 saves per admin per minute (`ANSWER_KEY_RATE_LIMIT_PER_MINUTE`), refused before the database is read (unit).
- **Logs and responsiveness:** `operation_timed` `mock_exam_marking` (23 ms and 67 ms in the e2e runs) and `answer_key_save`; events `mock_exam_marked` (counts per outcome, events recorded or skipped), `mock_exam_marking_failed`, `mock_exam_marking_evidence_failed`, `answer_key_*`. Answers, key points and explanations are never logged (unit).
- **Stored-request cleanup:** not applicable; marks belong to the exam and go with it.
- **Availability** (`npm run availability`, new API: each user opens their own marked exam; correct only when its marks, the explanation, and the "not marked" flag are on the page):

| Users | Requests | Available | Wrong content | p50 / p99 ms |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 65 | 100% | 0 | 10 / 27 |
| 10 | 60 | 100% | 0 | 106 / 484 |
| 25 | 83 | 100% | 0 | 289 / 724 |
| 50 | 114 | 100% | 0 | 505 / 1,097 |
| 100 | 129 | 100% | 0 | 966 / 1,538 |

  Whole run: 9,032 requests, 100% available, 0 failed, reliability 100% up to 25 users. As in every run on this machine, all pages slow past 25 users together.
- **Load** (`npm run load -- mock-marking`, the largest exam: 50 marked questions with explanations):

| Users | Requests | p99 ms | Errors | Target (p99 < 1 s) |
| ---: | ---: | ---: | ---: | --- |
| 1 | 597 | 33 | 0 | met |
| 10 | 792 | 323 | 0 | met |
| 25 | 837 | 394 | 0 | met |
| 50 | 800 | 696 | 0 | met |
| 100 | 800 | 1,324 | 0 | missed |

  Supported within 1 s: 50 students opening a 50-question marked exam at the same moment.

## Tests

- Unit: `tests/unit/mock-marking-rules.test.ts` (14: normalising, stems, every outcome, word boundaries, key parsing), `tests/unit/mock-marking.test.ts` (12: what is marked against what, the claim, events and fallback, logging, keys and their limit), `tests/unit/mock-marking-pages.test.tsx` (6). US-45's page test gets one mock line and still passes (19).
- Integration (real PostgreSQL and the real question bank): `tests/integration/mock-marking.test.ts` (8). US-45's 21 still pass.
- E2E: `tests/e2e/mock-marking.spec.ts` (4: only admins, writing keys from the question bank, the acceptance flow through the real form, another student). US-45's spec still passes (7).

## Full suites on this branch (local)

- tsc and lint clean; production build passes.
- Unit 1,322/1,322; integration 170/170 (real PostgreSQL); e2e 115/115 (production build, 1 worker), including the US-73 locator fix in the first commit.
