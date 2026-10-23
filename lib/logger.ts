type LogEvent =
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
  | "question_corrected"
  | "question_correction_refused"
  | "question_correction_rate_limited"
  | "question_correction_failed"
  | "question_correction_retrieval_failed";

export type { LogEvent };
export type LogLevel = "error" | "warn" | "info";
export type LogContext = Record<string, string | undefined>;
export type LogLine = { event: LogEvent; level: LogLevel; timestamp: string } & Record<string, string>;

// Severity of every event (US-87). error: something failed that should not have. warn: an expected refusal. info: notable, not a problem.
export const EVENT_LEVELS: Record<LogEvent, LogLevel> = {
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
  // Question corrections: admins fix extracted or grouped questions (who corrected is in userId; question text is never logged)
  question_corrected: "info",
  question_correction_refused: "warn",
  question_correction_rate_limited: "warn",
  question_correction_failed: "error",
  question_correction_retrieval_failed: "error",
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
