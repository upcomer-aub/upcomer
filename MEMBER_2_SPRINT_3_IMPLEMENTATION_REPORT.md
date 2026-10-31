# Upcomer Sprint 3 — Member 2 Implementation Report

Ali Shammakh. Branch: `feature/us15b-us23-grouping-and-reports`, cut from `main` at `056b7d8` (after PR #25).

## Scope

Implemented from the Sprint 3 plan:

- US-15b: Group reworded equivalent questions (8 SP)
- US-23: Report a wrong question (3 SP)
- Monitoring for both: grouping decisions, low-confidence matches, and report intake

Not included: the accuracy set and its CI check (US-93) and admin corrections (US-75) belong to Mohammed Al-Haiqi. The extraction fix (US-14, US-76) belongs to Ali Slim. Progress and the personal order (US-21, US-28, US-33) belong to Lea Tass, who also edits the exam page this sprint. My cross-testing of Lea's stories and of US-69/US-72, and the Integration Lead tasks, are not code and are not in this branch.

## Architecture

| Area | Files | Responsibility |
| --- | --- | --- |
| Reworded grouping | `lib/question-grouping.ts` | `questionFeatures`, `rewordedScore`, `matchQuestions`; `groupQuestions` now records `reworded` matches per group |
| Grouping monitoring | `lib/question-bank.ts` | `rebuildQuestionBank` logs a summary and the low-confidence matches after the transaction commits |
| Schema | `prisma/schema.prisma`, `prisma/migrations/20261024000000_question_reports` | `QuestionReport` with `QuestionReportReason` and `QuestionReportStatus`; back-relations on `Course`, `QuestionGroup`, and `User` |
| Report service | `lib/question-reports.ts` | `reportQuestion`, `getReportQueue`, `closeQuestionReports` (for US-75) |
| Rules and messages | `lib/question-report-rules.ts` | Reasons, labels, note limit, refusal messages |
| Action | `lib/question-report-actions.ts` | `reportQuestionAction`; calls `requireUser()` first |
| UI | `components/report-question.tsx`, `components/report-question.module.css` | The closed report form under each exam question |
| Pages | `app/courses/[courseId]/exam/page.tsx`, `app/admin/reports/page.tsx` | Report form and notices on the Upcomer Exam; the admin queue |

## User stories and behavior

| Story | Acceptance check (from the plan) | Behavior |
| --- | --- | --- |
| US-15b | Same question with different wording is grouped | Compared by content words, with the instruction ("Explain", "What is"), function words, plurals, and a few exam synonyms folded away. "What is the difference between TCP and UDP?" = "Compare TCP and UDP." = "Distinguish between TCP and UDP." |
| US-15b | Same question with different numbers is grouped | Value numbers are ignored in questions of 3+ content words: "a 1500-byte packet on a 10 Mbps link" = "a 1000 byte packet over a 100 Mbps link" |
| US-15b | Same-topic but different questions stay apart | One version may only add words to the other; any swapped content word keeps them apart (TCP/UDP, TCP/IP, IPv4/IPv6, insertion/selection, advantages/disadvantages). Math, negations, calculate-vs-explain, and numbered names (`layer 3`, `RFC 793`, `port 80`) must match. Groups are compared with their first question only, so rewordings cannot chain |
| US-15b | Accuracy on the US-93 set meets the threshold | Not measurable yet: the set is US-93's. `matchQuestions` and `groupQuestions` are the interface for it; see "Hand-off" |
| US-15b | Monitoring | `question_grouping_completed` per rebuild; `question_grouping_low_confidence` per reworded match scoring under 0.85 (at most 20 per rebuild) |
| US-23 | A report reaches the admin queue with question and course | `/admin/reports` shows course code, rank, paper count, the question, who reported it and why, and the notes. The question text and course come from the stored group, never from the form |
| US-23 | A duplicate report does not open a second one | A student's second report of a question while the first is open is refused ("You already reported this question."), under a per-student, per-question lock. Another student's report joins the same queue item |
| US-23 | Monitoring | `question_report_submitted`, `question_report_refused`, `question_report_rate_limited`, `question_report_failed`, `question_report_retrieval_failed`. The note is never logged |

## Design decisions

- **Precision over recall.** A wrong merge hides a question from students, while a missed rewording only shows a question twice and can be reported. So the matcher never groups a swapped content word, however long the question is, and anything it is unsure about (score 0.75–0.85) is grouped but logged for an admin to check.
- **No external model.** The matcher is a pure, deterministic function, like US-15a, so the same papers always give the same groups and the US-93 check can run in CI without network access or keys.
- **Reports are per student, the queue is per question.** Each student's reason and note are kept, and the admin sees one item per question, so a popular wrong grouping is visible as "Reported by 3 students" instead of three items.
- **Reports survive a regroup.** `groupId` is set to null if a regroup removes the group, and `questionText` keeps what the student saw.

## Integration found during checks

- The US-74 integration test that publishes a 60-question exam uses questions that differ only in "topic number N". The first version of the number rule grouped them, which showed a real false positive ("layer 3" vs "layer 4"). Fixed in `87f770e`: a number after a naming noun must match.
- The five US-92 sample exams give exactly the expected ordered exam with reworded grouping on (`tests/integration/exam-pipeline.test.ts` unchanged).

## Hand-off

### For Ali Slim (cross-tester of US-15b and US-23)

Setup: `npm install`, `npx prisma migrate deploy`, `npm run db:seed`, `npm run dev`. Add questions to a course's exam papers (or use your extraction), then click **Regroup and rank** on `/admin/questions`.

- **US-15b, reworded:** "What is the difference between TCP and UDP?", "Compare TCP and UDP.", "Distinguish between TCP and UDP." on three papers show once on `/courses/:id/exam` with "Appeared in 3 of 3 papers".
- **US-15b, numbers:** "Calculate the transmission delay of a 1500-byte packet on a 10 Mbps link." and "Find the transmission delay for a 1000 byte packet over a 100 Mbps link." form one question.
- **US-15b, apart:** "…between TCP and IP?", "Explain TCP congestion control.", "Explain the role of layer 3…" vs "…layer 4…" stay separate.
- **US-15b, monitoring:** `/admin/monitoring` → event `question_grouping_completed` shows the counts; a short question and a longer rewording of it ("Explain the TCP three-way handshake." / "Describe how TCP establishes a connection using the three-way handshake.") logs `question_grouping_low_confidence`.
- **US-23:** log in as a student, open the exam, expand "Report a problem with question 1", pick a reason, add details, send. The report appears on `/admin/reports` with the course and question. Sending again shows "You already reported this question." A second student's report shows "Reported by 2 students" on the same item. Logged out, the exam shows a "Log in" link instead of the forms.

### For Mohammed Al-Haiqi (US-93, US-75)

- **US-93.** `matchQuestions(a, b)` from `lib/question-grouping.ts` gives the pairwise decision, and `groupQuestions(questions)` the groups. Proposed set format for the day-one agreement: one JSON file per course under `tests/accuracy/`, `{ "course": "EECE350", "questions": [{ "id": "q1", "paper": "final-2021", "text": "…", "group": "tcp-vs-udp" }] }`, scored by pairwise precision and recall over same-`group` pairs. Proposed threshold: precision ≥ 0.95 and recall ≥ 0.80, to be confirmed with the team once the set exists.
- **US-75.** Open reports are `QuestionReport` rows with `status: OPEN`. Call `closeQuestionReports(adminId, { groupId }, "RESOLVED")` after correcting a question, or `{ reportIds }` with `"DISMISSED"` for a report that was wrong. The queue page lists only open reports, so closed ones disappear from it. A correction button can go on each `/admin/reports` item.

### For Lea Tass (US-21, US-28, US-33)

`app/courses/[courseId]/exam/page.tsx` now reads `getCurrentUser()` and `searchParams` (`reported`, `report_error`), and `ConsolidatedExamView` takes an optional `report={{ courseId }}` prop. If you reorder the questions for the personal order, keep passing `report`: the form posts the question's group ID (`question.id`) and its `position` for the return anchor (`#question-N`).

## Shared files changed

- `prisma/schema.prisma`: `QuestionReport`, two enums, back-relations on `Course`, `QuestionGroup`, and `User`. `prisma format` re-aligned the `User`, `Course`, and `QuestionGroup` blocks.
- `lib/logger.ts`: seven events (above).
- `lib/submission-review.ts`: `readable` is exported (no behavior change), so a note of invisible characters counts as empty, like a rejection reason.
- `components/consolidated-exam.tsx`: the optional `report` prop and the form under each question.
- `app/courses/[courseId]/exam/page.tsx`: the session, the report notices, and the log-in hint.
- `tests/unit/consolidated-exam-page.test.tsx`: mocks `@/lib/auth` and passes `searchParams`; no assertion changed.
- `app/admin/catalog/page.tsx`: Question reports card.
- `.env.example`: `QUESTION_REPORT_RATE_LIMIT_PER_MINUTE`.
- `README.md`: routes, events, and a "Reworded grouping and question reports" section.

The migration starts directly at the SQL. `prisma migrate diff` from the migrations to the schema reports no difference.

## Tests and checks performed

| Test file | Tests | Covers |
| --- | --- | --- |
| `tests/unit/question-grouping.test.ts` | 69 (34 new) | Reworded pairs that must group and pairs that must stay apart (swapped words, same topic, math, negations, calculate vs explain, numbered names, value numbers), scores, features, best-group choice, no chaining, determinism; the US-15a and US-16 tests unchanged |
| `tests/unit/question-bank.test.ts` | 18 (4 new) | Summary log after commit, low-confidence lines with IDs only, the 20-line cap, nothing logged on a failed rebuild |
| `tests/unit/question-reports.test.ts` | 22 | Report creation from the stored group, lock key, duplicate, unseen question, reasons, note limit and invisible notes, rate limit, failure logging without the note, the action's redirects and login, queue grouping, regrouped reports, paging, `closeQuestionReports` |
| `tests/unit/question-report-pages.test.tsx` | 8 | Admin check, queue items and escaped notes, regrouped note, paging, empty queue; the exam's form, log-in hint, and notices (unknown errors never echoed) |
| `tests/e2e/question-reports.spec.ts` | 3 | Reworded questions shown once with every paper counted and TCP/IP kept apart; a student reports, a second report is refused; the admin queue shows the question, course, rank, both students, and the note. Creates its own course and students and deletes them |

| Command | Result |
| --- | --- |
| `npm test` | Passed: 750 tests in 49 files |
| `npm run lint` | Passed |
| `npx tsc --noEmit` | Passed |
| `npm run build` | Passed |
| `npx prisma migrate deploy`, `npm run db:seed` (twice), `prisma migrate diff` | Passed on an empty PostgreSQL 16 database; no drift |
| `npm run test:integration` | Passed: 30 tests (2 todo), including the 1 s targets for 20-paper courses |
| `npm run test:e2e` | Passed: 67 tests, against a throwaway PostgreSQL 16 container. Ports 3000 and 5432 were held by another project on this machine, so the suite ran on port 3100 through a temporary copy of the config. The project config is unchanged |

## Remaining work

- Cross-testing by Ali Slim.
- Measuring US-15b on the US-93 set once Mohammed's set exists, and tuning `REWORDED_THRESHOLD` or the synonym list if recall is below the agreed threshold.
- The seed (`prisma/seed.ts`) has no reworded sample questions, so the demo needs a course with reworded papers (the e2e spec's three papers are a ready example).
- A group's ID changes when its first question changes, for example when a newly processed paper sorts before the old ones. Reports then keep their snapshot text but lose the link to the group. US-75's corrections should keep this in mind.
