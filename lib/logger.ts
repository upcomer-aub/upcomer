type LogEvent =
  | "advice_publish_refused"
  | "advice_publish_rate_limited"
  | "advice_published"
  | "advice_publish_failed"
  | "advice_search_failed"
  | "advice_retrieval_failed"
  | "advice_feed_rate_limited"
  | "advice_edited"
  | "advice_deleted"
  | "advice_change_refused"
  | "advice_change_rate_limited"
  | "advice_change_failed"
  | "advice_report_submitted"
  | "advice_report_refused"
  | "advice_report_rate_limited"
  | "advice_report_failed"
  | "advice_report_queue_failed"
  | "advice_removed_by_admin"
  | "advice_reports_dismissed"
  | "advice_moderation_refused"
  | "advice_moderation_rate_limited"
  | "advice_moderation_failed"
  | "learning_evidence_saved"
  | "learning_evidence_failed"
  | "learning_evidence_refused"
  | "practice_generation_completed"
  | "practice_generation_failed"
  | "practice_generation_refused"
  | "file_management_completed"
  | "file_management_failed"
  | "file_management_refused"
  | "file_management_cleanup_failed"
  | "course_retrieval_failed"
  | "exam_list_retrieval_failed"
  | "material_list_retrieval_failed"
  | "file_record_not_found"
  | "physical_file_not_found"
  | "file_open_failed"
  | "invalid_storage_key"
  | "course_catalog_retrieval_failed"
  | "course_search_failed"
  | "catalog_filter_options_retrieval_failed"
  | "question_grouping_rejected"
  | "question_grouping_failed"
  | "question_bank_retrieval_failed"
  | "question_search_failed"
  | "signup_failed"
  | "login_failed"
  | "session_validation_failed"
  | "logout_failed"
  | "unauthorized_access"
  | "my_courses_add_failed"
  | "my_courses_retrieval_failed"
  | "upload_rejected"
  | "upload_storage_failed"
  | "upload_record_failed"
  | "upload_cleanup_failed"
  | "upload_failed"
  | "upload_options_retrieval_failed"
  | "catalog_entry_rejected"
  | "catalog_entry_save_failed"
  | "catalog_admin_retrieval_failed"
  | "file_metadata_rejected"
  | "file_metadata_save_failed"
  | "file_metadata_retrieval_failed"
  | "monitoring_alert_triggered"
  | "submission_refused"
  | "submission_failed"
  | "submission_rejected"
  | "submission_review_failed"
  | "submission_retrieval_failed"
  | "unpublished_file_access"
  | "profile_save_rejected"
  | "profile_save_failed"
  | "profile_retrieval_failed"
  | "password_reset_requested"
  | "password_reset_rate_limited"
  | "password_reset_token_rejected"
  | "password_reset_rejected"
  | "password_reset_completed"
  | "password_reset_failed"
  | "password_reset_email_failed"
  | "slow_operation"
  | "submission_reviewed"
  | "submission_review_refused"
  | "submission_review_rate_limited"
  | "exam_processing_failed"
  | "exam_processing_started"
  | "exam_processing_completed"
  | "exam_processing_record_failed"
  | "exam_processing_retrieval_failed"
  | "exam_retry_refused"
  | "question_corrected"
  | "question_correction_refused"
  | "question_correction_rate_limited"
  | "question_correction_failed"
  | "question_correction_retrieval_failed"
  | "question_grouping_completed"
  | "question_grouping_low_confidence"
  | "question_report_submitted"
  | "question_report_refused"
  | "question_report_rate_limited"
  | "question_report_failed"
  | "question_report_retrieval_failed"
  | "learning_profile_retrieval_failed"
  | "learning_profile_update_failed"
  | "question_progress_failed"
  | "question_progress_retrieval_failed"
  | "question_progress_saved"
  | "question_progress_refused"
  | "question_progress_rate_limited"
  | "priority_calculation_failed"
  | "topic_confidence_saved"
  | "topic_confidence_refused"
  | "topic_confidence_rate_limited"
  | "topic_confidence_save_failed"
  | "topic_strengths_retrieval_failed"
  | "topic_strengths_invalid_data"
  | "study_recommendation_failed"
  | "study_recommendation_invalid_inputs"
  | "topic_covered_saved"
  | "topic_covered_refused"
  | "topic_covered_rate_limited"
  | "topic_covered_save_failed"
  | "mock_exam_weighting_failed"
  | "mock_exam_weighting_invalid_inputs"
  | "mock_exam_timer_started"
  | "mock_exam_expired"
  | "mock_exam_late_save_refused"
  | "mock_exam_created"
  | "mock_exam_refused"
  | "mock_exam_rate_limited"
  | "mock_exam_failed"
  | "mock_exam_retrieval_failed"
  | "mock_exam_saved"
  | "mock_exam_submitted"
  | "mock_exam_save_refused"
  | "mock_exam_save_failed"
  | "practice_set_failed"
  | "advice_vote_saved"
  | "advice_vote_refused"
  | "advice_vote_rate_limited"
  | "advice_vote_failed"
  | "advice_vote_retrieval_failed"
  | "advice_comment_saved"
  | "advice_comment_refused"
  | "advice_comment_rate_limited"
  | "advice_comment_deleted"
  | "advice_comment_delete_refused"
  | "advice_comment_failed"
  | "advice_comment_retrieval_failed"
  | "mock_exam_version_created"
  | "mock_exam_version_refused"
  | "mock_exam_version_failed"
  | "mock_exam_marked"
  | "mock_exam_marking_failed"
  | "mock_exam_marking_evidence_failed"
  | "answer_key_saved"
  | "answer_key_removed"
  | "answer_key_refused"
  | "answer_key_rate_limited"
  | "answer_key_save_failed"
  | "mock_results_rate_limited"
  | "mock_results_retrieval_failed";


