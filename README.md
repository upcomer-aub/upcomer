# Upcomer

## Ali Slim - Sprint 4

US-25, US-29, US-44 and US-73 are implemented on `ali_slim_sprint_4`, based on `origin/main` at `8473b83`.

After pulling: `npx prisma generate`, then apply reviewed migrations with `npx prisma migrate deploy` to the intended database. Migration `20261115000000_practice_evidence` adds evidence counters, `LearningEvent`, and `GeneratedPracticeQuestion`. This branch's verification uses a disposable local database, not the team's shared database.

| Route | Behavior |
| --- | --- |
| `/courses/:courseId/practice` | Authenticated question-bank practice; self-report correct/incorrect and inspect actual priority reasons; 20 questions per page |
| `/courses/:courseId/practice/generated` | Generate 1-10 private, course-grounded reasoning tasks; choose topic/difficulty; browse the saved library |
| `/courses/:courseId/exam?order=personal` | Existing personal order, now with **Why this priority?** beneath each ranked question |
| `/admin/files/:id/manage` | Admin-only replace/remove forms, reachable from Edit File Details |
| `POST /api/admin/files/:fileId` | Admin-only multipart replacement or confirmed removal with optimistic version checking and origin validation |

### Performance evidence and priority explanations

- A completion mark still means only **done**. Correct/incorrect outcomes are a separate action and are clearly labeled self-reported, not automatically graded.
- `recordLearningEvents(userId, courseId, events)` in `lib/learning-evidence.ts` is the trusted server input contract. Each event has `{ eventId, source, correct, questionId? | generatedQuestionId?, topic? }`. Producers supply a stable event ID; session/attempt ownership supplies `userId`. Browser actions accept only question-bank outcomes and ignore submitted user IDs and source names.
- A unique `(userId, source, eventId)` and course-profile lock prevent duplicate updates. Replaying the same event is a no-op; changed course, target or outcome is a conflict. A batch either commits all events and profile changes or none.
- Question topics come from the course's published source papers using the same majority/tie rule as personal ordering. Untagged questions cannot claim topic mastery. Deleted or private sources cannot create new evidence. Historical evidence survives removal and idempotent replays remain safe.
- With baseline weakness `b`, correct count `c`, and incorrect count `i`, `weakness = (2*b + i) / (2+c+i)`. The baseline is saved confidence, an existing pre-performance weakness, or neutral 0.5. Confidence changes recalculate the same rule without discarding outcomes. Skip removes the rating prior when applicable; it does not erase performance or assert mastery.
- `getLearningProfile` exposes optional `confidence`, `baselineWeakness`, `correctCount`, and `incorrectCount` alongside the existing fields for US-26/30/31/47. These are heuristic evidence counts, not calibrated mastery probabilities.
- US-29 uses the actual `checkedPriority` function: exam-paper share times `(1 + 2*weakness)`. Reasons name saved confidence, recorded correct/incorrect counts, the prior and actual score; unknown evidence and invalid inputs are explicit. Historical frequency is not a guarantee of future exams.
- US-49 is integrated: submitted mock exams use admin-authored answer keys for past-paper questions and deliver their outcomes through `recordLearningEvents` with stable mock/item IDs. Generated questions without a verified key are marked `NO_KEY` and produce no learning evidence. `recordMockOutcomes` remains available for future rubric-backed generated-question grading. FLASHCARD and AI_INTERACTION remain future E5 producer contracts; full original US-25 acceptance awaits those sources.
- Mock attempt/item identifiers must be nonempty. Simple existing IDs retain their event keys; separator-bearing or long pairs use a framed hash so different attempts cannot collide. Invalid producer payloads are refused before database work; cross-course event-ID conflicts are serialized per student.

### New practice questions (US-44)

- `generatePracticeQuestions(userId, courseId, { count, difficulty, topicKey? })` generates and persists an exact batch or returns a controlled refusal. It reads only published exam questions in that course, requires a tagged topic and a usable source, and respects EASY/MEDIUM/HARD requested reasoning depth.
- The offline generator produces **new reasoning tasks around the original paper context**, not numerical substitutions or invented solutions. It needs no model key. Easy tasks identify concepts/assumptions, medium tasks plan/check solutions, hard tasks compare/generalize reasoning. Difficulty is instructional intent, not a calibrated assessment. Sources are copied as context and linked for review.
- There are three task variants per source/difficulty. Normalized content hashes prevent exact repeats of historical questions or the student's existing generated tasks. Exhaustion is explicit; no smaller batch is silently returned. Libraries are private to a student/course.
- Persisted items include stable IDs, topic/difficulty, generator version, source-question relation, source fingerprint, prompt, content hash, and nullable rubric. Source removal/replacement cascades generated items; correction or retagging excludes stale items from eligibility. Generation never changes historical question groups or frequencies.
- US-45/46/47 use `getGeneratedPracticeQuestions(userId, courseId, settings?)` through mock assembly to enforce source validity and library privacy, then save selected item IDs and question snapshots. Mock sessions, alternative versions, personalized selection, timers, grading and results are integrated. Generated-question `rubric` remains null; US-49 explicitly shows `NO_KEY` rather than inventing a grade.
- When generation follows a source correction or retag, stale private items are removed within the generation transaction so their unique hashes cannot permanently block regeneration. Outcome snapshots survive with a null item relation. Mock attempts should snapshot their question text and use nullable source relations, as removal/replacement can invalidate library items.

### File replacement/removal (US-73)

- Replacement keeps the file ID, course, review status, title and metadata. PDFs are validated and extracted before mutation; unreadable/scanned/question-less replacements leave original data intact. Materials retain the existing supported upload formats and size limits.
- New bytes are staged under an exclusive UUID path inside verified canonical storage. Under the course and processing locks, the service checks the displayed version and active processing, then replaces/deletes questions and regroups in the **same transaction**. A grouping failure rolls back all database changes and removes staged bytes.
- Removal requires confirmation and updates ranks/source links atomically. Generated items derived from deleted questions disappear; historical outcome/correction/report snapshots remain. Recent running processing attempts are refused. Racing/stale forms cannot overwrite a newer file.
- Old physical bytes are removed after commit only if no other record references them. Failed cleanup is logged as an error and shown to the admin; source records and rankings already reflect the committed mutation. Existing filesystem containment checks remain enforced. Original-file responses use `private, no-store` so replacements do not reuse stale cached bytes.
- Partial staged writes are closed and removed, while failed exclusive creation never deletes an existing file. Mutations also rebuild any former course groups still containing a moved paper. Processing commits verify the source revision and current attempt under course/file locks; an old or expired worker returns `superseded` instead of restoring obsolete content.

### Monitoring and verification

New privacy-safe events: `learning_evidence_saved/failed/refused`, `practice_generation_completed/failed/refused`, and `file_management_completed/failed/refused/cleanup_failed`. They contain IDs, counts, reason codes and error types only. Existing priority input failures use `priority_calculation_failed`. `.env.example` documents per-minute limits for practice, generation and file management.

Tests: `tests/unit/sprint4-practice-rules.test.ts`, `tests/unit/sprint4-actions.test.ts`, `tests/integration/sprint4-ali-slim.test.ts`, and `tests/e2e/ali-slim-sprint4.spec.ts`, plus the existing regression suites. The integration suite includes fixed-seed valid/invalid trials and real concurrency/rollback checks. Browser tests exercise actual forms, persisted monitoring, private libraries, admin mutations and mobile layout. `MEMBER_5_SPRINT_4_IMPLEMENTATION_REPORT.md` records final results and integration boundaries; `CROSS_TEST_ALI_SLIM_SPRINT_4.md` records the assigned advice cross-tests and unavailable US-45 acceptance.

Upcomer is a university study platform organized around courses. Students discover courses, browse exams and materials, use a grouped question bank, track progress and confidence, and record practice outcomes. Admin tools manage uploads, review submissions, correct questions, monitor failures, and replace or remove source files.

## Stack and requirements

Next.js App Router, TypeScript, Tailwind CSS, PostgreSQL, Prisma, Vitest, React Testing Library, and Playwright. Use Node.js 20.9 or newer and a running PostgreSQL server.

## Local setup

1. Run `npm install`.
2. Copy `.env.example` to `.env`. Set `DATABASE_URL` to a PostgreSQL database and `FILE_STORAGE_ROOT` to the folder containing uploaded files. The sample value `public/uploads` works for the committed fixtures. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` to seed an admin user, and `SIGNUP_EMAIL_DOMAIN` if sign-up should accept one email domain only.
3. Run `npm run db:migrate` to apply the initial schema.
4. Run `npm run db:seed` to add three courses and their sample resources.
5. Run `npm run dev` and open `http://localhost:3000/courses/course-eece350`.

The seed is repeatable and includes one record for a deliberately missing physical file (`file-missing`) to exercise failure handling. The six PDF fixtures live in `public/uploads`. The home route is only a placeholder for Member 2's discovery interface.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm test` | Unit and component tests |
| `npm run test:e2e` | Playwright flow; requires migrated and seeded database |
| `npm run test:integration` | Integration tests against a real database (`tests/integration/`); requires a migrated database. They create and delete their own rows |
| `npm run load -- <scenario>` | Load test with autocannon against a production build, for example `npm run load -- review-queue`; writes `reports/load-<scenario>-<date>.md` and `.json`. `LOAD_SECONDS`, `LOAD_STAGES` (for example `1,10,50`), and `LOAD_SKIP_BUILD=1` change a run. Stop any dev server first |
| `npm run reliability` | Randomized reliability trials against a production build; writes `reports/reliability-<date>.md` and `.json`. `RELIABILITY_RUNS` (default 50 per feature) and `RELIABILITY_SEED` repeat a run. Stop any dev server first |
| `npm run eval:grouping` | Grouping and ranking accuracy on the committed evaluation set (US-93); fails if it dropped below the baseline. `npm run eval:grouping -- <set folder>` evaluates another set, `--details` lists the wrong groups, `--gold` lists the gold groups for review, `--update-baseline` records a reviewed result. Runs in CI |
| `npm run availability` | Availability and reliability of every API with 1 to 100 concurrent users against a production build; writes `reports/availability-<date>.md` and `.json`. `AVAILABILITY_STAGES`, `AVAILABILITY_SECONDS`, `AVAILABILITY_TARGET`, `AVAILABILITY_SEED`, and `AVAILABILITY_SKIP_BUILD=1` change a run. Stop any dev server first |
| `npm run db:migrate` | Apply/create Prisma migrations |
| `npm run db:seed` | Seed local data |
| `npm run db:seed-demo` | Add a large set of demo data (see Demo data); `npm run db:seed-demo -- --reset` removes it |

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Course catalog; optional `q`, `facultyId`, `professorId`, and `page` query parameters |
| `/courses/:courseId` | Course home |
| `/courses/:courseId/exams` | Exams for that course |
| `/courses/:courseId/materials` | Materials for that course |
| `/courses/:courseId/exam` | The Upcomer Exam: every distinct question once, most likely first. Logged-in students can report a question under it, mark questions done and continue where they stopped (US-21), and switch to their personal order (US-28); optional `reported`, `report_error`, `progress_error`, `at`, and `order=personal` query parameters |
| `/courses/:courseId/confidence` | Rate your confidence in each of the course's topics, 1 to 5 or Skip (US-24); requires a session. Optional `saved` and `error` query parameters |
| `/courses/:courseId/topics` | Your topics in that course: the topic to study next, with the reason and links to practise (US-30), then your strongest and weakest topics, with what each rests on (US-26), then the course's topics to mark as already covered or undo (US-32); requires a session |
| `/courses/:courseId/practice/weak-topics` | A practice set with more questions from the student's weaker topics (US-31); requires a session. Optional `size` query parameter (5, 10, or 20) |
| `/courses/:courseId/mock-exams` | Mock exams of that course (US-45): choose topics, a length and a difficulty, optionally with your generated practice questions, and see your own exams; generating requires a session |
| `/courses/:courseId/mock-exams/:mockExamId` | Sit one of your own mock exams: save answers, then submit to lock them; a timed exam (US-48) starts with a Start page and shows a countdown; see its versions and make an alternative version (US-46); requires a session, and another student's exam is not found |
| `/courses/:courseId/advice` | Advice from previous students for that course, with search and filters (US-34, US-35, US-37, US-39), helpful marks and `sort=helpful` (US-40), and a discussion under each post (US-41, optional `thread`); publishing, marking and replying require a session |
| `/courses/:courseId/questions` | The course's question bank, most frequent first; optional `q`, `year`, `termId`, `examType`, and `professorId` query parameters |
| `/files/:fileId` | Original bytes for a stored file record |
| `/admin/uploads` | Admin upload menu |
| `/admin/uploads/exams` | Upload a previous exam; optional `courseId` query parameter preselects the course |
| `/admin/uploads/materials` | Upload a course material; optional `courseId` query parameter preselects the course |
| `POST /api/admin/uploads` | Stores an uploaded file and creates its `CourseFile` record |
| `/signup` | Create an account; optional `error` and `next` query parameters |
| `/login` | Log in; optional `error`, `next`, `registered`, and `reset` query parameters. Links to `/forgot-password` |
| `/forgot-password` | Ask for a password reset link; optional `sent` query parameter. Always shows the same message |
| `/reset-password` | Set a new password with a reset link's `token`; optional `error` query parameter |
| `/my-courses` | The logged-in student's courses; requires a session |
| `/profile` | Edit your own name, faculty, and major; requires a session. `/profile/:id` and `/profile/:id/edit` redirect to `/profile` for your own ID and show the not-found page for anyone else's |
| `/admin/catalog` | Catalog management menu; admins only |
| `/admin/catalog/faculties`, `/courses`, `/professors`, `/terms` | List and add entries; optional `saved`, `error`, and `value` query parameters |
| `/admin/catalog/:section/:id` | Edit one faculty, course, professor, or term |
| `/admin/files` | Every uploaded file with its metadata; optional `courseId`, `saved`, and `error` query parameters |
| `/admin/files/:id` | Edit one file's course, professor, year, term, type, and topic; optional `error` query parameter |
| `/admin/submissions` | The review queue: pending submissions, oldest first, 20 per page, each with Publish and a Reject form that needs a reason; optional `page`, `published`, `rejected`, and `error` query parameters; admins only |
| `/admin/questions` | Extracted question counts per course and a "Regroup and rank" button; optional `rebuilt`, `groups`, and `error` query parameters; admins only |

| `/admin/questions/:courseId` | Question corrections: the course's question groups in rank order, 20 per page, each question with a "Correct" link, and the activity log of the latest 50 corrections; optional `q` and `page` query parameters; admins only |
| `/admin/questions/:courseId/:questionId` | Correct one question: edit its text, move it to another group, split it into its own group, or undo a move or split, with its correction history; optional `saved`, `regroup`, and `error` query parameters; admins only |
| `/admin/processing` | Latest exam processing result per file, with the failed stage, reason, and an admin retry button |
| `/admin/reports` | Questions students reported, one item per question, reported longest ago first, 20 per page; optional `page` query parameter; admins only |

| `/admin/monitoring` | Logged errors and warnings, the 24-hour summary, and the alert status; optional `level`, `event`, and `range` query parameters; admins only |
| `/submit` | Submit a past exam or course material for review; optional `error`, `courseId`, and `category` query parameters; requires a session |
| `/my-submissions` | The logged-in student's submissions with their status and, if rejected, the reason; optional `submitted` query parameter; requires a session |
| `POST /api/submissions` | Stores a submitted PDF as a `PENDING` `CourseFile` and redirects (303) to `/my-submissions` or back to `/submit` with the reason |

## Team integration

Member 2 can link any `Course.id` to `/courses/:courseId` and reuse `Course`, `Faculty`, and `Professor`. Member 4 can manage those shared models and `CourseFile` metadata. Member 5 can create a `CourseFile` with a course ID, category, and storage key relative to `FILE_STORAGE_ROOT`; the resource appears on the appropriate page automatically. File links accept an ID only, never a filesystem path.

The file route shows PDFs in the browser and downloads other file types. It rejects keys that escape the upload folder, including through filesystem links.

## Demo data

`npm run db:seed-demo` (`prisma/seed-demo.ts`) fills the database so the app looks like a busy platform. It is separate from `npm run db:seed`, which it never changes, and it creates:
- **Courses:** 63 AUB-style courses (CMPS, EECE, MATH, STAT, ECON, PHYS, CHEM, BIOL, PSYC, ENGL, ARAB, ACCT, FINA, MKTG, …) across six faculties. Existing faculties (Engineering, Arts and Sciences, Medicine) are reused; Business, Health Sciences, and Agricultural and Food Sciences are added.
- **Professors:** 40 fictional professors, each teaching 1 to 4 courses in one faculty.
- **Files:** 600 exams and materials from 2019 to 2025, across Fall, Spring, and Summer. Each has a title, a professor who teaches the course, a term, a year, a type (exams only), and a topic. Every file passes the same checks as an admin upload (`parseFileMetadata`, `checkFileMetadata`, `validateUploadFile`) before it is saved.
- **PDFs:** a real one-page PDF for every file, under `<FILE_STORAGE_ROOT>/demo/` (ignored by git), so "Open Original File" works.
- **Students:** 20 demo students with 3 to 7 courses each in My Courses. Emails end in `@demo.upcomer.test`; the script prints them. They all use the password from `DEMO_PASSWORD` (default `upcomer-demo`).

All names are invented. Every demo record has an ID starting with `demo-`, and the data comes from a fixed seed. Running the script again updates the same records, so nothing is duplicated. It creates no log entries, so monitoring shows only real events.

