# Cross-Test Report: Member 5's Upload APIs (US-70, US-71), Unit Level

**Tester:** Member 1 · **Code tested:** `main` at `0e1f7d2` (after PR #17) · **Date:** 2026-10-05
**Test file:** `tests/unit/cross-test-member-5-uploads.test.ts` (73 tests)

This is a second, independent pass over Member 5's uploads. The first report (`MEMBER_1_CROSS_TEST_REPORT_UPLOADS.md`) tested the branch at `4f2a1a0`. Since then the upload code has changed 5 times: admin-only access, shared term and type fields, a scoped e2e locator, a type check that applies to exams only, and e2e cleanup. Member 5's own tests stay as their developer checks. These tests are separate and were written without changing any of Member 5's code.

## Fixes on branch `member5`

The findings below describe `main` at `0e1f7d2`. Branch `member5` fixes findings 1–3. Finding 4 is by design and is unchanged. On that branch the cross-test file has **75 tests**, all passing:
- C-18 and C-19 now expect 404.
- D-16 now expects a refusal.
- D-17 is new: a DOCX renamed to `.pptx` is refused.
- B-05 is new: an endless body with no `Content-Length` is cut off at the limit.

| Finding | Fix | Files |
|---|---|---|
| 1. An unknown professor returned 400 | `professor_not_assigned` now maps to **404** in the upload `STATUS` table, as the plan says. Only uploads change; Member 4's metadata edit page (US-72) keeps its own handling. | `lib/uploads.ts` |
| 2. Any ZIP renamed to `.docx` or `.pptx` was accepted | A DOCX must now contain the entry names `[Content_Types].xml` and `word/`, and a PPTX `[Content_Types].xml` and `ppt/`. ZIP stores entry names uncompressed, so this is a byte search with no unzip library. A plain archive, or a DOCX renamed to `.pptx`, gets `400 content_mismatch`. | `lib/uploads.ts` |
| 3. Without `Content-Length`, the whole body was read before the size check | The route now reads the body as a stream and stops once it passes 20 MB + 1 MB of form overhead, then returns 413. Memory is capped whatever the header says. The early `Content-Length` rejection is kept. | `app/api/admin/uploads/route.ts` |

**Shared files touched:**
- `tests/reliability/features/admin.ts`: the "professor not teaching" check now expects 404. This is a one-line change.
- `tests/unit/uploads.test.ts` (Member 5's tests):
  - the DOCX and PPTX fixtures now include the Office entry names
  - the professor case now expects 404
  - 2 new corrupt-content cases were added

**Checks on `member5`:**

| Check | Result |
|---|---|
| `npm test` | 484/484 pass, 28 files |
| `npm run lint` | Pass |
| `npx tsc --noEmit` | Pass |
| `npm run build` | Pass |
| `npm run test:e2e` | **28/28 pass**, against a production build and a real PostgreSQL 18.4 database. These tests include browser uploads through the new streaming route. |
| `npm run reliability` | Not run |

## Verdict

**73 of 73 tests pass. US-70 and US-71 meet every key check in the Sprint 1 plan:** valid uploads, invalid or corrupt files, storage success and failure, and the file can be opened after upload.

Only one item contradicts the written plan, and it is carried over from the first report (finding 1). The other three findings are low-risk observations, not defects.

| | Result |
|---|---|
| New cross-test file | **73/73 pass** |
| Whole unit suite with the new file | **480/480 pass**, 28 files |
| `npm run lint` | Pass |
| `npx tsc --noEmit` | Pass. A stale local Prisma client had to be regenerated first with `npx prisma generate` |
| `npm run build`, `npm run test:e2e` | Not run. This change adds a unit test file only and touches no app code. |

## What is real and what is faked

To test the APIs and not a mock of them, only three things are faked:

| Faked | Why |
|---|---|
| The database (`@/lib/db`), using an in-memory store with 2 courses, 2 professors and 1 term | There is no PostgreSQL server in a unit test. The fake behaves like Prisma for the queries these APIs use. |
| The session cookie (`next/headers`) | Selects the caller: no session, admin, student, expired, or forged |
| `unlink`, in test E-03 only | The only way to force a cleanup failure |

The following are **all real code**:
- the route `POST /api/admin/uploads`
- the upload service (`lib/uploads.ts`)
- the upload rules (`lib/upload-rules.ts`)
- Member 4's shared metadata checks (`lib/file-metadata.ts`)
- Member 1's `getAdminUser` and session check
- the logger
- **real files written to a temporary storage folder**
- Member 3's `GET /files/:fileId` route, which section F uses to open each uploaded file again

## APIs covered

| API | Kind | Tests |
|---|---|---|
| `POST /api/admin/uploads` | HTTP route | A–E (60 tests, 61 calls) |
| `POST /api/admin/uploads` → `GET /files/:fileId` | Upload, then open | F (7 tests, 14 calls) |
| `getUploadOptions()` | Service, used to build the upload form | G (2 tests) |
| `validateUploadFile()`, `parseUploadForm()` | Service, exported | H (4 tests) |

## Findings

### 1. An unknown professor returns 400, but the plan says 404 (carried over, still open)

Tests C-18 and C-19 cover this. The plan says "an unknown course or professor returns 404". An unknown course correctly returns **404** (C-20). An unknown professor, or a professor who does not teach the selected course, returns **400 `professor_not_assigned`**.

The reason name changed from the first report (`professor_not_found` is now `professor_not_assigned`) because the check moved into Member 4's shared `lib/file-metadata.ts`. Any change now affects both uploads and US-72 editing, so **Member 4 and Member 5 should decide together**. Either update the plan's wording or move `professor_not_assigned` to 404 in `STATUS` in `lib/uploads.ts`. The tests assert the current 400, so CI stays green until that decision is made.

### 2. Observation: any ZIP renamed to `.docx` or `.pptx` is accepted

Test D-16 covers this. DOCX and PPTX are both ZIP files, so only the 4-byte ZIP signature is checked. A plain `.zip` renamed to `.docx` is stored. The risk is low:
- only admins can upload
- `/files/:id` serves non-PDFs as `attachment` with `nosniff`

A stricter check would look for `[Content_Types].xml` inside the archive. It is optional for Sprint 1.

### 3. Observation: without a Content-Length header, the whole body is read before the 20 MB check

Test D-10 covers this. The early 413 depends on the `Content-Length` header. Browsers always send that header for form uploads, so the form is unaffected. A scripted admin client that streams without it still gets a correct **413**, but only after the full body has been parsed in memory.

### 4. Note: a failed cleanup leaves one orphan file (by design, and logged)

Test E-03 covers this. If the database record fails *and* deleting the stored file also fails, the file stays in storage. Both `upload_cleanup_failed` and `upload_record_failed` are logged, so monitoring can see it. This is the documented behavior, not a defect.

### First report's defects, re-checked

| First report | Status on `0e1f7d2` |
|---|---|
| Defect 1: the e2e `getByRole("alert")` locator matched Next's route announcer | **Fixed** in `2265875`. The locator is now scoped to the upload form. (Checked by reading the code. The e2e suite was not run here.) |
| Defect 2: an unknown professor returns 400, not 404 | **Still open.** See finding 1 |
| Integration step: the upload API was open to anyone | **Fixed** in `83f8b16`. Tests A-01 to A-06 confirm a 403 for visitors, students, expired sessions, forged tokens and a failed session lookup |

## Results per test

### A. POST /api/admin/uploads — access control — 6/6 pass

| ID | Test | Result | Time |
|---|---|---|---|
| A-01 | logged-out visitor gets 403 and nothing is stored | ✅ Pass | 11 ms |
| A-02 | logged-in student gets 403 and nothing is stored | ✅ Pass | 4 ms |
| A-03 | admin with an expired session gets 403 | ✅ Pass | 3 ms |
| A-04 | unknown session token gets 403 | ✅ Pass | 3 ms |
| A-05 | session lookup failure fails closed with 403 | ✅ Pass | 6 ms |
| A-06 | a student's oversized request is 403, not 413 (auth is checked first) | ✅ Pass | 4 ms |

### B. POST /api/admin/uploads — request handling — 4/4 pass

| ID | Test | Result | Time |
|---|---|---|---|
| B-01 | Content-Length over 20 MB + 1 MB overhead is refused with 413 before the body is read | ✅ Pass | 4 ms |
| B-02 | Content-Length exactly at the limit passes the size gate | ✅ Pass | 3 ms |
| B-03 | a JSON body is refused with 400 invalid_form | ✅ Pass | 2 ms |
| B-04 | a non-numeric Content-Length header does not crash the route | ✅ Pass | 2 ms |

### C. POST /api/admin/uploads — form fields — 28/28 pass

| ID | Test | Result | Time |
|---|---|---|---|
| C-01 | valid exam with every optional field returns 201 and the file link | ✅ Pass | 13 ms |
| C-02 | valid material with only required fields returns 201 | ✅ Pass | 9 ms |
| C-03 | missing category is refused with 400 | ✅ Pass | 3 ms |
| C-04 | lowercase category is refused with 400 | ✅ Pass | 3 ms |
| C-05 | unknown category is refused with 400 | ✅ Pass | 2 ms |
| C-06 | missing course is refused with 400 | ✅ Pass | 2 ms |
| C-07 | missing title is refused with 400 | ✅ Pass | 2 ms |
| C-08 | whitespace-only title is refused with 400 | ✅ Pass | 1 ms |
| C-09 | title of 151 characters is refused with 400 | ✅ Pass | 1 ms |
| C-10 | year 1949 is refused with 400 | ✅ Pass | 2 ms |
| C-11 | two-digit year is refused with 400 | ✅ Pass | 1 ms |
| C-12 | year two years ahead is refused with 400 | ✅ Pass | 3 ms |
| C-13 | decimal year is refused with 400 | ✅ Pass | 2 ms |
| C-14 | topic of 101 characters is refused with 400 | ✅ Pass | 3 ms |
| C-15 | lowercase exam type is refused with 400 | ✅ Pass | 2 ms |
| C-16 | exam type on a material is refused with 400 | ✅ Pass | 3 ms |
| C-17 | unknown term is refused with 400 | ✅ Pass | 5 ms |
| C-18 | professor from another course is refused with 400 | ✅ Pass | 3 ms |
| C-19 | professor that does not exist is refused with 400 | ✅ Pass | 2 ms |
| C-20 | unknown course is refused with 404 | ✅ Pass | 2 ms |
| C-21 | title of exactly 150 characters is accepted | ✅ Pass | 3 ms |
| C-22 | year 1950 is accepted | ✅ Pass | 4 ms |
| C-23 | next year is accepted | ✅ Pass | 4 ms |
| C-24 | topic of exactly 100 characters is accepted | ✅ Pass | 4 ms |
| C-25 | padded fields are trimmed is accepted | ✅ Pass | 3 ms |
| C-26 | file sent as a text field is refused with 400 | ✅ Pass | 2 ms |
| C-27 | missing file is refused with 400 | ✅ Pass | 4 ms |
| C-28 | rejection logs never contain the title, file name or a long course ID | ✅ Pass | 3 ms |

### D. POST /api/admin/uploads — file checks — 16/16 pass

| ID | Test | Result | Time |
|---|---|---|---|
| D-01 | .exe is refused | ✅ Pass | 2 ms |
| D-02 | no extension is refused | ✅ Pass | 2 ms |
| D-03 | double extension .pdf.exe is refused | ✅ Pass | 1 ms |
| D-04 | .html is refused | ✅ Pass | 1 ms |
| D-05 | empty .pdf is refused | ✅ Pass | 1 ms |
| D-06 | HTML renamed to .pdf is refused | ✅ Pass | 1 ms |
| D-07 | PDF renamed to .docx is refused | ✅ Pass | 3 ms |
| D-08 | JPEG renamed to .png is refused | ✅ Pass | 2 ms |
| D-09 | truncated PDF header is refused | ✅ Pass | 2 ms |
| D-10 | a 20 MB + 1 byte file without a Content-Length header is still refused with 413 | ✅ Pass | 61 ms |
| D-11 | a file of exactly 20 MB is accepted | ✅ Pass | 73 ms |
| D-12 | the browser's MIME type is ignored; the stored type comes from the checked extension | ✅ Pass | 5 ms |
| D-13 | an uppercase extension is accepted and stored with a lowercase key | ✅ Pass | 8 ms |
| D-14 | Unix path traversal in the file name cannot escape the storage folder | ✅ Pass | 9 ms |
| D-15 | Windows path traversal in the file name cannot escape the storage folder | ✅ Pass | 17 ms |
| D-16 | OBSERVATION: any ZIP renamed to .docx/.pptx is accepted (only the 4-byte ZIP signature is checked) | ✅ Pass | 8 ms |

### E. POST /api/admin/uploads — storage and record failures — 6/6 pass

| ID | Test | Result | Time |
|---|---|---|---|
| E-01 | a storage write failure returns 500, logs once with the error code, and creates no record | ✅ Pass | 8 ms |
| E-02 | a database record failure returns 500 and deletes the stored file | ✅ Pass | 6 ms |
| E-03 | when cleanup also fails, both failures are logged (the orphan file stays) | ✅ Pass | 10 ms |
| E-04 | an unexpected database error returns a generic 500 without leaking details | ✅ Pass | 8 ms |
| E-05 | two uploads with the same file name get different storage keys and both survive | ✅ Pass | 14 ms |
| E-06 | the returned link URL-encodes the file ID | ✅ Pass | 6 ms |

### F. Upload then GET /files/:fileId — file retrievable after upload — 7/7 pass

| ID | Test | Result | Time |
|---|---|---|---|
| F-01 | PDF exam opens byte-for-byte with the right headers | ✅ Pass | 9 ms |
| F-02 | DOCX material opens byte-for-byte with the right headers | ✅ Pass | 10 ms |
| F-03 | PPTX material opens byte-for-byte with the right headers | ✅ Pass | 14 ms |
| F-04 | PNG exam opens byte-for-byte with the right headers | ✅ Pass | 15 ms |
| F-05 | JPG exam opens byte-for-byte with the right headers | ✅ Pass | 17 ms |
| F-06 | a refused upload leaves no file to open | ✅ Pass | 4 ms |
| F-07 | a file deleted from storage after upload shows the 404 page, not an error | ✅ Pass | 18 ms |

### G. getUploadOptions — course list for the upload form — 2/2 pass

| ID | Test | Result | Time |
|---|---|---|---|
| G-01 | returns courses ordered by code with their professors flattened | ✅ Pass | 14 ms |
| G-02 | a database failure is logged and rethrown for the error page | ✅ Pass | 5 ms |

### H. validateUploadFile and parseUploadForm — direct calls — 4/4 pass

| ID | Test | Result | Time |
|---|---|---|---|
| H-01 | an empty .exe is reported as unsupported (type is checked before size) | ✅ Pass | 3 ms |
| H-02 | a 2-byte JPEG is reported as corrupt, not crashed on | ✅ Pass | 2 ms |
| H-03 | parseUploadForm uses the given clock for the year limit | ✅ Pass | 3 ms |
| H-04 | parseUploadForm drops blank optional fields | ✅ Pass | 2 ms |


## Results per API call

Every call the tests made, with the response the real code returned. Section F calls open the file that the call before it uploaded. `[admin-token]` and similar labels show which session made the call. Log events are the `logError` events emitted during the test, up to and including that call.

To regenerate this log: `M5_CALL_LOG=test-results/m5-calls.json npx vitest run tests/unit/cross-test-member-5-uploads.test.ts`

| # | Test | Request | Status | Response | Log events |
|---|---|---|---|---|---|
| 1 | A-01 | `POST /api/admin/uploads [no session] category="EXAM" courseId="course-a" title="Final Exam" file=<file final.pdf, 27 B, type "">` | **403** | `{"reason":"forbidden","error":"Only an admin can upload files."}` | unauthorized_access |
| 2 | A-02 | `POST /api/admin/uploads [student-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file final.pdf, 27 B, type "">` | **403** | `{"reason":"forbidden","error":"Only an admin can upload files."}` | unauthorized_access |
| 3 | A-03 | `POST /api/admin/uploads [expired-admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file final.pdf, 27 B, type "">` | **403** | `{"reason":"forbidden","error":"Only an admin can upload files."}` | session_validation_failed, unauthorized_access |
| 4 | A-04 | `POST /api/admin/uploads [forged-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file final.pdf, 27 B, type "">` | **403** | `{"reason":"forbidden","error":"Only an admin can upload files."}` | session_validation_failed, unauthorized_access |
| 5 | A-05 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file final.pdf, 27 B, type "">` | **403** | `{"reason":"forbidden","error":"Only an admin can upload files."}` | session_validation_failed, unauthorized_access |
| 6 | A-06 | `POST /api/admin/uploads [student-token] headers={"content-length":"52428800"} body="x"` | **403** | `{"reason":"forbidden","error":"Only an admin can upload files."}` | unauthorized_access |
| 7 | B-01 | `POST /api/admin/uploads [admin-token] headers={"content-length":"22020097"} body="x"` | **413** | `{"reason":"file_too_large","error":"The file is larger than 20 MB."}` | upload_rejected |
| 8 | B-02 | `POST /api/admin/uploads [admin-token] headers={"content-length":"22020096"} body="x"` | **400** | `{"reason":"invalid_form","error":"The upload could not be read. Please try again."}` | upload_rejected |
| 9 | B-03 | `POST /api/admin/uploads [admin-token] headers={"content-type":"application/json"} body="{\"title\":\"x\"}"` | **400** | `{"reason":"invalid_form","error":"The upload could not be read. Please try again."}` | upload_rejected |
| 10 | B-04 | `POST /api/admin/uploads [admin-token] headers={"content-length":"abc","content-type":"text/plain"} body="x"` | **400** | `{"reason":"invalid_form","error":"The upload could not be read. Please try again."}` | upload_rejected |
| 11 | C-01 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" professorId="prof-a" termId="term-fall" year="2025" examType="FINAL" topic="Routing" file=<file final.pdf, 27 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file-1"}}` | — |
| 12 | C-02 | `POST /api/admin/uploads [admin-token] category="MATERIAL" courseId="course-a" title="Lecture 1" file=<file lecture1.pptx, 8 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Lecture 1","category":"MATERIAL","courseId":"course-a","url":"/files/file-1"}}` | — |
| 13 | C-03 | `POST /api/admin/uploads [admin-token] category="" courseId="course-a" title="Final Exam" file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"invalid_fields","error":"Choose whether this is an exam or a material."}` | upload_rejected |
| 14 | C-04 | `POST /api/admin/uploads [admin-token] category="exam" courseId="course-a" title="Final Exam" file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"invalid_fields","error":"Choose whether this is an exam or a material."}` | upload_rejected |
| 15 | C-05 | `POST /api/admin/uploads [admin-token] category="HOMEWORK" courseId="course-a" title="Final Exam" file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"invalid_fields","error":"Choose whether this is an exam or a material."}` | upload_rejected |
| 16 | C-06 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="" title="Final Exam" file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"course_required","error":"Choose a course."}` | upload_rejected |
| 17 | C-07 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="" file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"invalid_fields","error":"Enter a title."}` | upload_rejected |
| 18 | C-08 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="   " file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"invalid_fields","error":"Enter a title."}` | upload_rejected |
| 19 | C-09 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="tttttttttttttttttttt"…(151 chars) file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"invalid_fields","error":"Title must be 150 characters or fewer."}` | upload_rejected |
| 20 | C-10 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" year="1949" file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"invalid_year","error":"Year must be a 4-digit year between 1950 and 2027."}` | upload_rejected |
| 21 | C-11 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" year="25" file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"invalid_year","error":"Year must be a 4-digit year between 1950 and 2027."}` | upload_rejected |
| 22 | C-12 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" year="2028" file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"invalid_year","error":"Year must be a 4-digit year between 1950 and 2027."}` | upload_rejected |
| 23 | C-13 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" year="2025.0" file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"invalid_year","error":"Year must be a 4-digit year between 1950 and 2027."}` | upload_rejected |
| 24 | C-14 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" topic="xxxxxxxxxxxxxxxxxxxx"…(101 chars) file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"topic_too_long","error":"Topic must be 100 characters or fewer."}` | upload_rejected |
| 25 | C-15 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" examType="final" file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"invalid_type","error":"Choose Midterm, Final, Quiz, or Other as the type."}` | upload_rejected |
| 26 | C-16 | `POST /api/admin/uploads [admin-token] category="MATERIAL" courseId="course-a" title="Final Exam" examType="FINAL" file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"type_not_allowed","error":"Only exams have a type."}` | upload_rejected |
| 27 | C-17 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" termId="term-nope" file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"term_not_found","error":"The selected term doesn't exist."}` | upload_rejected |
| 28 | C-18 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" professorId="prof-b" file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"professor_not_assigned","error":"The selected professor doesn't teach the selected course."}` | upload_rejected |
| 29 | C-19 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" professorId="prof-ghost" file=<file final.pdf, 27 B, type "">` | **400** | `{"reason":"professor_not_assigned","error":"The selected professor doesn't teach the selected course."}` | upload_rejected |
| 30 | C-20 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-ghost" title="Final Exam" file=<file final.pdf, 27 B, type "">` | **404** | `{"reason":"course_not_found","error":"The selected course doesn't exist."}` | upload_rejected |
| 31 | C-21 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="tttttttttttttttttttt"…(150 chars) file=<file final.pdf, 27 B, type "">` | **201** | `{"file":{"id":"file-1","title":"ttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttt…` | — |
| 32 | C-22 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" year="1950" file=<file final.pdf, 27 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file-1"}}` | — |
| 33 | C-23 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" year="2027" file=<file final.pdf, 27 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file-1"}}` | — |
| 34 | C-24 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" topic="xxxxxxxxxxxxxxxxxxxx"…(100 chars) file=<file final.pdf, 27 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file-1"}}` | — |
| 35 | C-25 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId=" course-a " title="  Midterm  " year=" 2024 " file=<file final.pdf, 27 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Midterm","category":"EXAM","courseId":"course-a","url":"/files/file-1"}}` | — |
| 36 | C-26 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file="not-a-file"` | **400** | `{"reason":"invalid_fields","error":"Choose a file to upload."}` | upload_rejected |
| 37 | C-27 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam"` | **400** | `{"reason":"invalid_fields","error":"Choose a file to upload."}` | upload_rejected |
| 38 | C-28 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="cccccccccccccccccccc"…(500 chars) title="SECRET-TITLE" file=<file SECRET-NAME.pdf, 27 B, type "">` | **404** | `{"reason":"course_not_found","error":"The selected course doesn't exist."}` | upload_rejected |
| 39 | D-01 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file setup.exe, 27 B, type "">` | **415** | `{"reason":"unsupported_type","error":"Unsupported file type. Upload a PDF, DOCX, PPTX, PNG, or JPG file."}` | upload_rejected |
| 40 | D-02 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file README, 27 B, type "">` | **415** | `{"reason":"unsupported_type","error":"Unsupported file type. Upload a PDF, DOCX, PPTX, PNG, or JPG file."}` | upload_rejected |
| 41 | D-03 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file exam.pdf.exe, 27 B, type "">` | **415** | `{"reason":"unsupported_type","error":"Unsupported file type. Upload a PDF, DOCX, PPTX, PNG, or JPG file."}` | upload_rejected |
| 42 | D-04 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file page.html, 13 B, type "">` | **415** | `{"reason":"unsupported_type","error":"Unsupported file type. Upload a PDF, DOCX, PPTX, PNG, or JPG file."}` | upload_rejected |
| 43 | D-05 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file empty.pdf, 0 B, type "">` | **400** | `{"reason":"empty_file","error":"The selected file is empty."}` | upload_rejected |
| 44 | D-06 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file fake.pdf, 38 B, type "">` | **400** | `{"reason":"content_mismatch","error":"The file is corrupt or is not a real .pdf file."}` | upload_rejected |
| 45 | D-07 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file fake.docx, 27 B, type "">` | **400** | `{"reason":"content_mismatch","error":"The file is corrupt or is not a real .docx file."}` | upload_rejected |
| 46 | D-08 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file fake.png, 6 B, type "">` | **400** | `{"reason":"content_mismatch","error":"The file is corrupt or is not a real .png file."}` | upload_rejected |
| 47 | D-09 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file short.pdf, 3 B, type "">` | **400** | `{"reason":"content_mismatch","error":"The file is corrupt or is not a real .pdf file."}` | upload_rejected |
| 48 | D-10 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file big.pdf, 20971521 B, type "">` | **413** | `{"reason":"file_too_large","error":"The file is larger than 20 MB."}` | upload_rejected |
| 49 | D-11 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file max.pdf, 20971520 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file-1"}}` | — |
| 50 | D-12 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file exam.pdf, 27 B, type "text/html">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file-1"}}` | — |
| 51 | D-13 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file EXAM.PDF, 27 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file-1"}}` | — |
| 52 | D-14 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file ../../../etc/evil.pdf, 27 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file-1"}}` | — |
| 53 | D-15 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file ..\..\Windows\evil.pdf, 27 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file-1"}}` | — |
| 54 | D-16 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file archive-renamed.docx, 8 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file-1"}}` | — |
| 55 | E-01 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file final.pdf, 27 B, type "">` | **500** | `{"reason":"storage_failed","error":"The file could not be stored. Please try again."}` | upload_storage_failed |
| 56 | E-02 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file final.pdf, 27 B, type "">` | **500** | `{"reason":"record_failed","error":"The file could not be saved. Please try again."}` | upload_record_failed |
| 57 | E-03 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file final.pdf, 27 B, type "">` | **500** | `{"reason":"record_failed","error":"The file could not be saved. Please try again."}` | upload_cleanup_failed, upload_record_failed |
| 58 | E-04 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file final.pdf, 27 B, type "">` | **500** | `{"reason":"upload_failed","error":"The upload failed. Please try again."}` | upload_failed |
| 59 | E-05 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file same.pdf, 27 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file-1"}}` | — |
| 60 | E-05 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file same.pdf, 29 B, type "">` | **201** | `{"file":{"id":"file-2","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file-2"}}` | — |
| 61 | E-06 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file final.pdf, 27 B, type "">` | **201** | `{"file":{"id":"file 9/x","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file%209%2Fx"}}` | — |
| 62 | F-01 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file exam.pdf, 27 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file-1"}}` | — |
| 63 | F-01 | `GET /files/file-1` | **200** | `<application/pdf, 27 B, inline; filename="exam.pdf">` | — |
| 64 | F-02 | `POST /api/admin/uploads [admin-token] category="MATERIAL" courseId="course-a" title="Final Exam" file=<file notes.docx, 8 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"MATERIAL","courseId":"course-a","url":"/files/file-1"}}` | — |
| 65 | F-02 | `GET /files/file-1` | **200** | `<application/vnd.openxmlformats-officedocument.wordprocessingml.document, 8 B, attachment; filename="notes.docx">` | — |
| 66 | F-03 | `POST /api/admin/uploads [admin-token] category="MATERIAL" courseId="course-a" title="Final Exam" file=<file slides.pptx, 8 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"MATERIAL","courseId":"course-a","url":"/files/file-1"}}` | — |
| 67 | F-03 | `GET /files/file-1` | **200** | `<application/vnd.openxmlformats-officedocument.presentationml.presentation, 8 B, attachment; filename="slides.pptx">` | — |
| 68 | F-04 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file scan.png, 10 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file-1"}}` | — |
| 69 | F-04 | `GET /files/file-1` | **200** | `<image/png, 10 B, attachment; filename="scan.png">` | — |
| 70 | F-05 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file scan.jpg, 6 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file-1"}}` | — |
| 71 | F-05 | `GET /files/file-1` | **200** | `<image/jpeg, 6 B, attachment; filename="scan.jpg">` | — |
| 72 | F-06 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file fake.pdf, 6 B, type "">` | **400** | `{"reason":"content_mismatch","error":"The file is corrupt or is not a real .pdf file."}` | upload_rejected |
| 73 | F-06 | `GET /files/file-1` | **404** | `<html: File unavailable page>` | upload_rejected, file_record_not_found |
| 74 | F-07 | `POST /api/admin/uploads [admin-token] category="EXAM" courseId="course-a" title="Final Exam" file=<file final.pdf, 27 B, type "">` | **201** | `{"file":{"id":"file-1","title":"Final Exam","category":"EXAM","courseId":"course-a","url":"/files/file-1"}}` | — |
| 75 | F-07 | `GET /files/file-1` | **404** | `<html: File unavailable page>` | physical_file_not_found |

## How to run

```
npx vitest run tests/unit/cross-test-member-5-uploads.test.ts
```

## Shared files touched

None. This change adds `tests/unit/cross-test-member-5-uploads.test.ts` and this report only.