export type { LogEvent };
export type LogLevel = "error" | "warn" | "info";
export type LogContext = Record<string, string | undefined>;
export type LogLine = { event: LogEvent; level: LogLevel; timestamp: string } & Record<string, string>;

// Severity of every event (US-87). error: something failed that should not have. warn: an expected refusal. info: notable, not a problem.
export const EVENT_LEVELS: Record<LogEvent, LogLevel> = {
  advice_publish_refused: "warn",
  advice_publish_rate_limited: "warn",
  advice_published: "info",
  advice_publish_failed: "error",
  advice_search_failed: "error",
  advice_retrieval_failed: "error",
  advice_feed_rate_limited: "warn",
  advice_edited: "info",
  advice_deleted: "info",
  advice_change_refused: "warn",
  advice_change_rate_limited: "warn",
  advice_change_failed: "error",
  advice_report_submitted: "info",
  advice_report_refused: "warn",
  advice_report_rate_limited: "warn",
  advice_report_failed: "error",
  advice_report_queue_failed: "error",
  advice_removed_by_admin: "info",
  advice_reports_dismissed: "info",
  advice_moderation_refused: "warn",
  advice_moderation_rate_limited: "warn",
  advice_moderation_failed: "error",
  learning_evidence_saved: "info",
  learning_evidence_failed: "error",
  learning_evidence_refused: "warn",
  practice_generation_completed: "info",
  practice_generation_failed: "error",
  practice_generation_refused: "warn",
  file_management_completed: "info",
  file_management_failed: "error",
  file_management_refused: "warn",
  file_management_cleanup_failed: "error",
  // Member 1: authentication and My Courses
  signup_failed: "warn",
  login_failed: "warn",
  session_validation_failed: "warn",
  unauthorized_access: "warn",
  logout_failed: "error",
  my_courses_add_failed: "error",
  my_courses_retrieval_failed: "error",
  // Member 2: course discovery
  course_catalog_retrieval_failed: "error",
  course_search_failed: "error",
  catalog_filter_options_retrieval_failed: "error",
  // Member 2: question bank (US-15a, US-16, US-20)
  question_grouping_rejected: "warn",
  question_grouping_failed: "error",
  question_bank_retrieval_failed: "error",
  question_search_failed: "error",
  // Member 3: course workspace and files
  course_retrieval_failed: "error",
  exam_list_retrieval_failed: "error",
  material_list_retrieval_failed: "error",
  file_record_not_found: "warn",
  physical_file_not_found: "error",
  file_open_failed: "error",
  invalid_storage_key: "error",
  // Member 4: catalog, file metadata, monitoring
  catalog_entry_rejected: "warn",
  catalog_entry_save_failed: "error",
  catalog_admin_retrieval_failed: "error",
  file_metadata_rejected: "warn",
  file_metadata_save_failed: "error",
  file_metadata_retrieval_failed: "error",
  monitoring_alert_triggered: "info",
  // Member 5: uploads
  upload_rejected: "warn",
  upload_storage_failed: "error",
  upload_record_failed: "error",
  upload_cleanup_failed: "error",
  upload_failed: "error",
  upload_options_retrieval_failed: "error",
  // Member 1 (Sprint 2): student submissions (US-13)
  submission_refused: "warn",
  submission_failed: "error",
  submission_rejected: "info",
  submission_review_failed: "error",
  submission_retrieval_failed: "error",
  unpublished_file_access: "warn",
  // Member 1 (Sprint 2): profile (US-04)
  profile_save_rejected: "warn",
  profile_save_failed: "error",
  profile_retrieval_failed: "error",
  // Member 1 (Sprint 2): password reset (US-03)
  password_reset_requested: "info",
  password_reset_rate_limited: "warn",
  password_reset_token_rejected: "warn",
  password_reset_rejected: "warn",
  password_reset_completed: "info",
  password_reset_failed: "error",
  password_reset_email_failed: "error",
  // An operation slower than the 1 s target (lib/timing.ts)
  slow_operation: "warn",
  // US-74: admin review of submissions (who reviewed is in userId; the reason is never logged)
  submission_reviewed: "info",
  submission_review_refused: "warn",
  submission_review_rate_limited: "warn",

  exam_processing_failed: "error",
  exam_processing_started: "info",
  exam_processing_completed: "info",
  exam_processing_record_failed: "error",
  exam_processing_retrieval_failed: "error",
  exam_retry_refused: "warn",
  // Question corrections: admins fix extracted or grouped questions (who corrected is in userId; question text is never logged)
  question_corrected: "info",
  question_correction_refused: "warn",
  question_correction_rate_limited: "warn",
  question_correction_failed: "error",
  question_correction_retrieval_failed: "error",

  // Member 2 (Sprint 3): reworded grouping (US-15b) and question reports (US-23). Report notes are never logged.
  question_grouping_completed: "info",
  question_grouping_low_confidence: "warn",
  question_report_submitted: "info",
  question_report_refused: "warn",
  question_report_rate_limited: "warn",
  question_report_failed: "error",
  question_report_retrieval_failed: "error",
  // Member 3 (Sprint 3): learning profile kept per course (US-33). Topics are never logged.
  learning_profile_retrieval_failed: "error",
  learning_profile_update_failed: "error",
  // Member 3 (Sprint 3): questions marked done (US-21). Only IDs, operations, and reasons are logged.
  question_progress_failed: "error",
  question_progress_retrieval_failed: "error",
  question_progress_saved: "info",
  question_progress_refused: "warn",
  question_progress_rate_limited: "warn",
  // Mustafa Ergaibi (Sprint 3): priorities (US-27). One line per ranking: IDs, a count, and reason codes only.
  priority_calculation_failed: "error",
  // Mustafa Ergaibi (Sprint 3): topic confidence (US-24). IDs, counts, reasons, and error types only; topics are never logged.
  topic_confidence_saved: "info",
  topic_confidence_refused: "warn",
  topic_confidence_rate_limited: "warn",
  topic_confidence_save_failed: "error",
  // Mustafa Ergaibi (Sprint 4): topic metrics, strongest and weakest topics (US-26). IDs, the failed read, a count, and
  // error types only; topics are never logged.
  topic_strengths_retrieval_failed: "error",
  topic_strengths_invalid_data: "warn",
  // Mustafa Ergaibi (Sprint 4): recommendations, what to study next (US-30). IDs, the failing step, a count, reason
  // codes, and error types only; topics are never logged.
  study_recommendation_failed: "error",
  study_recommendation_invalid_inputs: "warn",
  // Mustafa Ergaibi (Sprint 4): recommendations, topics marked as already covered (US-32). IDs, the new state, reason
  // codes, and error types only; topics are never logged.
  topic_covered_saved: "info",
  topic_covered_refused: "warn",
  topic_covered_rate_limited: "warn",
  topic_covered_save_failed: "error",
  // Mustafa Ergaibi (Sprint 4): mock exams balance weakness and exam importance (US-47). IDs, the failing step, counts,
  // reason codes, and error types only; topics and questions are never logged.
  mock_exam_weighting_failed: "error",
  mock_exam_weighting_invalid_inputs: "warn",
  // Mustafa Ergaibi (Sprint 4): timed mock exam mode (US-48). IDs, the time limit, counts, the trigger, and how late a
  // refused save was only; answers and questions are never logged.
  mock_exam_timer_started: "info",
  mock_exam_expired: "info",
  mock_exam_late_save_refused: "warn",
  // Sprint 4: configurable mock exams (US-45; Ali Shammakh, taken over by Mustafa Ergaibi). IDs, the settings (length,
  // difficulty, a topic count), reason codes, and error types only; question text and answers are never logged.
  mock_exam_created: "info",
  mock_exam_refused: "warn",
  mock_exam_rate_limited: "warn",
  mock_exam_failed: "error",
  mock_exam_retrieval_failed: "error",
  mock_exam_saved: "info",
  mock_exam_submitted: "info",
  mock_exam_save_refused: "warn",
  mock_exam_save_failed: "error",
  // Lea Tass (Sprint 4): practice sets that emphasize weak topics (US-31). IDs, the size, and the error type only; topics are never logged.
  practice_set_failed: "error",
  // Lea Tass (Sprint 4): helpful marks on advice (US-40). IDs, the new state, reason codes, and error types only.
  advice_vote_saved: "info",
  advice_vote_refused: "warn",
  advice_vote_rate_limited: "warn",
  advice_vote_failed: "error",
  advice_vote_retrieval_failed: "error",
  // Lea Tass (Sprint 4): replies beneath advice (US-41). IDs, reason codes, and error types only; reply text is never logged.
  advice_comment_saved: "info",
  advice_comment_refused: "warn",
  advice_comment_rate_limited: "warn",
  advice_comment_deleted: "info",
  advice_comment_delete_refused: "warn",
  advice_comment_failed: "error",
  advice_comment_retrieval_failed: "error",
  // Lea Tass (Sprint 4): alternative versions of a mock exam (US-46). IDs, the version number, reason codes, the count of
  // unused questions, and error types only; question text is never logged.
  mock_exam_version_created: "info",
  mock_exam_version_refused: "warn",
  mock_exam_version_failed: "error",
  // Mohammed Al-Haiqi (Sprint 4): marking mock exams against answer keys (US-49). IDs, counts and reasons only; never an
  // answer, a key point, or an explanation.
  mock_exam_marked: "info",
  mock_exam_marking_failed: "error",
  mock_exam_marking_evidence_failed: "error",
  answer_key_saved: "info",
  answer_key_removed: "info",
  answer_key_refused: "warn",
  answer_key_rate_limited: "warn",
  answer_key_save_failed: "error",
  // Mohammed Al-Haiqi (Sprint 4): the mock exam results report (US-50). IDs only.
  mock_results_rate_limited: "warn",
  mock_results_retrieval_failed: "error",

};