`npm run db:seed-demo -- --reset` deletes only `demo-` records and `demo-*.pdf` files; the normal seed and anything added through the app stay. If a real record depends on demo data (for example a real upload to a demo course, or a real student who added a demo course), the reset stops and lists what blocks it, because deleting the demo record would delete or change the real one.

With demo data loaded, the catalog has more than one page. The e2e tests look seeded courses up by code, so they pass with or without it.

## Design

The "Study mint" theme is calm and minimal: lots of whitespace, soft 1px borders, subtle hover states, and no heavy shadows or gradients.

**Where the tokens live.** All colors are CSS variables at the top of `app/globals.css`. Each is defined once as `light-dark(light, dark)`, so the two palettes stay side by side. Components use only the variables and the existing class names (`.card`, `.button`, `.notice`, `.field`, …). The standalone "File unavailable" page (`app/files/[fileId]/route.ts`) is a raw HTML response and repeats the few tokens it needs. Change both places together.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--bg` | #F6FAF8 | #0F1714 | Page background |
| `--surface` | #FFFFFF | #16211D | Cards, header, inputs |
| `--border` | #D1E7DD | #2A3A33 | Soft card and header borders |
| `--input-border` | #6B8A7C | #5E7F71 | Form fields (at least 3:1 against the background) |
| `--text` / `--muted` | #022C22 / #4B6358 | #E6F2EC / #9DB5AA | Body and secondary text |
| `--brand` | #064E3B | #6EE7B7 | The "Upcomer" wordmark |
| `--primary` | #059669 | #34D399 | Focus rings, active borders (non-text) |
| `--button-bg` / `--link` | #047857 | #34D399 | Buttons (hover #065F46 / #6EE7B7) and links |
| `--accent` | #F97316 | #FB923C | Decoration only: the course-code dot, the notice edge, the card hover marker |

**Contrast.** Every text color meets WCAG AA (4.5:1) on every background it is used on, in both modes. The brand primary #059669 is only 3.8:1 with white text, so buttons and links use the darker #047857 in light mode, and #059669 is kept for non-text indicators. The accent never colors text.

**Font.** Plus Jakarta Sans, loaded with `next/font/google` in `app/layout.tsx`. It is downloaded at build time and served from the app, with a metrics-matched fallback so text doesn't shift while it loads, and a system font stack behind it. Unit tests mock `next/font/google` in `tests/setup.ts`.

**Dark mode.** The page follows the device setting by default (`color-scheme: light dark`). The header button (`components/theme-toggle.tsx`, labeled "Dark mode", with `aria-pressed`) switches to the other theme and remembers the choice in `localStorage` under `upcomer-theme`. A small inline script in `<head>` applies a stored choice by setting `data-theme` on `<html>` before first paint, so the wrong theme never flashes. Without JavaScript, the device setting still applies. `light-dark()` needs Chrome 123+, Safari 17.5+, or Firefox 120+.

**Motion and layout.** Hover and focus transitions are 120 ms and switch off under `prefers-reduced-motion`. Every focusable element shows a 2px focus ring. Layouts work down to 375px wide without horizontal scrolling. Admin pages use the same tokens but keep their existing layout.

## US-94: End-to-end tests for critical student journeys

`npm run test:e2e` runs every Playwright spec in `tests/e2e/` against a production build.
- **Requirements:** a migrated and seeded database, `ADMIN_EMAIL` and `ADMIN_PASSWORD` set for the admin specs, and no `npm run dev` running in this folder.
- **Cleanup:** each spec deletes what it creates (students, uploads, test records), so runs do not depend on exact counts.

**`tests/e2e/critical-journey.spec.ts` is the integrated end-to-end verification for Sprint 1.** One new student, in one browser session, walks the critical journey in order:
1. create an account and log in;
2. browse courses and search for "eece 350";
3. add EECE350 to My Courses and see it on `/my-courses`;
4. open the course, browse its exams, and open an exam's original PDF;
5. go back to the course, browse its materials, and open a material's original PDF;
6. log out.

Each stage is a `test.step`, so the report reads like the journey. The per-feature specs cover each member's stories in more depth.

## Continuous integration (US-95)

GitHub Actions runs `.github/workflows/ci.yml` on **every push to `main`** and **every pull request to `main`**. A pull request runs once per push to its branch. When a newer push arrives for the same branch or pull request, the older run is cancelled. A cancelled run is expected, not a failure.

Two jobs run in parallel. Both must be green before merging.

| Job | Steps |
| --- | --- |
| `checks` | Node 22 with the npm cache, `npm ci`, `npx prisma generate`, `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` |
| `e2e` | A `postgres:16` service container as a throwaway database, then `npm ci`, `npx prisma migrate deploy`, `npm run db:seed`, `npm run test:integration`, `npx playwright install --with-deps chromium`, and `npm run test:e2e` with `CI=true`. On failure, the Playwright report is uploaded as an artifact. |

No secrets are needed:
- **Database.** The e2e database exists only for the run and is thrown away afterwards. The team's hosted database is never used.
- **Admin account.** The workflow sets a test-only admin (`ci-admin@mail.aub.edu`) for the seed and the admin tests.
- **Alerts.** `ALERT_WEBHOOK_URL` is not set, so CI never posts alerts.
- **Server.** With `CI=true`, Playwright always builds and starts a fresh production server instead of reusing one.

### Reading a failing run

1. Open the pull request's **Checks** tab, or the repository's **Actions** tab, and click the red run.
2. Click the failed job (`checks` or `e2e`). The red step is the one that failed; expand it to see the output. The step names are the commands above, so `npm test` failing means a unit test failed, `npx tsc --noEmit` a type error, and so on. Run the same command locally to reproduce it.
3. For `e2e`:
   1. Scroll to the bottom of the run summary, to **Artifacts**, and download **playwright-report**.
   2. Unzip it and run `npx playwright show-report playwright-report` from the project folder.
   3. Click a failed test to see the error, the screenshot of the page, and the **trace**: every action, network request, and console message, step by step.
4. A step that fails in `npm run db:seed` or `npx prisma migrate deploy` usually means a new migration or seed change does not work on an empty database.

### Reproducing CI locally

Run the `checks` steps from a clean checkout with `npm ci && npx prisma generate && npm run lint && npx tsc --noEmit && npm test && npm run build`.

For `e2e`:
1. Point `DATABASE_URL` at an empty, throwaway PostgreSQL database, **never the shared one**.
2. Set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `FILE_STORAGE_ROOT=public/uploads`, and `CI=true`.
3. Stop any `npm run dev`, since port 3000 must be free.
4. Run `npx prisma migrate deploy && npm run db:seed && npm run test:integration && npm run test:e2e`.

### Making CI required

A repository admin can make a red run block merging: **Settings**, then **Branches**, then **Add branch protection rule** for `main`, then **Require status checks to pass before merging**, and select `checks` and `e2e`.

## Content ingestion (Member 5)

The admin upload pages cover US-70 (upload a previous exam) and US-71 (upload course materials). Each form takes a course, a title, a file, and optional professor, year, term, type (exams only), and topic. The metadata fields and their checks are shared with Member 4's file edit page (US-72). A finished upload appears on the course's exams or materials page immediately and opens through `/files/:fileId`.

- **Accepted files** are PDF, DOCX, PPTX, PNG, and JPG up to 20 MB. The type is decided from the extension and checked against the file's leading bytes, so an empty, corrupt, or renamed file is refused with a message. The MIME type sent by the browser is ignored.
- **Storage** writes each file under `FILE_STORAGE_ROOT` as `exams/<uuid>.<ext>` or `materials/<uuid>.<ext>`. The original name is kept only in `CourseFile.originalFileName`. If the database record cannot be created, the stored file is removed again.
- **`POST /api/admin/uploads`** takes `multipart/form-data` with `category` (`EXAM` or `MATERIAL`), `courseId`, `title`, `file`, and optional `professorId`, `year`, `termId`, `examType` (`MIDTERM`, `FINAL`, `QUIZ`, or `OTHER`; exams only), `topic`. It answers `201` with `{ file: { id, title, category, courseId, url } }`, or `{ reason, error }` with `400` (invalid fields, empty or corrupt file, `course_required`, `invalid_year`, `topic_too_long`, `professor_not_assigned`, `term_not_found`, `invalid_type`, `type_not_allowed`), `404` (unknown course), `413` (too large), `415` (unsupported type), or `500` (storage or database failure).

The service is in `lib/uploads.ts` (`validateUploadFile`, `parseUploadForm`, `saveUpload`, `getUploadOptions`), the limits shared with the browser are in `lib/upload-rules.ts`, and the form is `components/upload-form.tsx`.

Failures are logged with `logError` as `upload_rejected` (with the reason), `upload_storage_failed`, `upload_record_failed`, `upload_cleanup_failed`, `upload_failed`, and `upload_options_retrieval_failed`. Logs carry the course ID and category, never the file name, title, or contents.

The upload pages and endpoint are **admin-only** (fixed in `fix/admin-upload-auth`). Each `/admin/uploads` page calls `requireAdmin()`, so a student gets the not-found page and a visitor is sent to log in. `POST /api/admin/uploads` calls `getAdminUser()` before reading the body and answers `403` (`forbidden`) to anyone else.

Tests are in `tests/unit/uploads.test.ts`, `tests/unit/upload-route.test.ts`, `tests/unit/upload-pages.test.tsx`, and `tests/e2e/admin-uploads.spec.ts`. The e2e spec deletes the records and stored files it uploads when it finishes. Shared files changed: `lib/logger.ts` (the six events above), `app/globals.css` (`.form`, `.form-error`, `.form-success`), and `.gitignore` (uploaded files under `public/uploads/exams` and `public/uploads/materials`).
## Course discovery (Member 2)

The home route `/` covers US-05 (browse courses) and US-06 (search and filter courses). It lists every course with its code, name, faculty, and professors, 20 per page, and each course links to `/courses/:courseId`. An empty catalog shows "No courses are available yet."

- **Search (`q`)** matches course code or name, ignoring case. Codes also match with spaces removed, so `eece 350` finds `EECE350`. An exact code match is listed first.
- **Filters (`facultyId`, `professorId`)** come from dropdowns and combine with the search. A search or filter with no match shows "No courses found." An ID that no longer exists, for example from an old link, also shows a short message saying the selected faculty or professor doesn't exist.
- **Pagination (`page`)** keeps the search and filters. Invalid or out-of-range pages fall back to the first or last page.

The data functions are in `lib/catalog.ts` (`getCatalogCourses`, `getCatalogFilterOptions`, `rankCourses`, `paginateCourses`), and the list component is `components/course-list.tsx`. Courses and faculties managed by Member 4 appear in the catalog and dropdowns automatically.

Failures are logged with `logError` as `course_catalog_retrieval_failed`, `course_search_failed` (with the filter IDs, never the search text), and `catalog_filter_options_retrieval_failed`, then shown through the generic error page.

Tests are in `tests/unit/catalog.test.ts`, `tests/unit/catalog-page.test.tsx`, `tests/unit/course-list.test.tsx`, and `tests/e2e/course-discovery.spec.ts`. Shared files changed: `lib/logger.ts` (the three events above), `app/globals.css` (`.search` and `.pagination`), and `app/page.tsx` (replaced the placeholder).

## Question bank (Member 2, Sprint 2)

US-15a (group identical and near-identical questions), US-16 (rank questions by frequency), and US-20 (search and filter the question bank). Extracted questions are grouped per course and ranked by how many exam papers they appeared in. Students see the result at `/courses/:courseId/questions`, which is linked from the course page.

- **Tables** (migration `20261016000000_question_bank`):
  - `Question`: one extracted question, with `fileId` (its exam paper), `number` (its position in the paper, unique per paper), `text`, and `groupId`.
  - `QuestionGroup`: `courseId`, `text` (the version shown), `normalizedText` (the grouping key, unique per course), `paperCount`, and `rank` (1 is the most frequent). A group's papers are the files of its questions, so they cannot drift apart. Only `EXAM` files are grouped, and a question's course is always its paper's current course.
- **Grouping** (`lib/question-grouping.ts`). These never matter: case, spacing, sentence punctuation, a leading number (`Q3.`, `Question 2)`, `3.`, `(4)`), marks such as `(10 points)`, or spaces around a symbol. Math symbols are kept, so `a+b` and `a-b` are different questions. *Near-identical* means the same words in the same order, allowing one typo in a word of 6+ letters that keeps its first letter (`recieve`/`receive`, `normalise`/`normalize`), at most one typo per 8 words. Numbers, acronyms, and short words must match exactly, so `TCP`/`UDP`, `x^2`/`x^3`, `cable`/`table`, and `cyclic`/`acyclic` stay apart. Reworded questions are grouped too, since Sprint 3 (US-15b, below).
- **Ranking.** A group's paper count is its number of distinct papers, so a repeat inside one paper counts once. Groups are sorted by paper count, then by the most recent year they appeared, then by text. The same questions always give the same order.
- **When it runs.** `rebuildQuestionBank(courseId)` in `lib/question-bank.ts` regroups and re-ranks one course in a single transaction, holding a per-course lock so two runs cannot interleave. Call it after a paper's questions are added, changed, or removed, and for both courses after a paper moves course. A group whose key does not change keeps its ID. Admins can also run it from `/admin/questions`.
- **Search** (`getQuestionBank(courseId, filters)`). The keyword is matched the same way questions are grouped. It combines with the year, term, type, and professor filters, and one paper has to satisfy every filter. Results keep the ranking order. An empty course says "No questions have been extracted for this course yet.", and a search with no match says "No questions match your search."

The keyword is never logged. Tests are in `tests/unit/question-grouping.test.ts`, `tests/unit/question-bank.test.ts`, `tests/unit/question-bank-pages.test.tsx`, and `tests/e2e/question-bank.spec.ts`. `npm run db:seed` adds sample questions to the two EECE350 exams. Shared files changed: `prisma/schema.prisma`, `prisma/seed.ts`, `lib/logger.ts` (the four events above), `app/courses/[courseId]/page.tsx` (Question Bank card), `app/admin/catalog/page.tsx` (Question bank card), and `app/globals.css` (`.question-list`).

## Reworded grouping and question reports (Member 2, Sprint 3)

US-15b (group reworded equivalent questions) and US-23 (report a wrong question).

### Reworded grouping (US-15b)

`groupQuestions` in `lib/question-grouping.ts` first tries the US-15a rules. When neither an identical nor a near-identical group fits, the question joins the group whose first question it best *rewords*. Ties go to the earlier group. Groups are still compared by their first question only, so rewordings cannot chain.

- **Content words.** Two versions are compared by what is left after dropping:
  - function words, and the instruction itself ("Explain", "Describe", "What is", "List");
  - plurals and third-person endings (`queries`/`query`, `resolves`/`resolve`), which fold together;
  - a few exam synonyms (`difference`/`compare`/`contrast`/`distinguish`, `advantage`/`benefit`, `stage`/`step`/`phase`).
- **Other forms of a word** count as the same word, so `forward` matches `forwarded` and `normalize` matches `normalization`. A one-letter typo in a long word also counts, as in US-15a. A `-less` form never matches (`connection`/`connectionless`).
- **The rule.** One version may only add words to the other, and the shared words must cover at least `REWORDED_THRESHOLD` (0.75, Dice coefficient) of both. A content word swapped for another always keeps two questions apart, however long they are: `TCP`/`UDP`, `IPv4`/`IPv6`, `insertion`/`selection`, `advantages`/`disadvantages`, `3NF`/`BCNF`.
- **Must match exactly.** Math expressions (`x^2`, `a+b`, `x=3`), negations (`not`, `except`, `isn't`), a calculation against an explanation of the same thing, and a number that names what is asked about (`layer 3`, `RFC 793`, `port 80`, `topic number 5`).
- **Numbers may differ.** Other numbers are values. In a question of 3 or more content words they may differ, so the same exercise with other numbers is one question ("a 1500-byte packet on a 10 Mbps link" and "a 1000 byte packet over a 100 Mbps link").
- **For US-93.** `matchQuestions(a, b)` returns the decision for one pair (`identical`, `near_identical`, `reworded` with its score, or `null`). Use it, or `groupQuestions`, to measure precision and recall on the hand-checked set. Both are pure, so the same input always gives the same result.
- **Monitoring.** After each rebuild commits, `rebuildQuestionBank` logs:
  - one `question_grouping_completed` line with `questionCount`, `groupCount`, `rewordedMatches`, and `lowConfidenceMatches`;
  - one `question_grouping_low_confidence` warning for each reworded match scoring under `LOW_CONFIDENCE_BELOW` (0.85), with `questionId`, `matchedQuestionId`, and `score`, at most 20 per rebuild.

  Admins can filter both on `/admin/monitoring`. Question text is never logged.

### Question reports (US-23)

- **Table** (migration `20261024000000_question_reports`). `QuestionReport` holds one student's report of one question:
  - `courseId`, and `groupId` (set to null if a regroup removes the group);
  - `reporterId`;
  - `questionText`, the question as the student saw it, taken from the stored group and never from the form;
  - `reason` (`WRONG_GROUPING`, `WRONG_TEXT`, `NOT_A_QUESTION`, `OTHER`), and an optional `note` of up to 500 characters;
  - `status` (`OPEN`, `RESOLVED`, `DISMISSED`), `closedAt`, and `closedById`.
