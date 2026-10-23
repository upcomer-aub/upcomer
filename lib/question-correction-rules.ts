// Limits and messages for question corrections, shared by the service, the actions, and the pages.

export const MAX_QUESTION_TEXT_LENGTH = 2000;

export type CorrectionRefusal =
  | "not_found" | "group_not_found" | "same_group" | "already_split" | "not_corrected"
  | "text_required" | "text_too_long" | "text_unchanged" | "stale" | "rate_limited" | "unexpected";

const MESSAGES: Record<CorrectionRefusal, string> = {
  not_found: "That question doesn't exist anymore.",
  group_not_found: "That group doesn't exist anymore. The questions may have been regrouped; pick the group again.",
  same_group: "The question is already in that group.",
  already_split: "The question is already in a group of its own.",
  not_corrected: "The question's group was not corrected, so there is nothing to undo.",
  text_required: "Enter the question's text.",
  text_too_long: `Keep the question to ${MAX_QUESTION_TEXT_LENGTH} characters or fewer.`,
  text_unchanged: "The text is the same as before, so nothing was changed.",
  stale: "Someone else changed this question's text since you opened it. Check the text below and try again.",
  rate_limited: "Too many corrections in a minute. Wait a moment and try again.",
  unexpected: "Something went wrong. Please try again.",
};

// Any other value (for example one typed into the URL) gets the general message, never the value itself.
export const correctionMessage = (error: string) => (Object.hasOwn(MESSAGES, error) ? MESSAGES[error as CorrectionRefusal] : MESSAGES.unexpected);

export const SAVED_MESSAGES = {
  edit: "Text corrected. Students see the new text.",
  move: "Question moved. The counts and ranking are updated.",
  split: "Question split into a group of its own. The counts and ranking are updated.",
  reset: "The question is grouped by its text again.",
} as const;
export type CorrectionKindName = keyof typeof SAVED_MESSAGES;
export const savedMessage = (kind: string) => (Object.hasOwn(SAVED_MESSAGES, kind) ? SAVED_MESSAGES[kind as CorrectionKindName] : null);
export const REGROUP_FAILED_MESSAGE = "The correction was saved, but the questions could not be regrouped. Use \"Regroup and rank\" on the Question Bank page to try again.";

// Line endings differ between browsers and form encodings, so text is compared and stored with "\n" only.
export const normalizeLineEndings = (text: string) => text.replace(/\r\n?/g, "\n");
export const cleanCorrectedText = (text: string) => normalizeLineEndings(text).trim();

export const KIND_LABELS = { EDIT_TEXT: "Text corrected", MOVE: "Moved to another group", SPLIT: "Split into its own group", RESET: "Grouped by its text again" } as const;
