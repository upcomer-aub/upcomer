# Upcomer

Upcomer is a university study platform organized around courses. This Sprint 1 slice lets a student create an account, log in, discover a course, add it to My Courses, open the course, browse its previous exams and materials, and view original uploaded files. Uploads and admin screens belong to other team members.

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

US-21 (mark questions done and resume), US-33 (learning profile kept per course), and US-28 (personal ordering of the Upcomer Exam). US-24, US-25, and US-27 (Mustafa Ergaibi and unassigned) are **not** implemented here; see "Placeholders" below.

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
- **Writing it.** `setTopicWeakness(userId, courseId, topic, weakness)` in `lib/learning-profile.ts` is the one write path, for US-24 and US-25 to call. `getLearningProfile(userId, courseId)` reads one course.

### Personal order (US-28)

- Logged-in students get a **Frequency order / Personal order** switch. `?order=personal` shows one list, "Your order", sorted by `personalPriority` for each question; ties keep the frequency order. Each question keeps its number, tier badge, mark form, and report form. **Frequency order** (the address without `?order=personal`) restores the stored ranking.
- A student with no profile rows in the course sees the frequency order with "You have no learning profile for this course yet, so this is the frequency order." Visitors always get the frequency order.

### Placeholders for other stories

Both are in `lib/personal-order.ts`, marked `PLACEHOLDER`:
- **`personalPriority(paperCount, totalPapers, weakness)`**, for US-27: `share of papers × (0.5 + weakness)`. Replace this one function.
- **`NEUTRAL_WEAKNESS = 0.5`**, for US-24's neutral default: the weakness of a question with no topic, or a topic without a score.

### Known limitations

- **Nothing writes `weakness` yet.** Until US-24 or US-25 exists, every real student's profile is empty, so the personal order shows the frequency order with the "no learning profile" note. The tests write profiles with `setTopicWeakness`, and US-33's "practice" is simulated the same way.
- **A report sent from the personal order returns to the frequency order**, because the report action (US-23) does not keep `order=personal`. Questions keep their numbers, so its notice and `#question-N` still point at the right question.

Monitoring: see the events table (`question_progress_*`, `learning_profile_*`). Topics are never logged.

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
| 3 (Sprint 3) | `learning_profile_retrieval_failed`, `learning_profile_update_failed` | error | `userId`, `courseId`, `source` (`personal_order`), `errorType` (never a topic) |

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