- **Reporting.** On `/courses/:courseId/exam`, each question has a closed "Report a problem with question N" form for logged-in students. Visitors see a "Log in" link that comes back to the exam. `reportQuestion` in `lib/question-reports.ts`:
  - checks a per-student limit (`QUESTION_REPORT_RATE_LIMIT_PER_MINUTE`, default 10);
  - checks the reason, and that the note is 500 characters or fewer;
  - accepts only a question from a published paper;
  - holds a per-student, per-question lock, and refuses a second report while the student's first one is open ("You already reported this question.").

  The student returns to the same question with the outcome.
- **The admin queue.** `/admin/reports`, linked from `/admin/catalog`, shows each question with open reports as one item, reported longest ago first, 20 per page. Each item has the course, rank, paper count, how many students reported it and why, their notes, and a link to the course's Upcomer Exam. A second student's report of the same question joins its item and does not open a second one. A question regrouped away since it was reported is shown with the text the student saw.
- **For US-75.** `closeQuestionReports(adminId, { groupId } | { reportIds }, "RESOLVED" | "DISMISSED")` closes open reports and returns how many were closed. The queue shows only `OPEN` reports.
- **Monitoring.** `question_report_submitted` (info), `question_report_refused` and `question_report_rate_limited` (warn), and `question_report_failed` and `question_report_retrieval_failed` (error). They carry IDs, the reason, and error types. The note is never logged.

Tests: `tests/unit/question-grouping.test.ts`, `tests/unit/question-bank.test.ts`, `tests/unit/question-reports.test.ts`, `tests/unit/question-report-pages.test.tsx`, and `tests/e2e/question-reports.spec.ts`. Shared files changed: `prisma/schema.prisma`, `lib/logger.ts`, `lib/submission-review.ts` (exports `readable`), `components/consolidated-exam.tsx` and `app/courses/[courseId]/exam/page.tsx` (the report form and notices), `tests/unit/consolidated-exam-page.test.tsx` (mocks the session), `app/admin/catalog/page.tsx` (Question reports card), and `.env.example`.

## Study progress and the personal order (Member 3, Sprint 3)

US-21 (mark questions done and resume), US-33 (learning profile kept per course), and US-28 (personal ordering of the Upcomer Exam). US-24 and US-27 provide confidence and priorities; Sprint 4 US-25 adds performance evidence and US-29 adds explanations (see the Sprint 4 section below).

After pulling, run `npx prisma generate` and `npm run db:migrate`. Two migrations are new: `20261027000000_learning_profile` and `20261028000000_question_progress`.

### Mark done and resume (US-21)

