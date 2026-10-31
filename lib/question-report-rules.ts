import type { QuestionReportReason } from "@prisma/client";

// Reasons, limits, and messages for question reports (US-23), shared by the service, the actions, and the pages.

export const MAX_REPORT_NOTE_LENGTH = 500;

// In the order the form lists them.
export const REPORT_REASONS: Array<{ value: QuestionReportReason; label: string }> = [
  { value: "WRONG_GROUPING", label: "Different questions are shown as one, or this question is shown twice" },
  { value: "WRONG_TEXT", label: "The text is wrong, cut off, or garbled" },
  { value: "NOT_A_QUESTION", label: "This is not a question" },
  { value: "OTHER", label: "Something else" },
];

// Short forms for the admin queue.
export const REASON_LABELS: Record<QuestionReportReason, string> = {
  WRONG_GROUPING: "Wrong grouping",
  WRONG_TEXT: "Wrong text",
  NOT_A_QUESTION: "Not a question",
  OTHER: "Other",
};

export const isReportReason = (value: string): value is QuestionReportReason => Object.hasOwn(REASON_LABELS, value);

export type ReportRefusal = "invalid_reason" | "note_too_long" | "not_found" | "duplicate" | "rate_limited" | "unexpected";

const MESSAGES: Record<ReportRefusal, string> = {
  invalid_reason: "Choose what is wrong with the question.",
  note_too_long: `Keep the details to ${MAX_REPORT_NOTE_LENGTH} characters or fewer.`,
  not_found: "That question isn't on this exam anymore. Reload the page and try again.",
  duplicate: "You already reported this question. An admin will check it.",
  rate_limited: "Too many reports in a minute. Wait a moment and try again.",
  unexpected: "Your report could not be sent. Please try again.",
};

// Any other value (for example one typed into the URL) gets the general message, never the value itself.
export const reportMessage = (error: string) => (Object.hasOwn(MESSAGES, error) ? MESSAGES[error as ReportRefusal] : MESSAGES.unexpected);