// A refusal event that was caused by the database failing is a real failure, so it is raised to error.
export function levelOf(event: LogEvent, context: LogContext = {}): LogLevel {
  const level = EVENT_LEVELS[event];
  return level === "warn" && context.reason === "db_error" ? "error" : level;
}

export const MAX_VALUE_LENGTH = 200;
// Defense in depth: no caller should log these, but if one ever does, the field is dropped.
const SENSITIVE_KEY = /pass(word)?|token|secret|cookie|e-?mail|authorization|api[-_]?key/i;
// A context field can never overwrite the line's own fields.
const RESERVED_KEYS = new Set(["event", "level", "timestamp"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

export function sanitizeContext(context: LogContext = {}): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || value === null || RESERVED_KEYS.has(key) || SENSITIVE_KEY.test(key)) continue;
    const text = String(value).replace(CONTROL_CHARACTERS, "");
    clean[key] = text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text;
  }
  return clean;
}

// The short code of a Node or Prisma error (ENOENT, EACCES, P2002), never its message.
export function errorCode(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,30}$/.test(code) ? code : undefined;
}

// Persistence is loaded lazily and only on the Node runtime, so this module never pulls Prisma into edge code.
type Store = { saveLogEntry: (line: LogLine) => Promise<void> };
let persistEnabled = process.env.NODE_ENV !== "test" && process.env.LOG_PERSIST !== "off";
// Unit tests can never reach the real store, even if a test switches persistence on without passing its own.
export const defaultStoreLoader = (): Promise<Store> =>
  process.env.NODE_ENV === "test" ? Promise.reject(new Error("The real log store is not loaded in tests")) : import("@/lib/log-store");