- **Table** `QuestionProgress`: one row per question a student marked done. It holds `userId`, `courseId`, `groupId`, `sourceQuestionIds` (the group's questions when it was marked, its first question first), and `doneAt`. A student can mark a question once (unique on `userId` and `groupId`).
- **On the exam.** Each question has a **Mark done** button, and a done question shows "✓ Done" with **Undo**. Above the questions, "N of M questions done. Continue at question K" names the first question not done, in the order shown. Opening the exam scrolls there; marking or undoing a question scrolls back to it (`?at=N`, because Next.js drops a redirect's `#question-N` after a server action). Without JavaScript, the link and the `#question-N` do the same. Visitors see neither.
- **Whose progress.** `markQuestionAction` calls `requireUser()` first and never reads a user ID from the form; every read is filtered by the session user, so one student never sees another's progress. Only questions from a course's published exam papers can be marked. Marks per student per minute are limited by `QUESTION_PROGRESS_RATE_LIMIT_PER_MINUTE` (default 60); one student's clicks are serialized with a lock.
- **After a regroup.** A regroup that changes a group's first question replaces the group. Its marks are kept (`groupId` is set to null) and re-linked, in the same course only, to the group that now holds the marked question, or else most of its other questions. A mark whose questions are all gone stays hidden rather than attached to a guess.
- **Marking does not change the learning profile.**

### Learning profile kept per course (US-33)

- **Table** `LearningTopic`: one row per student, course, and topic (primary key `userId`, `courseId`, `topicKey`), holding `weakness`, from 0 (strong) to 1 (weak). The course is part of the key, so a change in one course never changes another, and two courses with a topic of the same name keep separate rows. `topicKey` ignores case and spacing.
- **A question's topic** is its exam papers' `CourseFile.topic` (set on upload or at `/admin/files`); when they disagree, the most common, then the newest paper's.
- **Writing it.** `setTopicWeakness` serves confidence saves; `recordLearningEvents` in `lib/learning-evidence.ts` atomically saves performance events, counts, and combined weakness. `getLearningProfile(userId, courseId)` reads one course.

### Personal order (US-28)

- Logged-in students get a **Frequency order / Personal order** switch. `?order=personal` shows one list, "Your order", sorted by `personalPriority` for each question; ties keep the frequency order. Each question keeps its number, tier badge, mark form, and report form. **Frequency order** (the address without `?order=personal`) restores the stored ranking.
- A student with no profile rows in the course sees the frequency order with "You have no learning profile for this course yet, so this is the frequency order." Visitors always get the frequency order.

### Placeholders for other stories

- None left. `NEUTRAL_WEAKNESS = 0.5` now lives in `lib/learning-profile.ts` as US-24's neutral default: the weakness of a skipped topic, a topic never rated, and a question with no topic. `lib/personal-order.ts` re-exports it.

### Topic confidence (US-24)

- **`/courses/:courseId/confidence`** (logged-in students; a visitor is sent to log in and comes back) lists the course's topics: the distinct `CourseFile.topic` values of its published exam papers, keyed with `topicKey`, so they match the personal order. Each topic is rated **1 Not confident … 5 Very confident** or **Skip**, in one plain POST form pre-filled with the student's saved ratings. A course with no topics shows a message instead of a form. The Upcomer Exam links to it ("Rate your topics") under the order switch, and from the "no learning profile" note.
- **Saving** (`saveTopicConfidence` in `lib/topic-confidence.ts`) turns a rating into `weakness = (5 − rating) / 4` (1 → 1, 3 → 0.5, 5 → 0) and writes it with `setTopicWeakness`, together with the rating in `LearningTopic.confidence` (migration `20261101000000_topic_confidence`). All topics are saved in one transaction with room for a slow database (`maxWait` 10 s, `timeout` 20 s); if any write fails, nothing is kept.
- **Skip** writes `NEUTRAL_WEAKNESS` with no rating, when the topic has no row yet or the student had rated it before. A row written by other code without a rating (for example US-25) is left alone, so its weakness is kept.
- **Refused, saving nothing:** a topic that isn't one of this course's (including another course's), a rating that isn't 1–5 or Skip, a topic sent twice, or an empty form. Only the session student's rows for this course are ever written. Saves per student per minute are limited by `TOPIC_CONFIDENCE_RATE_LIMIT_PER_MINUTE` (default 30).

### Priorities (US-27)

- **`personalPriority(paperCount, totalPapers, weakness)`** in `lib/personal-order.ts`: `share of papers × (1 + WEAKNESS_WEIGHT × weakness)`, with `WEAKNESS_WEIGHT = 2`. A student's strongest topic still counts at its full exam share, and the weakest counts at most 3 times as much. Equally weak questions rank by frequency, and equally frequent ones by weakness. The function is pure, so the same inputs always give the same priority.
- **Invalid inputs** (NaN, Infinity, negative counts, more papers than the course has, weakness outside 0–1) never throw. `checkedPriority` clamps each one to a safe value and returns the reason codes. `personalizeQuestions` logs at most one `priority_calculation_failed` line per ranking, so a bad course can't flood the error alert.

### Strongest and weakest topics (US-26, Mustafa Ergaibi, Sprint 4)

- **`/courses/:courseId/topics`** ("Your topics"; logged-in students, a visitor is sent to log in and comes back; an unknown course is not found) shows the student's strongest and weakest topics in that course. The confidence page and, for logged-in students, the Upcomer Exam link to it. US-30 adds the "Study next" section above it (see below); US-32 can add its own.
- **One course only.** `getTopicStrengths(userId, courseId)` in `lib/topic-strengths.ts` reads the stored `weakness` through `getLearningProfile` (never recomputed) and the course's published exam-paper topics. Another course's or another student's profile is never read.
- **Evidence rule.** A topic counts only with a saved confidence rating or at least one recorded practice outcome (`correctCount + incorrectCount > 0`). A skipped, never-practised topic is never a strength or a weakness. A profile topic that is no longer on a published exam paper of the course is left out, and so is a row whose stored weakness is not between 0 and 1 (counted in `topic_strengths_invalid_data`).
- **Order** (`lib/topic-strengths-rules.ts`, pure): weakness descending, then exam frequency (published papers with the topic) descending, then topic name. Weaknesses within `1e-9` are a tie.
- **Lists.** With `N` topics that have evidence, each list has `k = min(3, floor(N / 2))` topics: "Weakest so far" is the first `k`, "Strongest so far" the last `k`, strongest first. A tie is never split between the two lists: if the lists would meet at tied topics, every topic with that weakness is dropped from both (0.8, 0.5, 0.5, 0.2 gives one weakest and one strongest). A side left empty says no topic stands out.
- **Each topic shows what it rests on**, for example "Rated 2 of 5, 3 correct and 1 incorrect" or "Rated 4 of 5, no practice recorded". No score or percentage is shown, and the page says it is a guide, not a measure of mastery.
- **Not enough data** gives a message and a "Rate your topics" link instead of a list: no topics in the course (no link, nothing to rate), no learning profile, every topic skipped with no practice, only one topic with evidence, or all topics level (they are listed once, with no strongest or weakest).
- **Monitoring:** `topic_strengths_retrieval_failed` and `topic_strengths_invalid_data` in the events table. IDs, the failed read, a count, and error types only; topics are never logged. A failed read is logged once and the page shows the generic error page.
- **Tests:** `tests/unit/topic-strengths.test.ts`, `tests/unit/topic-strengths-pages.test.tsx`, `tests/integration/topic-strengths.test.ts` (isolation between courses and students; outcomes through `recordLearningEvents` move a topic between strongest and weakest), and `tests/e2e/topic-strengths.spec.ts`. They create their own faculty, courses and students and delete them.
- **Shared files changed:** `lib/logger.ts` (two events), `app/courses/[courseId]/confidence/page.tsx` (two links), `app/courses/[courseId]/exam/page.tsx` (one link for logged-in students), and `README.md`.

### Study next (US-30, Mustafa Ergaibi, Sprint 4)

- **The "Study next" section** at the top of `/courses/:courseId/topics` recommends one topic to study next in that course, says why, and links to practice.
- **Same rule as the personal order (US-27).** `recommendNext` in `lib/study-next-rules.ts` (pure) gives every topic of the course's published exam papers the priority `checkedPriority(paperCount, totalPapers, weakness)`: exam share × (1 + `WEAKNESS_WEIGHT` × weakness). There is no second formula. `paperCount` is the published exam papers tagged with the topic; `totalPapers` is all published exam papers of the course, tagged or not, as on the Upcomer Exam.
- **Weakness** is the stored weakness of the student's profile row in this course. A topic with no row (never rated, never practised) uses `NEUTRAL_WEAKNESS`, so a frequent untouched topic can be recommended and a student with no profile still gets a recommendation. A profile topic that is no longer on a published exam paper is ignored. A stored weakness outside 0–1 is clamped by `checkedPriority`, not dropped, and counted in `study_recommendation_invalid_inputs`.
- **Order:** priority descending, then exam frequency descending, then topic name. Priorities within `1e-9` are a tie. The first topic is the recommendation; exactly one topic is recommended. With 5 papers: DNS (1 paper, weakness 1) = 0.6 beats TCP (2 papers, weakness 0) = 0.4; an untouched TCP in 3 papers = 1.2 beats that DNS.
- **Practice updates it.** `getStudyNext(userId, courseId)` in `lib/study-next.ts` reads on every page load and nothing is cached, so outcomes recorded through `recordLearningEvents` show the next time the page opens. The page makes one read (`readTopicInputs` in `lib/topic-strengths.ts`) and gives it to this section and to US-26's.
- **The reason** is one short line from the inputs, for example "In 2 of this course's 5 published exam papers. Rated 2 of 5, 0 correct and 3 incorrect." or "… Not rated and no practice recorded, so a neutral weakness is used." "How this is worked out" holds `explainPriority`'s text for the topic, unchanged. Nothing claims mastery, and the section says it is not a guarantee of what the next exam will cover.
- **Next actions:** "Practise questions" (`/courses/:courseId/practice`) and "See the Upcomer Exam in your personal order" (`/courses/:courseId/exam?order=personal`), plus "Rate your topics" for an unrated topic. Neither page can show one topic only, so the links open the pages themselves. The practice page links back with "Your topics".
- **No topics:** a course whose published exam papers have no topics shows "This course's exam papers have no topics yet, so there is no topic to recommend." and no links.
- **Covered topics (US-32)** are left out of `ranked` before the pick; see the next section.
- **Monitoring:** `study_recommendation_failed` and `study_recommendation_invalid_inputs` in the events table. IDs, the failing step, a count, reason codes, and error types only; topics are never logged. A failed shared read fails both sections, so that page load also logs `topic_strengths_retrieval_failed`.
- **Tests:** `tests/unit/study-next.test.ts`, `tests/unit/study-next-pages.test.tsx`, `tests/integration/study-next.test.ts` (incorrect outcomes through `recordLearningEvents` change the recommended topic and correct ones change it back; another course or student never affects it), and `tests/e2e/study-next.spec.ts`. They create their own faculty, courses and students and delete them.
- **Shared files changed:** `lib/logger.ts` (two events), `app/courses/[courseId]/practice/page.tsx` (one "Your topics" link), and `README.md`.

### Topics already covered (US-32, Mustafa Ergaibi, Sprint 4)

After pulling, run `npx prisma generate` and `npx prisma migrate deploy`. One migration is new: `20261115051729_topic_covered` (one new table, nothing else changed).

- **The "Covered topics" section** at the bottom of `/courses/:courseId/topics` lists every topic of the course's published exam papers in name order, each with "Mark as covered" or "Undo covered". The "Study next" card has the same "Mark as covered" button for the recommended topic.
- **Covered only steers the recommendation.** `recommendNext` leaves covered topics out of `ranked` before the pick; the other topics keep their priority (`totalPapers` and every exam share are unchanged). When some are left out, the section says how many. When every topic is covered, the state is `all_covered` and the section shows "You marked every topic of this course as covered, so there is no topic to recommend. Undo one below to get a recommendation again."
- **Covered never claims mastery.** It does not change the stored weakness, the confidence rating, the practice counts or the learning events, and it is not read by the personal order of the Upcomer Exam, the confidence page or the practice page. In the strongest and weakest lists `selectStrengths` picks exactly as before; a covered topic keeps its place and gets a "Covered" label (`RankedTopic.covered`). A covered topic is never moved into "Strongest so far".
- **Storage: its own table.** `CoveredTopic` (`userId`, `courseId`, `topicKey`, `createdAt`; primary key on the three, so the flag is per student per course). A row means covered; undo deletes it. It is not a column on `LearningTopic` on purpose: marking a topic the student never rated or practised would have to create a profile row with an invented weakness, and any profile row counts as "has a profile" for the personal order (`personalizeQuestions`), turns "no profile" into "no evidence" in US-26, and changes how a later Skip is counted in US-24. With its own table, a topic marked covered but never rated or practised still has no evidence and no profile row.
- **Saving** (`setTopicCovered` in `lib/topic-covered.ts`, called by `setTopicCoveredAction` after `requireUser()`; the user ID is the session's, never the form's). Each button is its own plain POST form with `courseId`, `topicKey` and `covered` (`1` or `0`). The form sets a state instead of toggling, so a double submit or a stale page gives the same result (`changed: false`).
- **Refused, saving nothing, with a message:** a topic that isn't one of this course's published exam-paper topics (including a topic of another course, or an unknown one), a value that isn't `1` or `0`, and a missing or repeated field. The page shows the message for the reason code and never the submitted value.
- **Rate limit:** `TOPIC_COVERED_RATE_LIMIT_PER_MINUTE` changes per student per minute (default 30), kept in memory per server process (`lib/rate-limit.ts`). Over the limit nothing is read or saved.
- **Lock:** the write runs in a transaction that first takes `pg_advisory_xact_lock(hashtext('learning-profile:<userId>:<courseId>'))`, the same lock as a confidence save (US-24) and a practice outcome (US-25), so a covered save never interleaves with them.
- **A flag for a topic that later leaves the published papers** is kept but ignored: it is not listed, not counted as left out, and cannot be changed until the topic is back.
- **Monitoring:** `topic_covered_saved`, `topic_covered_refused`, `topic_covered_rate_limited` and `topic_covered_save_failed` in the events table. IDs, the new state, reason codes, and error types only; topics are never logged. A failed read of the covered topics is logged by the page's two existing events with `source`/`step` `covered`.
- **Tests:** `tests/unit/topic-covered.test.ts` (the filter, the all-covered state, the lists unchanged apart from the label, the form), `tests/unit/topic-covered-service.test.ts` (the save, the lock, the limit, the events, the action), `tests/unit/topic-covered-pages.test.tsx`, `tests/integration/topic-covered.test.ts` (marking never changes a profile row or an event, never reaches another course or student, undo restores the recommendation, and a covered save, a rating save and a practice outcome succeed together), and `tests/e2e/topic-covered.spec.ts` (mark, the recommendation moves on, the label, log out and in, undo, all covered, a tampered form). They create their own faculty, courses and students and delete them.
- **Shared files changed:** `prisma/schema.prisma` (the `CoveredTopic` model, and one relation line each on `User` and `Course`), the new migration, `lib/logger.ts` (four events), `.env.example` (one variable), and `README.md`.

### Weak-topic practice (US-31, Lea Tass, Sprint 4)

- **`/courses/:courseId/practice/weak-topics`** (logged-in students; a visitor is sent to log in and comes back; an unknown course is not found) shows a practice set of 5, 10, or 20 questions from the course's Upcomer Exam (`?size=`, default 10; any other value means 10), chosen with a plain GET form. The course home page and the Upcomer Exam (logged-in students) link to it. Ali Slim's `/courses/:courseId/practice` page is unchanged. No migration: the set is worked out on each visit and nothing is stored.
- **How questions are chosen** (`selectPracticeSet` in `lib/practice-set.ts`, pure). Each question's topic is its papers' topic (`questionTopic`, US-33); questions without a topic form one group with the neutral weakness. Topics share the N places in proportion to US-27's factor `1 + WEAKNESS_WEIGHT × weakness` (1 for the strongest, 3 for the weakest), handed out one at a time (D'Hondt), so a weaker topic gets more places and a strong topic still gets some. A topic with too few questions passes its places on. Within a topic the most frequent questions come first. Ties go to the weaker topic, then to the more frequent question. The same inputs always give the same set.
- **Weakness** is the stored `LearningTopic.weakness` (ratings from US-24 and recorded outcomes from US-25 both count). A topic is weak when it is above `NEUTRAL_WEAKNESS`. A stored value outside 0–1 counts as neutral.
- **Fallback.** With no topic weaker than neutral (no profile in the course, or only neutral and strong topics), the set is the N most frequent questions, with a note and a "Rate your topics" link.
- **Edge cases.** No question appears twice. A course with fewer than N questions gives all of them, with a note. A course with no questions shows a message and no form. Questions marked done (US-21) are included.
- **Attempting.** Each question links to its place in the Upcomer Exam (`#question-N`). Recording outcomes stays on `/courses/:courseId/practice` (US-25); viewing a set never writes the profile.
- **Monitoring:** `practice_set_failed` (IDs, the size, and the error type; never a topic or question text).
- **Tests:** `tests/unit/practice-set.test.ts`, `tests/unit/practice-set-pages.test.tsx`, `tests/unit/course-pages.test.tsx` and `tests/unit/personal-order-pages.test.tsx` (the links), `tests/integration/practice-set.test.ts` (ratings and recorded outcomes both steer the set; another course's profile changes nothing; reading never writes), and `tests/e2e/practice-set.spec.ts`. They create their own courses and students and delete them.
- **Shared files changed:** `lib/logger.ts` (one event), `app/courses/[courseId]/page.tsx` (one card), `app/courses/[courseId]/exam/page.tsx` (one link), and `README.md`.

### Rate and sort advice (US-40, Lea Tass, Sprint 4)

After pulling, run `npx prisma generate` and `npx prisma migrate deploy`. One migration is new: `20261117000000_advice_votes` (one new table; nothing else changed).

- **Marking.** Under each post on `/courses/:courseId/advice`, "N students found this helpful" and, for a logged-in student, **Mark as helpful** or **Undo helpful** (a plain POST form, `aria-pressed`). The author sees the count of their own advice with "Your advice" and no button; a visitor sees the count and "Log in to mark it helpful", which comes back to the same view.
- **One per student.** `AdviceVote` (`adviceId`, `userId`, `createdAt`; primary key on the two, both cascade on delete). The form sets a state (`helpful` `1` or `0`) instead of toggling, and a mark uses `createMany` with `skipDuplicates`, so a double click, a stale tab, or ten parallel requests make one row (`changed: false` for the rest). Undo deletes only the student's own row.
- **Refused, saving nothing, with a message:** advice of another course, removed advice, an unknown ID (all `not_found`, so nothing says whether an ID exists elsewhere), the author's own advice (`own_advice`), and a value other than `1` or `0` (`invalid_value`). `setAdviceHelpful` in `lib/advice-votes.ts` is called by `setAdviceHelpfulAction` (`lib/advice-vote-actions.ts`) after `requireUser()`; the user ID is the session's, never the form's.
- **Sort.** A "Sort advice" select next to the filters (the page's `advice-page.module.css` gives this row's selects a 9rem basis, so the four selects and Search stay on one line at desktop width and wrap two per line on a phone): **Newest first** (the default, as before) or **Most helpful first** (`sort=helpful`). `searchAdvice` orders by the number of marks, then newest, then ID, so ties are stable and the newer post wins. It combines with search, filters and pages, stays inside the course, and never shows removed advice. Marking or undoing comes back to the same search, filters, sort and page (`keptAdviceQuery` keeps only `q`, `topic`, `examId`, `termId`, `sort`, `page`).
- **Privacy (US-37).** Students only get counts and whether they marked a post themselves (`getHelpfulCounts`); who marked it is never sent to any page, so anonymous advice stays anonymous.
- **Rate limit:** `ADVICE_VOTE_RATE_LIMIT_PER_MINUTE` marks per student per minute (default 30), in memory per server process. Over the limit nothing is read or saved.
- **Monitoring:** `advice_vote_saved`, `advice_vote_refused`, `advice_vote_rate_limited`, `advice_vote_failed`, `advice_vote_retrieval_failed` in the events table. IDs, the new state, reason codes and error types only.
- **Tests:** `tests/unit/advice-votes.test.ts`, `tests/unit/advice-votes-pages.test.tsx` (the page and the action), `tests/integration/advice-votes.test.ts` (one mark per student, ten parallel clicks, undo, the sort and its ties, refusals, voters never exposed, another course and removed advice never sorted in), and `tests/e2e/advice-votes.spec.ts` (mark, stale tab, undo, sort, two students, the author, a visitor, a tampered form, 375 px in light and dark mode). They create their own courses and students and delete them.
- **Shared files changed:** `prisma/schema.prisma` (the `AdviceVote` model, and one relation line each on `Advice` and `User`), the new migration, `lib/advice.ts` (`sort` in `AdviceFilters` and the `orderBy`), `components/advice-list.tsx` (an optional `helpful` prop), `app/courses/[courseId]/advice/page.tsx` (the sort select, the counts, the notices, `sort` in page links), `lib/logger.ts` (five events), `.env.example` (one variable), and `README.md`.

### Discuss beneath an advice post (US-41, Lea Tass, Sprint 4)

After pulling, run `npx prisma generate` and `npx prisma migrate deploy`. One migration is new: `20261118000000_advice_comments` (one new table; nothing else changed).

- **The thread.** Under each post on `/courses/:courseId/advice`, a closed **Discussion (N replies)** section lists the replies oldest first (ties by ID), each with who wrote it and when (UTC). A logged-in student gets a **Your reply** box (plain POST form, required, at most 1000 characters) and **Post reply**; a visitor sees the replies and "Log in to reply". After posting or deleting, the student comes back to the same search, filters, sort and page with that thread open (`thread=<adviceId>`); the reply text is never put in the URL.
- **Who a reply is shown as** (`commentAuthorLabel` in `lib/advice-comment-rules.ts`): other students under their name (there are no anonymous replies); the post's own author marked **(author)**, and on an anonymous post as **Anonymous student (author)**, so the name never appears; a deleted account as "Former student". The form says how the student's reply will be shown. Students never receive an author ID (`PublicComment`).
- **Stays under the right post.** `AdviceComment` (`id`, `adviceId`, `authorId`, `body`, `createdAt`; cascade with the advice, author set to null if the account is deleted). `addAdviceComment` accepts a reply only for visible advice of the course in the form, so another course's or an unknown post is refused (`not_found`).
- **Removed advice hides its thread.** The page lists visible advice only, `getAdviceComments` reads replies of visible advice of the course only, and a reply to removed advice is refused, also from a stale form. The replies are kept in the table (hidden, not deleted) for moderation (US-77).
- **Empty replies are refused** (`body_required`): empty, spaces, line breaks, or invisible characters only. Over 1000 characters is `body_too_long`.
- **Deleting.** A reply shows **Delete my reply** to its author and **Delete reply** to an admin. `deleteAdviceComment` checks it again on the server: anyone else, including the post's author, is refused (`forbidden`) and nothing changes; the delete repeats the condition so it cannot race. The role comes from the session, never the form. Only this permission check is built; reviewing reported content is US-77 (Mohammed).
- **Rate limit:** `ADVICE_COMMENT_RATE_LIMIT_PER_MINUTE` replies per student per minute (default 10), in memory per server process.
- **Monitoring:** `advice_comment_saved`, `advice_comment_refused`, `advice_comment_rate_limited`, `advice_comment_deleted`, `advice_comment_delete_refused`, `advice_comment_failed`, `advice_comment_retrieval_failed`. IDs, reason codes and error types only; reply text is never logged.
- **Tests:** `tests/unit/advice-comments.test.ts`, `tests/unit/advice-comments-pages.test.tsx` (the thread, the forms, the actions), `tests/integration/advice-comments.test.ts` (time order, the right post and course, empty replies, a removed post's thread, the labels, who may delete, deleted accounts and posts), and `tests/e2e/advice-comments.spec.ts` (two students and the author reply, an empty reply, a tampered delete, the admin deletes, a removed post with a stale form, 375 px in light and dark mode). They create their own course and students and delete them.
- **Shared files changed:** `prisma/schema.prisma` (the `AdviceComment` model, and one relation line each on `Advice` and `User`), the new migration, `components/advice-list.tsx` (an optional `discussion` prop), `app/courses/[courseId]/advice/page.tsx` (the threads, the notices), `lib/logger.ts` (seven events), `.env.example` (one variable), and `README.md`; `tests/unit/advice-votes-pages.test.tsx` and `tests/unit/advice-separation-pages.test.tsx` (mine) mock the new reads.

### Alternative version of a mock exam (US-46, Lea Tass, Sprint 4)

After pulling, run `npx prisma generate` and `npx prisma migrate deploy`. One migration is new: `20261119000000_mock_exam_versions` (one nullable column on `MockExam`, its index and foreign key; nothing else changed).

- **Make an alternative version.** Under a mock exam (in progress or submitted), the **Versions** section lists the exam's versions (Version 1 is the original; this one is marked, the others are links) and has **Make an alternative version** (a plain POST form). The new version opens with "This is version N of this mock exam…".
- **Same settings, different questions** (acceptance tests 1 and 2). The new exam is made by US-45's `createMockExam` with the original's stored settings (topics, length, difficulty, generated questions), so it follows exactly the same rules, and with `selectMockQuestions`' `exclude` (Mustafa's contract) so it shares no question with the original **or any earlier version**: version 3 avoids versions 1 and 2, whichever version it is asked from.
- **"The same question"** (`lib/mock-exam-version-rules.ts`, pure) is matched by question-bank group and generated item, and also by text, normalized as grouping does (`normalizeQuestionText`), so a question whose stored group was nulled by a regroup is still recognised.
- **Too few unused questions:** nothing is saved and the exam shows, for example, "Only 2 unused questions match these settings (not in this exam or any of its versions), and a new version needs 3. Make a new mock exam with other topics or a shorter length instead." (or "Every question matching these settings is already in this exam or one of its versions…"). The count is the one `selectMockQuestions` reports.
- **Linking.** `MockExam.originalId` (nullable, set null if the original is deleted) points every version at the original, so a family is the original and the exams linked to it; version numbers follow creation order (`numberVersions`). A new original made from the form is its own family and may reuse questions.
- **Only the owner.** The action calls `requireUser()` first; the exam and its family are read for the session student only, so another student's exam is not found (the refusal returns to that exam's address, which is not found for them as well). The new version opens in its exam's own course, whatever course the form names.
- **Two quick clicks** run one after the other per family in the server process (as the rate limits, one process is assumed), so they give versions 2 and 3, never two overlapping versions. A version counts toward `MOCK_EXAM_RATE_LIMIT_PER_HOUR` like any mock exam.
- **Monitoring:** `mock_exam_version_created`, `mock_exam_version_refused` (with `reason` and `available`), `mock_exam_version_failed`, plus US-45's own `mock_exam_created` (now with `originalId`) and `mock_exam_refused`. IDs, counts, reason codes and error types only.
- **Tests:** `tests/unit/mock-exam-version-rules.test.ts`, `tests/unit/mock-exam-versions-pages.test.tsx` (the section, the notices, the action), `tests/integration/mock-exam-versions.test.ts` (settings kept, no shared question, version 3, refusals with counts, ownership, parallel requests, regrouped text, generated questions), and `tests/e2e/mock-exam-versions.spec.ts` (generate, submit, version 2 and 3, a refused 4th with the count, another student, 375 px in light and dark mode). They create their own course and students and delete them.
- **Shared files changed:** `prisma/schema.prisma` (`originalId`, its relation and index on `MockExam`), the new migration, `lib/mock-exams.ts` (an optional `version` argument on `createMockExam`: the exclusions and `originalId`; without it nothing changes), `app/courses/[courseId]/mock-exams/[mockExamId]/page.tsx` (the versions read, two notices, the section), `tests/unit/mock-exam-pages.test.tsx` (mocks the versions read; the submitted-exam test now checks that the only button is the alternative-version one instead of no button at all), `lib/logger.ts` (three events), and `README.md`.

### Advice kept apart from exam statistics (US-42, Lea Tass, Sprint 4)

- **Two labels** (`components/source-label.tsx`): **Student opinion** (personal experience of previous students; not exam data, never changes the rankings or counts) and **Historical exam data** (counted from the course's published past exam papers only; student advice is never part of it). The difference is in the words and the tag's outline (dashed or solid), never in color alone; only theme tokens are used, in a CSS module of its own.
- **Course home page:** the Question Bank and the Upcomer Exam sit in an **Exam statistics** section labelled Historical exam data, and Advice sits in an **Advice from previous students** section labelled Student opinion. The other cards stay under Course Resources.
- **Advice page:** labelled Student opinion under the title, with a link to the Upcomer Exam "(historical exam data)", and every post carries a Student opinion tag.
- **Upcomer Exam:** labelled Historical exam data under the title, for students and visitors, with a link to the Advice page "(student opinion)".
- **Advice never enters the rankings or counts.** No exam-statistics code reads the `Advice` or `AdviceVote` tables: the consolidated exam, the question bank and its regroup, the personal order, the study-next pick, the weak-topic practice set, and the mock-exam pool. `tests/integration/advice-separation.test.ts` reads all of them, publishes advice in all five scopes (one anonymous, one repeating a past-paper question word for word), marks it helpful, regroups, and checks every result is identical and contains no advice text.
- **Question Bank and weak-topic practice:** also labelled Historical exam data under the title. The Question Bank links to the Advice page "(student opinion)"; the weak-topic page adds that the mix of topics follows the student's own ratings and practice.
- These are the only screens that show advice or link both kinds; the topics, practice and mock-exam pages show no advice.
- **Tests:** `tests/unit/advice-separation-pages.test.tsx`, `tests/integration/advice-separation.test.ts`, and `tests/e2e/advice-separation.spec.ts` (labelled sections, a published advice that repeats a question never changes the Upcomer Exam or its counts, 375 px in light and dark mode). They create their own course and student and delete them.
- **Shared files changed:** `app/courses/[courseId]/page.tsx` (the two labelled sections; the three cards moved into them, with `h3` headings), `app/courses/[courseId]/advice/page.tsx` (the label and a link), `components/advice-list.tsx` (a tag per post), `app/courses/[courseId]/exam/page.tsx` (the label and a link), `app/courses/[courseId]/questions/page.tsx` (the label and a link), and `README.md`.

### Configurable mock exams (US-45, built by Ali Shammakh, taken over and fixed by Mustafa Ergaibi, Sprint 4)

After pulling, run `npx prisma generate` and `npx prisma migrate deploy`. Two migrations are new: `20261116000000_mock_exams` (the two tables) and `20261116000001_mock_exam_sources` (three additive columns; it sorts right after the first because it alters its tables).

- **Acceptance tests:** "Select topic, length, difficulty; exam follows chosen constraints and has a usable sitting flow." "Given a request larger than the available material supports, when generated, then the student is told and receives the largest valid exam."
- **The form** at `/courses/:courseId/mock-exams` takes topics (none ticked means every topic), a length from 3 to 50, and a difficulty. A visitor sees the page and a link to log in.
- **The exam follows the settings.** `selectMockQuestions` in `lib/mock-exam-mix.ts` (pure, server only) picks the length asked for, only from the chosen topics and at the chosen difficulty. A question's topic is its papers' most common topic (`questionTopic`).
- **Larger than the material (fixed in Sprint 4 by Mustafa Ergaibi):** the student gets the largest exam the chosen topics and difficulty allow. `MockExam.length` is the exam's length and `MockExam.requestedLength` what was asked (null on older exams). The exam page says, every time it is opened, "You asked for 10 questions, but your topics have only 7 that fit, so this exam has 7." (with generated questions ticked: "… 7 that fit (past papers and your generated practice questions of this difficulty) …"). An exam is refused only when nothing at all matches (possible through US-46's `exclude`); the form's minimum request stays 3, but such an exam can be shorter.
- **Difficulty is an estimate**, and the form says so: past papers carry no difficulty rating, so questions are sorted by `complexityOf` (length, plus a fixed amount per extra part). Easier takes the simplest, Harder the most complex, Medium the middle, Mixed a spread over the whole range. When the chosen topics have just enough questions, every difficulty gives the same exam and the exam page says so.
- **The same settings give the same exam.** The selection has no randomness. US-46 gets a different version through the `exclude` option.
- **The exam is a copy.** Question text, topic, "appeared in X of Y papers" and the paper titles are copied into `MockExamQuestion`, so a rebuild of the question bank never changes an exam.
- **Sitting** at `/courses/:courseId/mock-exams/:mockExamId`: one box per question, "Save progress" and "Submit exam". Saved answers are still there after a reload. Submitting saves and locks: claiming the exam and writing the answers are one transaction, so a second tab or a repeated POST gets "already submitted" and changes nothing.
- **Only the owner.** The pages and actions call `requireUser()` first; every read and write is filtered by the session user's ID, and a user ID in a form is ignored. Another student's exam, and an exam opened under another course, are not found.
- **Refused with a message, saving nothing:** nothing matching, a length outside 3 to 50, a difficulty not in the list, a topic the course does not have, an answer over 5000 characters (a line break counts once), an answer for another exam's question (ignored).
- **Rate limit:** `MOCK_EXAM_RATE_LIMIT_PER_HOUR` exams per student per hour (default 20), in memory per server process. Only exams that are made count; a refused attempt does not.
- **Generated practice questions (US-44).** A checkbox, off by default, so the past-paper flow is unchanged. When ticked, at most half of each topic's questions (`generatedShare`, rounded down; so never more than half of the exam) are the student's own generated questions of the chosen topics and difficulty (any difficulty for Mixed); past papers fill the rest. Since US-47 the share is per topic, so the weighting also decides which topics they come from. They are read only through `getGeneratedPracticeQuestions` (Ali Slim's contract), never from the table, and nothing is generated on the fly. A generated question is shown as "Generated practice question, based on …" and stored with `paperCount` 0 because it appeared in no paper.
- **Monitoring:** the `mock_exam_*` events in the events table. IDs, the settings, counts, reason codes and error types only; question text and answers are never logged.
- **Tests:** `tests/unit/mock-exam-rules.test.ts`, `tests/unit/mock-exams.test.ts`, `tests/unit/mock-exam-generated.test.ts`, `tests/unit/mock-exam-pages.test.tsx`, `tests/integration/mock-exams.test.ts`, and `tests/e2e/mock-exams.spec.ts` (the acceptance test, the sitting flow with a stale second tab, ownership, tampered settings, generated questions, and 375 px in light and dark mode). They create their own courses and students and delete them.

**What was wrong when it was taken over, and fixed:** main had merge-conflict markers in `prisma/schema.prisma`; the nine `mock_exam_*` events were missing from `lib/logger.ts`, so the type-check and the build failed; the save wrote up to 50 answers one by one inside a 5-second transaction; the answer limit counted a browser's line breaks twice, which refused an allowed answer and lost the others typed with it; the forms had no styles; a refused attempt used up the hourly limit; one integration test expected a wrong paper title; there was no e2e test, no page test and no documentation.

**Contracts for the stories that build on it (none of them is built here):**
- **US-46, alternative version (Lea):** `MockExam` keeps the settings (`topicKeys`, `requestedLength`, `difficulty`, `includeGenerated`, `timeLimitMinutes`); use `requestedLength ?? length` as the length to ask for. Call `selectMockQuestions(pool, config, { generated, exclude, profile })` from `lib/mock-exam-mix.ts` with the first exam's `groupId`s and `generatedQuestionId`s in `exclude` and the student's `getLearningProfile(userId, courseId)`, so the version keeps the US-47 mix. A version can be shorter than the first exam when `exclude` leaves too few questions, and is refused (`not_enough_questions`, `available: 0`) only when nothing is left. A column that links a version to its original is hers to add. For a timed original, pass `timeLimit: String(timeLimitMinutes)` to `createMockExam`, or set `timeLimitMinutes` on the version: it then opens on its own Start page with its own clock (never copy `startedAt` or `deadlineAt`).
- **US-47 and US-48:** built, see the next two sections.
- **US-49, marking (Mohammed):** call `finalizeExpiredMockExams({ courseId })` (or `{ userId }`, `{ mockExamId }`) before looking for `SUBMITTED` exams, so a timed exam whose student never came back is marked too. `timedOut` tells an exam that ran out of time from one the student submitted; its `submittedAt` is the deadline, and no answer can have been saved after it. the saved answers are `MockExamQuestion.answer`. For learning events, a past-paper item has `questionId`: one source question of its group, chosen by `sourceQuestionOf` (the question in the first of the group's papers in the question bank's order of newest year, then title, then ID; then the lowest number), the same paper order `recordLearningEvents` uses for the topic. Record it with `recordLearningEvents(userId, courseId, [{ source: "MOCK_EXAM", eventId, questionId, correct }])`. A generated item has `generatedQuestionId`; record it with `recordMockOutcomes`. Both IDs become null if their source is deleted, and an event for a source that is no longer published is refused, so marking must cope with an item that records no event. Past papers have no answer keys; what an answer is marked against is US-49's decision.

- **Shared files changed:** `prisma/schema.prisma` (the conflict, three columns, two back-relation lines on `Question` and `GeneratedPracticeQuestion`), the migration `20261116000001_mock_exam_sources`, `lib/logger.ts` (nine events), `.env.example` (one variable), and `README.md`.


### Course advice feed (US-38, Mohammed Al-Haiqi, Sprint 4)

The feed is the advice page at `/courses/:courseId/advice` with no search or filter (US-34/US-39 built the page; this story makes the feed reliable). Tester's check: the feed displays only relevant visible advice with the correct course and scope.

- **Only this course's visible advice.** Every student-facing advice query starts from `visibleCourseAdvice(courseId)` in `lib/advice.ts`: this course, `VISIBLE`, and not pointing at another course's exam paper or question. Publishing already refuses such a target, so this guards against bad data; such advice is left out, not shown in the wrong course. Newest first, ties broken by ID, 20 a page; an invalid page gives page 1 and a page past the end the last page.
- **Caching.** The unfiltered feed page is cached in memory for `ADVICE_FEED_CACHE_SECONDS` (default 30; 0 turns it off), at most 500 courses and 50 pages each. The rows are cached and `isMine` is worked out per viewer, so the cache holds nothing viewer-specific that reaches the page. Searches and filters are not cached. **Every code path that writes advice must call `invalidateCourseAdvice(courseId)`** (publishing does). The cache sits on `globalThis` because Next.js bundles server actions apart from the pages; a module-level map would give the publish action its own copy and its invalidation would never reach the page.
- **DoS:** at most `ADVICE_FEED_RATE_LIMIT_PER_MINUTE` advice page reads per logged-in student per minute (default 120). Over it the page says "You are opening advice pages too quickly. Wait a minute and try again." and reads nothing. Visitors are served from the cache.
- **Logs and responsiveness:** `operation_timed` lines `advice_feed` (database read) and `advice_feed_cached`, `slow_operation` over 1 s, and `advice_feed_rate_limited` in the events table.
- **Stored-request cleanup:** not applicable; the feed stores nothing per request.
- **Tests:** `tests/unit/advice-feed.test.ts`, `tests/unit/advice-feed-page.test.tsx`, `tests/integration/advice-feed.test.ts`, `tests/e2e/advice-feed.spec.ts`, the feed in `npm run availability` (with a correctness check), and `npm run load -- advice-feed`. Details and results: `ADVICE_FEED_REPORT.md`.
- **Shared files changed:** `lib/advice.ts` (the guard, the cache, the limit; `searchAdvice` keeps its signature), `app/courses/[courseId]/advice/page.tsx` (the limit check), `tests/unit/advice.test.ts` (one line: reset the cache between tests), `lib/logger.ts` (one event), `tests/availability/run.ts`, `.env.example`, and `README.md`.


### Editing and deleting one's own advice (US-36, Mohammed Al-Haiqi, Sprint 4)

After pulling, run `npx prisma generate` and `npx prisma migrate deploy`. One migration is new: `20261116000002_advice_edited` (one nullable column, `Advice.editedAt`).

- **Only the author.** Each of the author's posts on `/courses/:courseId/advice` has "Edit or delete your advice" (from `PublicAdvice.isMine`), which opens `/courses/:courseId/advice/:adviceId/edit`. Every read and write in `lib/advice-changes.ts` matches the advice by its ID, the session user as author, and `VISIBLE` together, so another student's advice, an admin's attempt, advice of another course, and advice that does not exist are all the same "not found" (nobody learns who wrote an anonymous post by trying).
- **Editing** changes the title, the text, and the link with its name, under the same rules as publishing (`checkAdviceDraft`). It never changes the scope or the anonymity; anonymous advice stays anonymous. Saving unchanged advice writes nothing. Edited advice shows "edited" in the feed.
- **Deleting** marks the advice `REMOVED` by its author (`removedById`). No student sees it again, in the feed or a search, and it cannot be edited back. It is kept so a report about it (US-43) can still be checked.
- **Races:** the write matches the author and `VISIBLE` again, so an edit never brings back advice that was deleted or removed in between.
- **Caching:** every change calls `invalidateCourseAdvice`, so the feed shows it at once.
- **DoS:** `ADVICE_CHANGE_RATE_LIMIT_PER_MINUTE` edits and deletes per student per minute (default 20).
- **Logs and responsiveness:** `operation_timed` lines `advice_own_read`, `advice_edit`, `advice_delete`, and the `advice_edited`, `advice_deleted`, `advice_change_*` events. The text, title, and link are never logged.
- **Tests:** `tests/unit/advice-changes.test.ts`, `tests/unit/advice-edit-page.test.tsx`, `tests/integration/advice-changes.test.ts`, `tests/e2e/advice-changes.spec.ts`, the two edit APIs in `npm run availability`, and `npm run load -- advice-edit`. Details: `ADVICE_CHANGES_REPORT.md`.
- **Shared files changed:** `prisma/schema.prisma` (one column), the migration, `lib/advice.ts` (`editedAt` in the select, `PublicAdvice.edited`), `components/advice-list.tsx` (the edit link and "edited"), `app/courses/[courseId]/advice/page.tsx` (the notices), `lib/logger.ts` (five events), the advice unit test fixtures (`editedAt: null`), `tests/availability/run.ts`, `.env.example`, and `README.md`.

### Reporting inappropriate advice (US-43, Mohammed Al-Haiqi, Sprint 4)

After pulling, run `npx prisma generate` and `npx prisma migrate deploy`. One migration is new: `20261116000003_advice_reports` (the `AdviceReport` table and its two enums; nothing else changed).

- **Reporting.** A logged-in student sees "Report this advice" on other students' posts in the feed. It opens `/courses/:courseId/advice/:adviceId/report`, which shows the post as students see it (an anonymous author stays anonymous) and asks what is wrong: offensive, spam or off-topic, personal information, academic dishonesty, or something else, with optional details (at most 500 characters). Only admins see reports; the author is never told who reported.
- **Refused, saving nothing, with a message:** no reason or an unknown one, details that are too long, advice that is no longer shown (deleted by its author, removed by an admin, or unknown), the student's own advice (they can edit or delete it instead, US-36), and a second report while their first is still open. Two clicks at the same time wait for each other (`pg_advisory_xact_lock` per student and advice), so only one report is opened. The course is taken from the stored advice, never from the form.
- **Feed:** advice the student already reported says "You reported this advice. An admin will check it." instead of the link (one indexed query per page, `getOpenReportedAdviceIds`).
- **DoS:** `ADVICE_REPORT_RATE_LIMIT_PER_MINUTE` reports per student per minute (default 10).
- **Logs and responsiveness:** `operation_timed` lines `advice_report`, `advice_reportable_read`, `advice_reported_read`, and the `advice_report_*` events. The note and the advice text are never logged.
- **Tests:** `tests/unit/advice-reports.test.ts`, the report cases in `tests/unit/advice-feed-page.test.tsx`, `tests/integration/advice-reports.test.ts` (including a double-click race), `tests/e2e/advice-reports.spec.ts`, the report API in `npm run availability`, and `npm run load -- advice-report`. Details: `ADVICE_REPORTS_REPORT.md`.
- **Shared files changed:** `prisma/schema.prisma` (the model, two enums, back-relations on `User`, `Course`, and `Advice`), the migration, `lib/advice.ts` (`adviceSelect` exported), `components/advice-list.tsx` (the report link), `app/courses/[courseId]/advice/page.tsx` (the notices), `lib/logger.ts` (four events), `tests/availability/run.ts`, `.env.example`, and `README.md`.

### Moderating reported advice (US-77, Mohammed Al-Haiqi, Sprint 4)

Admins open `/admin/advice-reports` (linked from the catalog as "Advice reports"; no migration, it uses US-43's `AdviceReport`). Each advice with open reports is shown once, the one reported longest ago first, 20 a page: the advice as students see it, how many students reported it, the reasons, and their details. The admin decides:

- **Remove advice:** the advice becomes `REMOVED` (`removedById` = the admin) and leaves every student-facing list at once (the feed's cache is cleared); all its open reports become `RESOLVED`.
- **Keep advice:** the advice stays; all its open reports become `DISMISSED`. Students can report it again later.
- Advice its author deleted after it was reported is marked so, with only **Close reports**.

Rules:

- **Admins only.** The page and the action call `requireAdmin()`: a student gets the not-found page, also when sending the admin's form with its real action ID (tested end to end), and a visitor is sent to log in.
- **Minimum information.** The queue shows the advice as students see it, so an anonymous author stays anonymous here too, and never shows who reported it. The author and reporter are kept in the database for abuse handling outside this page.
- **One decision.** A decision only closes open reports, so when two admins decide at once (or one decides from a page opened before another's decision), the second changes nothing and is told the advice has no open reports any more. An admin cannot remove advice nobody reported from this page.
- **DoS protection.** At most `ADVICE_MODERATION_RATE_LIMIT_PER_MINUTE` decisions (default 60) per admin per minute.
- **Logs.** `advice_removed_by_admin` and `advice_reports_dismissed` (info, with how many reports were closed), `advice_moderation_refused`, `advice_moderation_rate_limited` (warn), `advice_moderation_failed` and `advice_report_queue_failed` (error), with IDs only, never the advice text or a note. Timed as `advice_report_queue` and `advice_moderation`.

The service is `lib/advice-moderation.ts`, the action `lib/advice-moderation-actions.ts`, and the page `app/admin/advice-reports/page.tsx`. Tests: `tests/unit/advice-moderation.test.ts`, `tests/unit/advice-moderation-page.test.tsx`, `tests/integration/advice-moderation.test.ts`, and `tests/e2e/advice-moderation.spec.ts`; the load test is `npm run load -- advice-moderation`. Details and results: `ADVICE_MODERATION_REPORT.md`.

### Marking mock exams and explaining mistakes (US-49, Mohammed Al-Haiqi, Sprint 4)

After pulling, run `npx prisma generate` and `npx prisma migrate deploy`. One migration is new: `20261116000004_mock_marking` (the `AnswerKey` table, the `MarkOutcome` enum, `MockExam.markedAt`, and five additive columns on `MockExamQuestion`).

**Acceptance (sprint plan):** marking and explanations are based on evidence; a missing rubric is flagged, not guessed.

- **What answers are marked against.** Past papers come with no answer keys, and nothing is marked against a guess. An admin writes the answer key of a question-bank group at `/admin/answer-keys/:courseId` (linked as "Answer keys" from `/admin/questions`). A key is the key points a full answer covers, one per line (at most 10, 200 characters each), plus an optional explanation for students.
- **How an answer is marked** (`markAnswer` in `lib/mock-marking-rules.ts`, pure). A key point is covered when every important word of it is in the answer, in any order. Case, accents, punctuation, stopwords and simple word endings are ignored ("routes", "routing" and "route" match), and a word inside another word does not count ("acknowledgement" is not "ACK"). The outcomes:
  - `CORRECT`: every point is covered.
  - `PARTIAL`: some points are covered.
  - `INCORRECT`: no point is covered.
  - `UNANSWERED`: the answer is empty.
  - `NO_KEY`: the question has no key. It is shown as "Not marked: no answer key" and records no learning event. Every generated practice question (US-44) is `NO_KEY`, because it has no key.
  - The explanation lists the missed points, then the admin's explanation. It is a transparent check of the key points, not a judgement of the whole answer, and the exam page says so.
- **When.** Submitting marks the exam at once (`saveMockExamAction` calls `markMockExam` after `saveMockExam` succeeds). An exam that is submitted but not marked (submitted before this story, or the marking failed) is marked the next time its page opens. An exam is marked once: the write claims it (`SUBMITTED` and `markedAt` null), so two tabs or a retry mark it only once (mutation-checked). The marking is copied onto `MockExamQuestion` (`outcome`, `matchedPoints`, `missedPoints`, `feedback`), like the question text, so a later change to a key never changes a marked exam.
- **Learning events (US-25's contract).** Each marked past-paper question records `recordLearningEvents(userId, courseId, [{ source: "MOCK_EXAM", eventId: "mock:<examId>:<position>", questionId, correct }])`, where `correct` means `CORRECT`. Partly correct, incorrect and unanswered all count as incorrect, and `NO_KEY` records nothing. The batch is all or nothing, so after a refusal (a source paper no longer published) the events are sent one by one and the refused ones are skipped and counted. If delivery fails, the marks are kept and `mock_exam_marking_evidence_failed` is logged.
- **Only the owner.** Marking reads the exam by its ID and the session user. Another student's exam is not found, and the marks are shown only on the owner's exam page. Answer keys are admins only (`requireAdmin`), and only for a group of the course in the URL.
- **DoS:** `ANSWER_KEY_RATE_LIMIT_PER_MINUTE` key saves per admin per minute (default 60). Students cannot trigger marking more often than they submit (US-45's limit), and a marked exam is never marked again.
- **Logs and responsiveness:** `operation_timed` lines `mock_exam_marking` and `answer_key_save`, and the events in the events table. Answers, key points and explanations are never logged.
- **Tests:** `tests/unit/mock-marking-rules.test.ts`, `tests/unit/mock-marking.test.ts`, `tests/unit/mock-marking-pages.test.tsx`, `tests/integration/mock-marking.test.ts`, `tests/e2e/mock-marking.spec.ts`, the marked exam page in `npm run availability`, and `npm run load -- mock-marking`. Details: `MOCK_MARKING_REPORT.md`.
- **Shared files changed:** `prisma/schema.prisma` (the model, the enum, the columns, back-relations on `QuestionGroup`, `Course`, `User`), the migration, `lib/mock-exams.ts` (the marking fields in `getMockExam`'s select), `app/courses/[courseId]/mock-exams/actions.ts` (marks after a submit), the exam page (lazy marking and one line saying whether it was marked), `components/mock-exam-sitting.tsx` and its CSS (the marking under each answer), `tests/unit/mock-exam-pages.test.tsx` (one mock line), `app/admin/questions/page.tsx` (the "Answer keys" link), `lib/logger.ts` (eight events), `tests/availability/run.ts`, `.env.example`, and `README.md`.

### Mock exam results report (US-50, Mohammed Al-Haiqi, Sprint 4)

No migration: the report is built from US-49's stored marking.

**Acceptance (sprint plan):** after grading, the score and the topic breakdown reflect the actual answers and the missed items.

- **Where.** `/courses/:courseId/mock-exams/:mockExamId/results`, linked as "See your results" from a marked exam and as "Results" in the exams list. Only the exam's student (by exam ID and session user; anyone else gets not found). An exam in progress says "Submit the exam to see your results." A submitted exam that is not marked yet is marked first.
- **Score.** "X of Y marked questions fully correct", plus the share of key points covered, averaged over the marked questions, so a partly correct answer counts in part. **Questions without an answer key never count**: they are listed apart ("not marked, because it has no answer key"), and when nothing could be marked there is no score.
- **By topic.** One row per topic, weakest first (lowest share of key points covered), topics that could not be marked last. Each row has the questions, correct, partly, incorrect, not answered, not marked, and key points covered.
- **What you missed.** Every partly correct, incorrect and unanswered question in exam order, with its missed key points and explanation, then the unmarked ones.
- **Pure.** `buildResultsReport` in `lib/mock-results-rules.ts` builds the whole report from the stored outcomes and key points only; `lib/mock-results.ts` reads the exam.
- **DoS:** `MOCK_RESULTS_RATE_LIMIT_PER_MINUTE` results pages per student per minute (default 60). Over it the page says so and reads nothing.
- **Logs and responsiveness:** `operation_timed` `mock_results`, and the two events in the events table.
- **Tests:** `tests/unit/mock-results-rules.test.ts`, `tests/unit/mock-results-page.test.tsx`, `tests/integration/mock-results.test.ts`, `tests/e2e/mock-results.spec.ts`, the results page in `npm run availability` (correct only when the score and the counts match the marked exam), and `npm run load -- mock-results`. Details: `MOCK_RESULTS_REPORT.md`.
- **Shared files changed:** `lib/mock-exams.ts` (`markedAt` in the exams list), `app/courses/[courseId]/mock-exams/page.tsx` (the "Results" link), the exam page (the "See your results" link), `lib/logger.ts` (two events), `tests/availability/run.ts`, `.env.example`, and `README.md`.

### Advice from previous students (US-34, US-35, US-37, US-39): open issues

Built by Ali Shammakh at `/courses/:courseId/advice` (`lib/advice.ts`, `lib/advice-rules.ts`), now owned by Mustafa Ergaibi. A review against the stories found no acceptance failure in the code: scopes are checked against the course, only `https://` links are accepted, an anonymous post never carries its author's name or ID to students, and search and filters stay inside the course. These issues are open and **not fixed yet**:

1. No documentation beyond this list: no events-table rows for the six `advice_*` events, and `ADVICE_RATE_LIMIT_PER_HOUR` (default 20) is not in `.env.example`.
2. No e2e spec and no page tests; only unit and integration tests of the service.
3. The publish form does not use the shared form styles, and its messages are not notices; 375 px and dark mode are unverified.
4. The `advice_*` events sit at the top of `lib/logger.ts`, outside any member's comment.
5. `advice_published` logs the author's `userId` with the `adviceId` for anonymous posts too. Only admins read logs and US-37 keeps the author for moderation, but it needs a decision.
6. The exam filter finds advice scoped to that exam only, not advice on one of its questions.
7. The publish form offers only the 100 most frequent questions of a course.
8. Nothing removes or edits advice yet (the `REMOVED` status has no caller); that belongs to other stories. *(Authors edit and delete since US-36, and admins remove reported advice since US-77, above.)*

### Known limitations

- **Confidence and recorded practice both update weakness.** Without either, the personal order retains frequency order and identifies the missing profile. Full mock/E5 integration still requires those producers; see the Sprint 4 contract.
- **A report sent from the personal order returns to the frequency order**, because the report action (US-23) does not keep `order=personal`. Questions keep their numbers, so its notice and `#question-N` still point at the right question.

Monitoring: see the events table (`question_progress_*`, `learning_profile_*`, `priority_calculation_failed`, `topic_confidence_*`). Topics are never logged.

Tests: `tests/unit/learning-profile.test.ts`, `tests/unit/question-progress.test.ts`, `tests/unit/personal-order.test.ts`, `tests/unit/study-progress-pages.test.tsx`, `tests/unit/personal-order-pages.test.tsx`, `tests/integration/learning-profile.test.ts`, `tests/integration/question-progress.test.ts`, `tests/integration/personal-order.test.ts`, `tests/e2e/study-progress.spec.ts`, and `tests/e2e/personal-order.spec.ts`. They create their own courses and students and delete them. Shared files changed: `prisma/schema.prisma`, `lib/logger.ts`, `components/consolidated-exam.tsx`, `app/courses/[courseId]/exam/page.tsx`, `tests/unit/question-report-pages.test.tsx` (one mock line), `README.md`, and `.env.example`; the exact lines are in `MEMBER_3_SPRINT_3_IMPLEMENTATION_REPORT.md`.

## Submissions (US-13)

A logged-in student can submit a past exam or course material at `/submit` (linked from My Courses). It waits for an admin's review and only its submitter and admins can see it until it is published. `/my-submissions` lists the student's submissions with their status and, if rejected, the reason.

- **Model** (migration `20261017000000_file_submissions`). `CourseFile` gained:
  - `status` (`FileStatus`: `PENDING`, `PUBLISHED`, `REJECTED`). It defaults to `PUBLISHED`, so every older file, every admin upload, and both seeds are unchanged.
  - `submittedById` (the student; null for admin uploads; set to null if the account is deleted).
  - `rejectionReason` (set only when the status is `REJECTED`).
  - `reviewedAt`.

  A submission starts as `PENDING`. An admin publishes it or rejects it with a reason. Both outcomes are final.
- **Visibility.** `PUBLISHED_FILES` and `canViewFile` (`lib/file-visibility.ts`, re-exported from `lib/submissions.ts`) are the one rule. The course exam and material lists, the question bank (grouping, paper counts, filter options, admin overview), and the consolidated exam (`X of Y`) read published files only, for everyone. `/files/:id` opens an unpublished file for its submitter and admins only, with `Cache-Control: private, no-store`. Anyone else gets the usual "File unavailable" 404, without a course link, so the file's existence isn't revealed. `/admin/files` lists every status and tags pending and rejected files.
- **File rules.** PDF only. Then the admin upload's checks: not empty, at most 20 MB, real `%PDF-` content, and safe storage as `exams/<uuid>.pdf` or `materials/<uuid>.pdf`. The metadata fields and rules are the shared ones (`lib/file-metadata.ts`): course, optional professor teaching it, year, term, type (exams only), and topic. A refusal returns to the form with the reason, keeping the course and category.
- **Review functions** (`lib/submissions.ts`, for the admin review page, US-74):
  - `listPendingSubmissions()`: oldest first, with course, professor, term, and submitter `{ id, name }`.
  - `publishSubmission(fileId)`: for an exam, also runs `rebuildQuestionBank`.
  - `rejectSubmission(fileId, reason)`: the reason is required, trimmed, and at most 500 characters.

  Both review functions return `{ ok: true, id, courseId }` or `{ ok: false, error: "not_found" | "not_pending" | "reason_required" | "reason_too_long" }`. Each one is a single conditional update, so two admins can never both review one file. They don't check the caller, so call `requireAdmin()` first.

> **For everyone reading `CourseFile` or `Question`:** any student-facing query, and anything that processes files, must add `...PUBLISHED_FILES` to its `CourseFile` filter.
> - **Mohammed (US-74, admin review):** build on the three review functions above.
> - **Ali Slim (US-14, extraction):** extract published exams only. Publishing already regroups.
> - **Lea (US-17 to US-19):** `getConsolidatedExam` already has the filter; any new paper query needs it too.

Refused and failed submissions are logged as `submission_refused` (with the reason) and `submission_failed`. Admin rejections are logged as `submission_rejected`. Attempts to open a hidden file are logged as `unpublished_file_access`. These log IDs and reasons only, never titles, file names, topics, or the rejection reason.

Tests are in `tests/unit/submissions.test.ts`, `tests/unit/submission-route.test.ts`, `tests/unit/submission-pages.test.tsx`, and `tests/e2e/student-submissions.spec.ts`. The e2e spec creates its own two students and one course and deletes them, the submitted files, and their stored copies at the end. Shared files changed:
- `prisma/schema.prisma`
- `lib/uploads.ts` (optional `submission` argument to `saveUpload`)
- `lib/courses.ts`, `lib/files.ts`, `app/files/[fileId]/route.ts`, `lib/question-bank.ts`, `lib/consolidated-exam.ts` (the published filter)
- `lib/logger.ts`
- `middleware.ts`
- `app/my-courses/page.tsx` (links)
- `app/admin/files/page.tsx` (status tag)
- `app/globals.css` (`.status-tag`)
- `tests/reliability/features/browsing.ts`
- their unit tests

## Submission review (US-74)

Admins review student submissions (US-13) at `/admin/submissions`, linked as "Review" in the header and from the catalog page.

- **Queue.** Every `PENDING` submission, oldest first (ties broken by ID), 20 per page, with its course, type, details, submitter, and links to open the file and edit its details. An invalid or out-of-range `page` falls back to the first or last page.
- **Publish** makes the file `PUBLISHED`: it appears on its course page, and for an exam `rebuildQuestionBank` groups and ranks its questions with the course's others, so it enters the question pipeline.
- **Reject** needs a reason (1 to 500 characters, trimmed). The student sees it on `/my-submissions`, as plain text. The reason is never logged or put in a URL.
- **Races.** Both are a single conditional update in `lib/submissions.ts`, so a second admin acting on the same file gets "That submission was already reviewed." and the first decision stays.
- **Rate limit.** At most `REVIEW_RATE_LIMIT_PER_MINUTE` reviews (default 60) per admin per minute; more get "Too many reviews in a minute." without touching the database. The count is kept in memory per server process (`lib/rate-limit.ts`).
- **Response times.** The queue (`review_queue`), publish (`submission_publish`), and reject (`submission_reject`) each print one `operation_timed` JSON line with `durationMs` to the server log (`lib/timing.ts`). One slower than 1 s is also logged as `slow_operation` and shows on `/admin/monitoring`.
- **Audit.** Each review is logged as `submission_reviewed` with the file, course, operation, and the admin's ID in `userId`.

The page is `app/admin/submissions/page.tsx`, the actions (`requireAdmin()` first) are `lib/submission-review-actions.ts`, and the queue pages, rate limit, timing, and audit event are `lib/submission-review.ts`, on top of the review functions in `lib/submissions.ts`. Tests are in `tests/unit/submission-review.test.ts`, `tests/unit/submission-review-pages.test.tsx`, `tests/integration/submission-review.test.ts`, and `tests/e2e/admin-submission-review.spec.ts`; the load test is `npm run load -- review-queue`. Details and results: `SUBMISSION_REVIEW_REPORT.md`. Shared files changed:
- `lib/submissions.ts` (optional page range for `listPendingSubmissions`, and `countPendingSubmissions`)
- `lib/logger.ts`
- `app/layout.tsx` (Review link)
- `app/admin/catalog/page.tsx` (Submissions card)
- `app/globals.css` (`.field textarea`)
- `vitest.config.ts`, `package.json`, `.github/workflows/ci.yml`

## Question corrections (Sprint 3)

Admins fix wrongly extracted or wrongly grouped questions so the frequency ranking stays accurate. From `/admin/questions`, "Correct questions" opens a course's groups at `/admin/questions/:courseId`, and "Correct" on a question opens its page.

- **Edit text.** Replaces the question's extracted text (1 to 2,000 characters, trimmed, line breaks kept; text made only of invisible characters is refused). Students see the new text in the question bank and the ordered exam. If another admin changed the text since the form was opened, the edit is refused with "Someone else changed this question's text" instead of overwriting it.
- **Move to group.** Puts the question in another group of the course, whatever its text says. Counts and ranks are recalculated right away.
- **Split into its own group.** Takes the question out of its group into a group of its own that its copies do not join.
- **Group by text again.** Undoes a move or a split.
- **Surviving the pipeline.** A move is stored as a pin to a question in the target group (`Question.pinnedToQuestionId`), a split as `Question.splitOut`. `rebuildQuestionBank` applies them after the automatic grouping on every rebuild (`groupCorrectedQuestions` in `lib/question-grouping.ts`), so they survive "Regroup and rank", reprocessing a paper, and new papers. A corrected text is never replaced, because a paper that already has questions is not extracted again. If the pinned-to question is deleted (or its paper moves course), the moved question is grouped by its own text again. Moving a question never takes the questions moved onto it along.
- **Activity log.** Each correction is saved in `QuestionCorrection` with the admin, the paper and question number, and the before and after text or group, and is shown on the course page (latest 50) and the question page. It is kept when the question, paper, or admin is deleted; deleting the course deletes it.
- **Limits and timing.** At most `CORRECTION_RATE_LIMIT_PER_MINUTE` corrections (default 60) per admin per minute. Each correction takes the course's regroup lock, so it never interleaves with a rebuild. The page and each correction print `operation_timed` lines (`question_corrections_page`, `question_correction_edit|move|split|reset`).

The service is `lib/question-corrections.ts` with messages in `lib/question-correction-rules.ts`, the actions (`requireAdmin()` first) are `lib/question-correction-actions.ts`, and the pages are under `app/admin/questions/[courseId]/`. Tests: `tests/unit/question-corrections-grouping.test.ts`, `tests/unit/question-corrections.test.ts`, `tests/unit/question-correction-pages.test.tsx`, `tests/integration/question-corrections.test.ts`, and `tests/e2e/admin-question-corrections.spec.ts`; the load test is `npm run load -- question-corrections`. Details and results: `QUESTION_CORRECTIONS_REPORT.md`.

## Exam pipeline integration tests (US-92)

`tests/integration/exam-pipeline.test.ts` runs the exam pipeline end to end against a real database: five sample exam PDFs (built in `tests/integration/fixtures/sample-exams.ts`) are uploaded through `POST /api/admin/uploads`, their questions extracted, grouped and ranked by `rebuildQuestionBank`, and the result checked against the expected consolidated ordered exam (`getConsolidatedExam`), question by question, with counts, tiers, and papers. Other tests cover upload order, concurrent uploads, pending and rejected submissions, materials, deleted and re-tagged papers, non-admin uploads, and a 20-paper course within 1 s per stage. They run in CI with `npm run test:integration`.

Exam uploads and published exam submissions now run PDF text extraction, store numbered questions, and rebuild the course's question bank. Each attempt is saved as a processing run. Admins can see its stage and reason, then retry failures at `/admin/processing`. Image-only PDFs fail with "No extractable text"; unreadable PDFs fail separately. Existing questions on older files are kept and regrouped. Load tests: `npm run load -- ordered-exam` and `npm run load -- exam-upload`. `PIPELINE_INTEGRATION_REPORT.md` records the earlier test results, before extraction was connected.

### Sprint 3 extraction and failed-processing checks (Ali Slim)

Typed PDFs support numbered, parenthesized, Q-number and Question-number labels, including compact labels (`2)Explain`) and colon labels (`1: Explain`). Decimals and times in continuation lines stay inside their question. Page numbers, scanner watermarks, section headings and numbered instructions are handled by the existing cross-test fixes. Image-only scans need a typed/searchable replacement; OCR is not implemented.

`/admin/processing` shows each file's latest result. A retry creates a new run and preserves the failed attempt. Simultaneous retries are serialized per file, and a retry of failed grouping reuses existing question rows. A run still marked running after 15 minutes can be retried. Database failures while reading a retry now return a controlled error; failures to save a failed-run record are logged separately.

A retry applies to the attempt displayed on the page. If another tab or admin already retried it, the old form is refused even if that newer attempt has also failed. Reload the page before deliberately retrying the latest attempt. Compact question labels must include punctuation, so a variable such as `Q2value` remains question content.

Processing events appear in `/admin/monitoring` through the shared logger:

| Event | Level | Meaning |
| --- | --- | --- |
| `exam_processing_started` | info | File/course/run IDs and whether this is a retry |
| `exam_processing_completed` | info | Those IDs, retry flag, question count and elapsed milliseconds |
| `exam_processing_failed` | error | Failed stage, safe reason, error type, retry flag and elapsed time when a run started |
| `exam_processing_record_failed` | error | The failed-run status could not be saved |
| `exam_processing_retrieval_failed` | error | Loading the processing list failed |
| `exam_retry_refused` | warn | No failed/stale run, or the file is no longer eligible |

Question text, titles, original file names and error messages are never included in these events. `tests/e2e/exam-processing-reliability.spec.ts` runs 50 seeded extraction trials and 50 admin-page retry trials against a production build, checking both database results and persisted monitoring events. It cleans up its course and upload copies. Ali Slim's US-15b/US-23 database cross-tests are in `tests/integration/cross-test-us15b-us23.test.ts`; run them with `npm run test:integration`. Results and limitations are in `MEMBER_5_SPRINT_3_IMPLEMENTATION_REPORT.md` and `CROSS_TEST_ALI_SLIM_US15B_US23.md`.

## Accuracy evaluation set (US-93)

A hand-checked set of exam questions with their correct ("gold") groups measures how well grouping (US-15a) and ranking (US-16) work, and catches regressions when the grouping logic changes, or later its model or prompt (US-15b).

- **The set** is versioned with the code: `eval/grouping/synthetic/dataset.json`, 16 made-up papers in two courses (78 questions, 32 gold groups) written to look like extracted papers. Each question is `[gold group, text as extracted]`; `notes` explains the gold decisions a reviewer could read either way. Change the papers or gold groups only together with a higher `version`, which makes the old baseline unusable on purpose.
- **Real papers stay local.** Sets built from real past papers go in `eval/grouping/local/` (gitignored, because the repository is public), for example the hand-transcribed MATH 201 Quiz 1 set, and run with `npm run eval:grouping -- eval/grouping/local/math201-quiz1`.
- **Metrics** (`lib/grouping-eval.ts`): pair precision, recall, and F1 (over every pair of questions in a course: grouped together vs really the same question), gold groups reproduced exactly, questions shown with the right paper count, Kendall tau-b rank correlation with the gold ranking, and top-5 precision.
- **Regression check.** Each set folder has a `baseline.json` (set name and version, grouper, metrics, date). A run fails when a metric drops more than 0.02 below it or falls under its floor (pair precision 0.95, pair F1 0.6, rank correlation 0.6), or when the baseline belongs to another version of the set. `--update-baseline` records a new one after the result is reviewed.
- **A new grouper** (a model or prompt for US-15b) implements the `Grouper` type and is evaluated the same way; its name and version are stored in the baseline.

Tests: `tests/unit/grouping-eval.test.ts`. Report: `ACCURACY_AND_AVAILABILITY_REPORT.md`.

## Availability and reliability

`npm run availability` measures every API's availability and reliability as the number of concurrent users grows (1, 10, 25, 50, 100 by default). Logged-in students repeat a weighted mix of 10 APIs: catalog search, course page, exam list, question bank, ordered exam, opening a file, My Courses, profile, logging in, and adding a course.

- **Availability** = successful requests / total requests, per API. A request fails when it times out (10 s), the connection fails, the server answers 5xx, or it answers a status that API never gives for that request.
- **Reliability** is stricter: the reply must also be correct (the page shows the course, the file is a PDF, the login redirects to My Courses) and within the latency target (1 s).
- **Per API and stage:** requests, successes, failures, availability, error rate, reliability, p50/p95/p99/max latency, throughput, timeouts, and error types. **Per stage:** machine CPU, the server's memory, database connections, and the most requests in flight. **After the run:** the time to recover to normal replies. It also gives the yearly downtime each availability means, the "nines", and a 95% lower bound (with no failure in N requests, a run can only show about 1 - 3/N).
- **Capacity** is the most users at which every API met the availability target (`AVAILABILITY_TARGET`, default 99.9%) and the overall p99 stayed within 1 s. The report also lists, per API, the failures that only appeared at higher load.

More users do not change availability by themselves. They produce more requests (so a high availability becomes measurable), exercise more paths, and add concurrency and pressure on CPU, memory, and database connections, which exposes rare failures and bottlenecks. Availability stays stable or drops once the app reaches its capacity.

The tool is `tests/availability/run.ts` with the numbers in `tests/availability/metrics.ts` (tested in `tests/unit/availability-metrics.test.ts`). It creates stamped students and deletes them, their sessions, and their My Courses entries at the end.

## Profile (US-04)

A logged-in user edits their own profile at `/profile`, linked as "Profile" in the header. The email is shown but can't be changed here, since it is the login.

- **Fields** (migration `20261018000000_user_profile`):
  - `User.name`: required, at most 100 characters, with spaces trimmed and collapsed.
  - `User.facultyId`: optional, chosen from the `Faculty` list; set to null if the faculty is deleted.
  - `User.major`: optional, short free text, at most 100 characters.

  An empty faculty or major clears it. The limits and messages are in `lib/profile-rules.ts`, shared with the form.
- **Whose profile.** Always the session user's (`requireUser("/profile")`). The server action reads only `name`, `facultyId`, and `major`, so an ID added to the form is ignored. `/profile/:id` and `/profile/:id/edit` send your own ID to `/profile`. Anyone else's ID gets the not-found page, the same as other denied pages, without saying whether the account exists, and is logged as `unauthorized_access`. A visitor is sent to log in.
- **Errors** such as "Enter your name." appear above the form, and the form keeps what was typed. The typed values come back through the action's state (`useActionState`), not the URL, so a name never lands in a link or in browser history. Nothing is saved, so the stored profile keeps its old values.

Refused saves are logged as `profile_save_rejected` (with the reason), and failures as `profile_save_failed` and `profile_retrieval_failed`. Only the user ID, reason, and error type or code are logged, never a name, major, or email.

The service is `lib/profile.ts`, the action is `lib/profile-actions.ts`, the pages are `app/profile/page.tsx` and `app/profile/[...path]/page.tsx`, and the form is `components/profile-form.tsx`. Tests are in `tests/unit/profile.test.ts`, `tests/unit/profile-pages.test.tsx`, and `tests/e2e/profile.spec.ts`, which creates its own students and faculty and deletes them. Shared files changed:
- `prisma/schema.prisma`
- `lib/logger.ts`
- `middleware.ts` (`/profile`)
- `app/layout.tsx` (Profile link)
- `app/globals.css` (`.field-value`)
- `tests/unit/middleware.test.ts`

## Password reset (US-03)

"Forgot password?" on `/login` leads to `/forgot-password`. After any request, the page shows the same message: "If an account exists for that email, we've sent a link to reset your password. The link works once and expires in 30 minutes." The link opens `/reset-password?token=…`, which takes a new password under the sign-up rules (at least 8 characters, typed twice).

- **Links** (migration `20261019000000_password_reset`, table `PasswordResetToken`):
  - The token is 32 random bytes. Only its SHA-256 hash is stored, as for sessions.
  - A link expires after 30 minutes and works once.
  - A new request replaces every older unused link.
  - Links older than 24 hours are deleted the next time the same user asks for one.
- **A reset** checks the password first. A weak or mismatched password is refused without using up the link. The link is then claimed in one transaction with a conditional update, so two tabs can't both use it. The same transaction changes the password, logs out **all** of that user's sessions, and replaces the other links. Used, expired, replaced, and unknown links each get a clear message and a "Request a new link" button. The page sends no Referer (`referrer: no-referrer`), so the token doesn't leak to other sites.
- **Neutral answers.** Registered, unregistered, and malformed emails all redirect to the same `/forgot-password?sent=1`.
- **Rate limit.** At most 3 links per account per 15 minutes. Further requests show the same message and send nothing, so the limit doesn't reveal whether the email exists.
- **Mail** (`lib/mail.ts`):
  - **With a provider.** Set `MAIL_API_URL`, `MAIL_API_KEY`, and `MAIL_FROM` to send through an HTTP mail API. The module posts `{ from, to, subject, text }` as JSON with `Authorization: Bearer <key>`, which is Resend's format (`https://api.resend.com/emails`); a provider with a different format needs a change to `sendMail`.
  - **Link origin.** Set `APP_URL` to the site's public origin. Links are never built from the request's Host header.
  - **Development without a provider.** `npm run dev` prints the email, including the link, to the server terminal, in a block marked `DEV ONLY`. `APP_URL` defaults to `http://localhost:3000` there.
  - **Production or tests without a provider.** Nothing is printed and nothing is sent. The request is logged as `password_reset_email_failed` with the reason `not_configured` or `app_url_not_configured`.
  - The link and token are never logged anywhere, including the log database.
- **Monitoring.** See the events table. Only IDs, reasons, and error types are logged, never emails, tokens, links, or passwords. A link is identified by its row ID, `resetLinkId`, because the logger drops any key containing "token".
- **Known limitation.** The email is sent in the background, so a slow provider doesn't make a registered email answer later. A registered email still costs a few more database reads and writes than an unknown one, so the response times can differ slightly.

The service is `lib/password-reset.ts`, the actions are `lib/password-reset-actions.ts`, and the pages are `app/forgot-password/page.tsx` and `app/reset-password/page.tsx`. Tests are in `tests/unit/password-reset.test.ts`, `tests/unit/password-reset-pages.test.tsx`, `tests/unit/mail.test.ts`, and `tests/e2e/password-reset.spec.ts`. The e2e test creates its own student, makes links through `requestPasswordReset` with a capturing sender, and deletes the student, which also removes its links and sessions. Shared files changed:
- `prisma/schema.prisma`
- `lib/logger.ts`
- `app/login/page.tsx` (link and notice)
- `.env.example`

## Authentication and My Courses (Member 1)

`/signup`, `/login`, and `/my-courses` cover US-01 (create an account), US-02 (log in and log out), and US-07 (add a course to My Courses). Sessions are rows in the database, not JWTs, so logging out really revokes the session.

- **Sign-up** needs a name, a valid email, and a password of at least `PASSWORD_MIN_LENGTH` (8) characters. Emails are normalized with `trim().toLowerCase()`, so `Ali@…` and `ali@…` are one account. A second sign-up with the same email says the account already exists. Setting `SIGNUP_EMAIL_DOMAIN` (for example `@mail.aub.edu`) restricts sign-up to one domain. A new account is sent to `/login`, not logged in automatically.
- **Login** always answers "Invalid email or password," whether the email is unknown or the password is wrong, so nobody can test which emails are registered. Passwords are bcrypt hashes (cost 10).
- **Sessions** store only the SHA-256 hash of a 32-byte random token; the raw token lives in an `httpOnly`, `SameSite=Lax`, 7-day cookie, marked `Secure` in production. Logging out deletes the row and the cookie, and logout is a `POST` form so a prefetch or an image tag cannot end a session.
- **Access** is enforced in the data layer with `requireUser()`, `requireAdmin()`, and `getAdminUser()` from `lib/auth.ts`, called inside pages, server actions, and route handlers. `middleware.ts` only redirects a request without a session cookie to `/login?next=…`, because middleware-only authentication has been bypassed before (CVE-2025-29927). Browsing and course pages stay open to visitors; `/my-courses` and `/admin/*` need a session.
- **`next` redirects** accept relative paths only, so a crafted login link cannot send a student to another site.
- **My Courses** uses a composite primary key `@@id([userId, courseId])`, so a duplicate is impossible in the database; the second of two racing clicks fails with Prisma `P2002` and is reported as "Already in My Courses." Adding an unknown course ID returns 404.

Data functions live in `lib/auth.ts` and `lib/my-courses.ts`, server actions in `lib/auth-actions.ts` and `lib/my-courses-actions.ts`, and the shared cookie constants and `safeNext` in `lib/session-cookie.ts` so `middleware.ts` stays free of Node-only imports.

Failures are logged with `logError` as `signup_failed`, `login_failed`, `session_validation_failed`, `logout_failed`, `unauthorized_access`, `my_courses_add_failed`, and `my_courses_retrieval_failed`. Only IDs, roles, routes, reasons, and error types are logged, never an email, password, or session token.

Tests are in `tests/unit/auth.test.ts`, `tests/unit/auth-actions.test.ts`, `tests/unit/my-courses.test.ts`, `tests/unit/auth-pages.test.tsx`, `tests/unit/add-to-my-courses.test.tsx`, `tests/unit/middleware.test.ts`, and `tests/e2e/auth-my-courses.spec.ts`.

## Catalog management (Member 4)

`/admin/catalog` covers US-69 (manage the course catalog). Admins add and edit faculties, courses, professors, and terms, and assign professors to courses. Every change shows in the catalog at `/` and its filters straight away. Entries cannot be deleted yet. The header shows an "Admin" link to admins only.

- **Access.** Every page and server action calls `requireAdmin()` first. A student gets the not-found page, and a visitor is sent to `/login?next=…`.
- **Course and faculty codes** are stored without spaces and in capitals, so `eece 350` is saved as `EECE350` and refused if that code exists, matching Member 2's search. A code is 2 to 20 letters or digits. The duplicate check gives the message, and the unique index refuses a racing second save (`P2002`), which shows the same message.
- **Terms** (`Term`, added in `20261005000000_catalog_terms`) are a list of names such as Fall, Spring, and Summer, seeded by `npm run db:seed`. Names are unique ignoring case. Files link to a term (US-72).
- **Professors** have no uniqueness rule, since two professors can share a name. A course's professors are set together with the course in one transaction.

The service is `lib/catalog-admin.ts`, the server actions are `lib/catalog-admin-actions.ts`, and the pages are under `app/admin/catalog/`, with `components/catalog-notice.tsx` and `components/course-fields.tsx`.

Failures are logged with `logError` as `catalog_entry_rejected` (with the entity and reason: `invalid_fields`, `duplicate_code`, `duplicate_name`, `not_found`, `unknown_faculty`, or `unknown_professor`), `catalog_entry_save_failed` (entity, `create` or `update`, entry ID, error type), and `catalog_admin_retrieval_failed`. Codes and names typed by admins are never logged.

### File metadata (US-72)

`/admin/files` lists every file, filterable by course, and `/admin/files/:id` sets a file's course, professor, year, term, type, and topic. The catalog overview links to it.

- **Fields.** `CourseFile.session` (free text) is replaced by `termId` (a link to `Term`) and `examType` (`MIDTERM`, `FINAL`, `QUIZ`, `OTHER`), in migration `20261006000000_file_metadata`. The migration moved existing values into the term or type. Any text that was not exactly a term name or a type word is kept in the topic.
- **Rules**, the same for the edit page and the upload form (`lib/file-metadata-rules.ts`, `lib/file-metadata.ts`):
  - The course is required and must exist.
  - The professor is optional but must teach that course.
  - The term is optional but must exist.
  - The year is optional, 4 digits, from 1950 to next year.
  - The topic is at most 100 characters.
  - A type is allowed on exams only.
- **Retagging.** Changing the course moves the file to the new course's pages straight away. The professor list follows the chosen course.

Failures are logged as `file_metadata_rejected` (file ID and reason), `file_metadata_save_failed` (file ID and error type), and `file_metadata_retrieval_failed`. Titles and topics are never logged.

Tests are in `tests/unit/catalog-admin.test.ts`, `tests/unit/catalog-admin-actions.test.ts`, `tests/unit/catalog-admin-pages.test.tsx`, `tests/unit/file-metadata.test.ts`, `tests/unit/file-metadata-actions.test.ts`, `tests/unit/file-metadata-pages.test.tsx`, `tests/e2e/admin-catalog.spec.ts`, and `tests/e2e/admin-file-metadata.spec.ts`. Admin e2e tests log in through `tests/e2e/fixtures.ts`, which reads `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env`. Shared files changed: `prisma/schema.prisma` and `prisma/seed.ts` (terms), `lib/logger.ts` (the three events above), `app/layout.tsx` (the Admin link), and `app/globals.css` (`.field select`, `.checkbox-list`, `.catalog-list`, `.catalog-links`).

## Monitoring (US-87)

Every feature reports failures through one function, `logError(event, context)` in `lib/logger.ts`. Each call:

1. classifies the event,
2. cleans its context,
3. prints one JSON line to the server console, and
4. saves the line to the `LogEntry` table in the background.

Admins see the result at `/admin/monitoring`, and a burst of errors raises an alert.

### Levels

| Level | Meaning |
| --- | --- |
| `error` | Something failed that should not have: a database read or write, storage, a missing or unreadable file |
| `warn` | An expected refusal: a wrong password, a duplicate, a rejected upload, a student on an admin page |
| `info` | Notable but fine: the monitoring alert itself |

The levels live in one table, `EVENT_LEVELS` in `lib/logger.ts`, and TypeScript requires a level for every event. One rule sits next to it: a `warn` event logged with `reason: "db_error"` is raised to `error`, because the refusal was caused by the database failing.

### Events

| Member | Event | Level | Context |
| --- | --- | --- | --- |
| 1 | `signup_failed` | warn (error for `db_error`) | `reason`, `errorType` |
| 1 | `login_failed` | warn (error for `db_error`) | `reason`, `userId`, `errorType` |
| 1 | `session_validation_failed` | warn (error for `db_error`) | `reason`, `sessionId`, `userId`, `errorType` |
| 1 | `unauthorized_access` | warn | `route`, `role`, `userId` |
| 1 | `logout_failed`, `my_courses_add_failed`, `my_courses_retrieval_failed` | error | `userId`, `courseId`, `errorType` |
| 2 | `course_catalog_retrieval_failed`, `course_search_failed`, `catalog_filter_options_retrieval_failed` | error | filter IDs, `errorType` |
| 2 | `question_grouping_rejected` | warn | `courseId`, `reason` |
| 2 | `question_grouping_failed`, `question_bank_retrieval_failed`, `question_search_failed` | error | `courseId`, filter values (never the keyword), `errorType` |
| 3 | `course_retrieval_failed`, `exam_list_retrieval_failed`, `material_list_retrieval_failed` | error | `courseId`, `resourceCategory`, `errorType` |
| 3 | `file_record_not_found` | warn | `fileId` |
| 3 | `physical_file_not_found`, `invalid_storage_key` | error | `fileId` |
| 3 | `file_open_failed` | error | `fileId`, `errorType`, `errorCode` |
| 4 | `catalog_entry_rejected`, `file_metadata_rejected` | warn | `entity`, `reason`, `entryId` or `fileId` |
| 4 | `catalog_entry_save_failed`, `catalog_admin_retrieval_failed`, `file_metadata_save_failed`, `file_metadata_retrieval_failed` | error | entity, IDs, `operation`, `errorType` |
| 4 | `monitoring_alert_triggered` | info | `count`, `threshold`, `windowMinutes`, `events`, `webhook` |
| 5 | `upload_rejected` | warn | `reason`, `courseId`, `resourceCategory` |
| 5 | `upload_storage_failed`, `upload_record_failed`, `upload_cleanup_failed`, `upload_failed`, `upload_options_retrieval_failed` | error | `courseId`, `resourceCategory`, `errorType`, `errorCode`; `source=submission` for a student submission |
| 1 (Sprint 2) | `submission_refused` | warn | `reason`, `courseId`, `resourceCategory`, `userId` |
| 1 (Sprint 2) | `submission_failed`, `submission_retrieval_failed`, `submission_review_failed` | error | `courseId`, `resourceCategory`, `userId`, `fileId`, `entity`, `operation`, `errorType` |
| 1 (Sprint 2) | `submission_rejected` | info | `fileId` (never the reason) |
| 1 (Sprint 2) | `unpublished_file_access` | warn | `fileId`, `role`, `userId` |
| 1 (Sprint 2) | `profile_save_rejected` | warn | `userId`, `reason` |
| 1 (Sprint 2) | `profile_save_failed`, `profile_retrieval_failed` | error | `userId`, `entity`, `errorType`, `errorCode` |
| 1 (Sprint 2) | `password_reset_requested`, `password_reset_completed` | info | `outcome` (`sent` or `unknown_email`), `userId`, `resetLinkId`, `sessionsEnded` |
| 1 (Sprint 2) | `password_reset_rate_limited`, `password_reset_token_rejected`, `password_reset_rejected` | warn | `userId`, `reason` (`used`, `expired`, `superseded`, `unknown`, `weak_password`, `password_mismatch`), `resetLinkId` |
| 1 (Sprint 2) | `password_reset_failed`, `password_reset_email_failed` | error | `stage`, `userId`, `reason`, `errorType`, `errorCode` |
| US-74 | `submission_reviewed` | info | `fileId`, `courseId`, `operation`, `userId` (the admin) |
| US-74 | `submission_review_refused`, `submission_review_rate_limited` | warn | `fileId`, `operation`, `reason`, `userId`, `retryAfterSeconds` |
| Sprint 3 | `question_corrected` | info | `courseId`, `questionId`, `kind` (`edit`, `move`, `split`, `reset`), `userId` (the admin), `regrouped` |
| Sprint 3 | `question_correction_refused`, `question_correction_rate_limited` | warn | `courseId`, `questionId`, `kind`, `reason`, `userId`, `retryAfterSeconds` |
| Sprint 3 | `question_correction_failed`, `question_correction_retrieval_failed` | error | `courseId`, `questionId`, `kind`, `userId`, `errorType` |
| US-74 | `slow_operation` | warn | `operation`, `durationMs`, and the operation's IDs |
| 2 (Sprint 3) | `question_grouping_completed` | info | `courseId`, `questionCount`, `groupCount`, `rewordedMatches`, `lowConfidenceMatches` |
| 2 (Sprint 3) | `question_grouping_low_confidence` | warn | `courseId`, `questionId`, `matchedQuestionId`, `score` |
| 2 (Sprint 3) | `question_report_submitted` | info | `reportId`, `courseId`, `groupId`, `category` (the reason), `userId` (never the note) |
| 2 (Sprint 3) | `question_report_refused`, `question_report_rate_limited` | warn | `groupId`, `reason`, `userId`, `retryAfterSeconds` |
| 2 (Sprint 3) | `question_report_failed`, `question_report_retrieval_failed` | error | `groupId`, `userId`, `errorType` |
| 3 (Sprint 3) | `question_progress_saved` | info | `userId`, `courseId`, `groupId`, `operation` (`mark` or `undo`) |
| 3 (Sprint 3) | `question_progress_refused`, `question_progress_rate_limited` | warn | `groupId`, `reason` (`invalid_choice`, `not_found`), `userId`, `retryAfterSeconds` |
| 3 (Sprint 3) | `question_progress_failed`, `question_progress_retrieval_failed` | error | `userId`, `courseId`, `groupId`, `operation` (`mark` or `relink`), `errorType` |
| 3 (Sprint 3) | `learning_profile_retrieval_failed`, `learning_profile_update_failed` | error | `userId`, `courseId`, `source` (`personal_order`, `topic_confidence`), `errorType` (never a topic) |
| Mustafa Ergaibi (Sprint 3) | `priority_calculation_failed` | error | `userId`, `courseId`, `affectedQuestions`, `reasons` (`invalid_paper_count`, `invalid_total_papers`, `paper_count_exceeds_total`, `invalid_weakness`); at most one line per ranking |
| Mustafa Ergaibi (Sprint 3) | `topic_confidence_saved` | info | `userId`, `courseId`, `ratedTopics`, `skippedTopics`, `unchangedTopics` (never a topic) |
| Mustafa Ergaibi (Sprint 3) | `topic_confidence_refused`, `topic_confidence_rate_limited` | warn | `userId`, `courseId`, `reason` (`unknown_topic`, `invalid_rating`, `no_ratings`), `retryAfterSeconds` |
| Mustafa Ergaibi (Sprint 3) | `topic_confidence_save_failed` | error | `userId`, `courseId`, `errorType` |
| Mustafa Ergaibi (Sprint 4) | `topic_strengths_retrieval_failed` | error | `userId`, `courseId`, `source` (`profile`, `course_topics`, `covered`, `selection`), `errorType` (never a topic); one line per failed page load |
| Mustafa Ergaibi (Sprint 4) | `topic_strengths_invalid_data` | warn | `userId`, `courseId`, `invalidTopics` (a count, never a topic); at most one line per page load |
| Mustafa Ergaibi (Sprint 4) | `study_recommendation_failed` | error | `userId`, `courseId`, `step` (`profile`, `course_topics`, `covered`, `selection`), `errorType` (never a topic); one line per failed page load |
| Mustafa Ergaibi (Sprint 4) | `study_recommendation_invalid_inputs` | warn | `userId`, `courseId`, `affectedTopics` (a count, never a topic), `reasons` (the `checkedPriority` reason codes); at most one line per page load |
| Mustafa Ergaibi (Sprint 4) | `topic_covered_saved` | info | `userId`, `courseId`, `covered` (`true`, `false`), `changed` (`false` when the topic already was as asked); never a topic |
| Mustafa Ergaibi (Sprint 4) | `topic_covered_refused`, `topic_covered_rate_limited` | warn | `userId`, `courseId`, `reason` (`unknown_topic`, `invalid_value`), `retryAfterSeconds`; never a topic or the submitted value |
| Mustafa Ergaibi (Sprint 4) | `topic_covered_save_failed` | error | `userId`, `courseId`, `errorType` |
| Sprint 4, mock exams (US-45) | `mock_exam_created` | info | `userId`, `courseId`, `mockExamId`, `difficulty`, `length`, `topicCount`, `generatedCount` (never a topic, a question or an answer) |
| Sprint 4, mock exams (US-45) | `mock_exam_refused`, `mock_exam_rate_limited` | warn | `userId`, `courseId`, `reason` (`course_not_found`, `no_questions`, `topic_invalid`, `length_invalid`, `difficulty_invalid`, `not_enough_questions`), `retryAfterSeconds` |
| Sprint 4, mock exams (US-45) | `mock_exam_failed`, `mock_exam_retrieval_failed` | error | `userId`, `courseId`, `mockExamId`, `entity` (`options`, `list`), `errorType`, `errorCode` |
| Sprint 4, mock exams (US-45) | `mock_exam_saved`, `mock_exam_submitted` | info | `userId`, `mockExamId`, `submit` (never an answer) |
| Sprint 4, mock exams (US-45) | `mock_exam_save_refused` | warn | `userId`, `mockExamId`, `submit`, `reason` (`not_found`, `already_submitted`, `answer_too_long`) |
| Sprint 4, mock exams (US-45) | `mock_exam_save_failed` | error | `userId`, `mockExamId`, `submit`, `errorType`, `errorCode` |
| Mohammed Al-Haiqi (Sprint 4, US-38) | `advice_feed_rate_limited` | warn | `userId`, `retryAfterSeconds`; the student opened advice pages more than `ADVICE_FEED_RATE_LIMIT_PER_MINUTE` times in a minute |
| Mohammed Al-Haiqi (Sprint 4, US-36) | `advice_edited`, `advice_deleted` | info | `adviceId`, `courseId`, `userId`, `hasLink` (edits); never the title, text, or link |
| Mohammed Al-Haiqi (Sprint 4, US-36) | `advice_change_refused`, `advice_change_rate_limited` | warn | `adviceId`, `userId`, `operation` (`edit`, `delete`), `reason` (`not_found`, `title_required`, `title_too_long`, `body_required`, `body_too_long`, `link_invalid`, `link_title_too_long`) or `retryAfterSeconds` |
| Mohammed Al-Haiqi (Sprint 4, US-36) | `advice_change_failed` | error | `adviceId`, `userId`, `operation`, `errorType` |
| Mohammed Al-Haiqi (Sprint 4, US-43) | `advice_report_submitted` | info | `reportId`, `adviceId`, `courseId`, `category` (the reason), `userId`; never the note |
| Mohammed Al-Haiqi (Sprint 4, US-43) | `advice_report_refused`, `advice_report_rate_limited` | warn | `adviceId`, `userId`, `reason` (`invalid_reason`, `note_too_long`, `not_found`, `own_advice`, `duplicate`) or `retryAfterSeconds` |
| Mohammed Al-Haiqi (Sprint 4, US-43) | `advice_report_failed` | error | `adviceId`, `userId`, `errorType` |
| Mohammed Al-Haiqi (Sprint 4, US-77) | `advice_removed_by_admin`, `advice_reports_dismissed` | info | `adviceId`, `courseId`, `adminId`, the number of reports closed |
| Mohammed Al-Haiqi (Sprint 4, US-77) | `advice_moderation_refused`, `advice_moderation_rate_limited` | warn | `adviceId`, `adminId`, `decision`, `reason` (`invalid_decision`, `not_found`: no open reports any more) or `retryAfterSeconds` |
| Mohammed Al-Haiqi (Sprint 4, US-77) | `advice_moderation_failed`, `advice_report_queue_failed` | error | `adviceId`, `adminId`, `errorType` |
| Lea Tass (Sprint 4, US-31) | `practice_set_failed` | error | `userId`, `courseId`, `size`, `errorType` (never a topic or question text) |
| Lea Tass (Sprint 4, US-40) | `advice_vote_saved` | info | `userId`, `courseId`, `adviceId`, `helpful` (`true`, `false`), `changed` |
| Lea Tass (Sprint 4, US-40) | `advice_vote_refused`, `advice_vote_rate_limited` | warn | `userId`, `courseId`, `adviceId`, `reason` (`not_found`, `own_advice`, `invalid_value`), `retryAfterSeconds` |
| Lea Tass (Sprint 4, US-40) | `advice_vote_failed`, `advice_vote_retrieval_failed` | error | `userId`, `courseId`, `adviceId`, `helpful`, `errorType`, `errorCode` |
| Lea Tass (Sprint 4, US-41) | `advice_comment_saved`, `advice_comment_deleted` | info | `userId`, `courseId`, `adviceId`, `commentId`, `byAdmin` (never the reply text) |
| Lea Tass (Sprint 4, US-41) | `advice_comment_refused`, `advice_comment_rate_limited`, `advice_comment_delete_refused` | warn | `userId`, `courseId`, `adviceId`, `commentId`, `byAdmin`, `reason` (`body_required`, `body_too_long`, `not_found`, `forbidden`), `retryAfterSeconds` |
| Lea Tass (Sprint 4, US-41) | `advice_comment_failed`, `advice_comment_retrieval_failed` | error | `userId`, `courseId`, `adviceId`, `commentId`, `operation` (`add`, `delete`), `errorType`, `errorCode` |
| Lea Tass (Sprint 4, US-46) | `mock_exam_version_created` | info | `userId`, `courseId`, `mockExamId` (the exam asked from), `originalId`, `newMockExamId`, `version` |
| Lea Tass (Sprint 4, US-46) | `mock_exam_version_refused` | warn | `userId`, `courseId`, `mockExamId`, `originalId`, `reason` (`not_found`, `not_enough_questions`, `topic_invalid`, `no_questions`, `rate_limited`), `available` |
| Lea Tass (Sprint 4, US-46) | `mock_exam_version_failed` | error | `userId`, `mockExamId`, `entity` (`list`), `errorType`, `errorCode` |

| Mohammed Al-Haiqi (Sprint 4, US-49) | `mock_exam_marked` | info | `userId`, `mockExamId`, `courseId`, counts per outcome (`correct`, `partial`, `incorrect`, `unanswered`, `noKey`), `eventsRecorded`, `eventsSkipped` |
| Mohammed Al-Haiqi (Sprint 4, US-49) | `mock_exam_marking_failed`, `mock_exam_marking_evidence_failed` | error | `userId`, `mockExamId`, `errorType`, `errorCode`; the second means the marks were saved but the learning events were not |
| Mohammed Al-Haiqi (Sprint 4, US-49) | `answer_key_saved`, `answer_key_removed` | info | `adminId`, `courseId`, `groupId`, `keyPoints` (a count); never a key point or an explanation |
| Mohammed Al-Haiqi (Sprint 4, US-49) | `answer_key_refused`, `answer_key_rate_limited`, `answer_key_save_failed` | warn / error | `adminId`, `courseId`, `groupId`, `reason` (`points_required`, `too_many_points`, `point_too_long`, `explanation_too_long`, `not_found`), `retryAfterSeconds`, or `errorType` |
| Mohammed Al-Haiqi (Sprint 4, US-50) | `mock_results_rate_limited`, `mock_results_retrieval_failed` | warn / error | `userId`, `mockExamId`, `retryAfterSeconds` or `errorType` |

### What is never logged

Only IDs, roles, routes, reasons, error types, and error codes are logged. Error messages are never logged, and neither is anything a user typed: names, emails, titles, passwords, tokens, or file contents.

The logger also enforces three rules on every line, whatever the caller passes:
- Every value is cut to 200 characters.
- Control characters are removed, so a value cannot fake a second log line.
- Keys that look sensitive (`password`, `token`, `secret`, `cookie`, `email`, `authorization`, `apiKey`) are dropped.

To log a Node or Prisma error code (`ENOENT`, `EACCES`, `P2002`) without its message, use `errorCode(error)`.

### Persistence and retention

- **Background save.** Lines are saved to `LogEntry` (`level`, `event`, `context`, `createdAt`). A request never waits for the save.
- **Database failure.** If the database is down or the table is missing, logging falls back to the console and prints one `log_persistence_unavailable` warning. It never logs about its own failure.
- **Edge and test runtimes.** The logger loads the database code lazily, so it is safe to import from edge code. Under unit tests it never loads it at all.
- **Turning it off.** Set `LOG_PERSIST=off` to keep logs on the console only.
- **Retention.** Entries older than 30 days are deleted at most once an hour, on the next log write or when `/admin/monitoring` is opened.

### The monitoring page

`/admin/monitoring` is for admins only. It is linked from the header ("Monitoring") and from `/admin/catalog`. It shows:
- an alert banner, while the error count is at or above the threshold or an alert was raised within the cooldown;
- the counts per event and level for the last 24 hours;
- the newest 100 entries, filterable by level, event, and time range (last hour, 24 hours, 7 days, or 30 days).

### Alerts

When at least `ALERT_THRESHOLD` error-level events (default 5) occur within `ALERT_WINDOW_MINUTES` (default 10), the app records a `monitoring_alert_triggered` entry. If `ALERT_WEBHOOK_URL` is set, it also posts one message to it.

- **Message content.** Event names and counts only, in Discord's format (`{ "content": … }`), with mentions disabled.
- **Cooldown.** After an alert, no other alert is raised for `ALERT_COOLDOWN_MINUTES` (default: the window), so one incident sends one message.
- **Setup.** In Discord, open Server Settings, then Integrations, then Webhooks, then New Webhook, and copy the URL into `ALERT_WEBHOOK_URL` in `.env`. Only `https` URLs are used, plus plain `http` to `localhost` for testing.
- **Failure.** A failing webhook prints one `alert_webhook_failed` warning, never the URL.

**Demo:**
1. Open http://localhost:3000/files/file-missing five times (the seeded record whose file is deliberately missing).
2. Open http://localhost:3000/admin/monitoring as the admin. The banner shows "Alert: 5 errors in the last 10 minutes", and the entries show `physical_file_not_found` with `fileId=file-missing`.

Tests are in `tests/unit/logger.test.ts`, `tests/unit/log-store.test.ts`, `tests/unit/monitoring-page.test.tsx`, and `tests/e2e/admin-monitoring.spec.ts`.
