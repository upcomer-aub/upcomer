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
- US-49 calls `recordMockOutcomes(userId, courseId, attemptId, [{ itemId, generatedQuestionId, correct }])` **after** validating ownership and committing rubric-backed grading. This adapter is tested with stored generated items; the real US-49 grading/session integration is not present on this branch. FLASHCARD and AI_INTERACTION are future E5 producer contracts, not released features. Full original US-25 acceptance remains partial until those integrations exist.
- Mock attempt/item identifiers must be nonempty. Simple existing IDs retain their event keys; separator-bearing or long pairs use a framed hash so different attempts cannot collide. Invalid producer payloads are refused before database work; cross-course event-ID conflicts are serialized per student.

### New practice questions (US-44)

- `generatePracticeQuestions(userId, courseId, { count, difficulty, topicKey? })` generates and persists an exact batch or returns a controlled refusal. It reads only published exam questions in that course, requires a tagged topic and a usable source, and respects EASY/MEDIUM/HARD requested reasoning depth.
- The offline generator produces **new reasoning tasks around the original paper context**, not numerical substitutions or invented solutions. It needs no model key. Easy tasks identify concepts/assumptions, medium tasks plan/check solutions, hard tasks compare/generalize reasoning. Difficulty is instructional intent, not a calibrated assessment. Sources are copied as context and linked for review.
- There are three task variants per source/difficulty. Normalized content hashes prevent exact repeats of historical questions or the student's existing generated tasks. Exhaustion is explicit; no smaller batch is silently returned. Libraries are private to a student/course.
- Persisted items include stable IDs, topic/difficulty, generator version, source-question relation, source fingerprint, prompt, content hash, and nullable rubric. Source removal/replacement cascades generated items; correction or retagging excludes stale items from eligibility. Generation never changes historical question groups or frequencies.
- US-45/46/47 should use `getGeneratedPracticeQuestions(userId, courseId, settings?)` to enforce source validity and library privacy, then persist selected item IDs in their own mock-session schema. This branch does not implement another member's session, timer or grading stories. `rubric` is null because source exams have no verified keys; US-49 must flag that limitation instead of inventing a grade.
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
| `/courses/:courseId/mock-exams` | Mock exams of that course (US-45): choose topics, a length and a difficulty, optionally with your generated practice questions, and see your own exams; generating requires a session |
| `/courses/:courseId/mock-exams/:mockExamId` | Sit one of your own mock exams: save answers, then submit to lock them; a timed exam (US-48) starts with a Start page and shows a countdown; requires a session, and another student's exam is not found |
| `/courses/:courseId/advice` | Advice from previous students for that course, with search and filters (US-34, US-35, US-37, US-39); publishing requires a session |
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