let loadStore: () => Promise<Store> = defaultStoreLoader;
let storePromise: Promise<Store> | undefined;
let warnedUnavailable = false;

// For tests: switch persistence on or off, or swap the store.
export function configureLogger(options: { persist?: boolean; store?: () => Promise<Store> }) {
  if (options.persist !== undefined) persistEnabled = options.persist;
  if (options.store) loadStore = options.store;
  storePromise = undefined;
  warnedUnavailable = false;
}

function persist(line: LogLine) {
  if (!persistEnabled || process.env.NEXT_RUNTIME === "edge") return;
  // Fire and forget: a request never waits for the write, and a failure only ever reaches the console, never logError.
  // The store module is loaded once; if loading fails, the next line tries again.
  storePromise ??= loadStore().catch(error => {
    storePromise = undefined;
    throw error;
  });
  void storePromise
    .then(store => store.saveLogEntry(line))
    .catch(() => {
      if (warnedUnavailable) return;
      warnedUnavailable = true;
      console.warn(JSON.stringify({ event: "log_persistence_unavailable", level: "warn", timestamp: new Date().toISOString() }));
    });
}

export function logError(event: LogEvent, context: LogContext = {}) {
  const line = { event, level: levelOf(event, context), timestamp: new Date().toISOString(), ...sanitizeContext(context) } as LogLine;
  console.error(JSON.stringify(line));
  try {
    persist(line);
  } catch {
    // Persisting must never break the caller.
  }
}
