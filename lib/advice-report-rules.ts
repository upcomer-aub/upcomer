import type { AdviceReportReason } from "@prisma/client";

// Reasons, limits, and messages for advice reports (US-43), shared by the service, the actions, and the pages.

export const MAX_ADVICE_REPORT_NOTE_LENGTH = 500;

// In the order the form lists them.
export const ADVICE_REPORT_REASONS: Array<{ value: AdviceReportReason; label: string }> = [
  { value: "OFFENSIVE", label: "It is insulting, harassing, or hateful" },
  { value: "SPAM", label: "It is advertising, or not about the course" },
  { value: "PERSONAL_INFO", label: "It names or shares details of a person" },
  { value: "ACADEMIC_DISHONESTY", label: "It encourages cheating or breaking course rules" },
  { value: "OTHER", label: "Something else" },
];

// Short forms for the admin queue.
export const ADVICE_REPORT_REASON_LABELS: Record<AdviceReportReason, string> = {
  OFFENSIVE: "Offensive",
  SPAM: "Spam or off-topic",
  PERSONAL_INFO: "Personal information",
  ACADEMIC_DISHONESTY: "Academic dishonesty",
  OTHER: "Other",
};

export const isAdviceReportReason = (value: string): value is AdviceReportReason => Object.hasOwn(ADVICE_REPORT_REASON_LABELS, value);

export type AdviceReportRefusal = "invalid_reason" | "note_too_long" | "not_found" | "own_advice" | "duplicate" | "rate_limited" | "unexpected";

const MESSAGES: Record<AdviceReportRefusal, string> = {
  invalid_reason: "Choose what is wrong with the advice.",
  note_too_long: `Keep the details to ${MAX_ADVICE_REPORT_NOTE_LENGTH} characters or fewer.`,
  not_found: "That advice is no longer shown, so there is nothing to report.",
  own_advice: "This is your own advice. To take it down, edit or delete it instead.",
  duplicate: "You already reported this advice. An admin will check it.",
  rate_limited: "Too many reports in a minute. Wait a moment and try again.",
  unexpected: "Your report could not be sent. Please try again.",
};

// Any other value (for example one typed into the URL) gets the general message, never the value itself.
export const adviceReportMessage = (error: string) =>
  (Object.hasOwn(MESSAGES, error) ? MESSAGES[error as AdviceReportRefusal] : MESSAGES.unexpected);
