import type { AdviceScope } from "@prisma/client";

// Display rules for advice from previous students (E3), shared by the service, the feed (US-38), and later the edit,
// report, and search pages. Pure functions only, so they are unit tested without a database.

export const ADVICE_PAGE_SIZE = 20;
// A question shown as an advice's target is cut to this many characters.
export const MAX_QUESTION_LABEL_LENGTH = 140;

// The author line of one advice. An anonymous author (US-37) and a deleted account never show a name.
export const ANONYMOUS_AUTHOR = "Anonymous student";
export const DELETED_AUTHOR = "Former student";

export function authorLabel(advice: { anonymous: boolean; authorName: string | null }) {
  if (advice.anonymous) return ANONYMOUS_AUTHOR;
  return advice.authorName?.trim() || DELETED_AUTHOR;
}

// What an advice is about, ready to show. A scope whose target is gone (deleted, unpublished, or never set) is shown as
// advice about the whole course, with targetGone so the page can say so without naming the target.
export type AdviceAbout =
  | { scope: "COURSE"; targetGone: boolean }
  | { scope: "EXAM"; label: string; fileId: string }
  | { scope: "SESSION"; label: string }
  | { scope: "TOPIC"; label: string }
  | { scope: "QUESTION"; label: string; groupId: string };

export type AdviceTargets = {
  scope: AdviceScope;
  // Only a published exam paper of the same course; the service passes null for any other file.
  file: { id: string; title: string } | null;
  term: { name: string } | null;
  topic: string | null;
  // Only a question of the same course; the service passes null for any other.
  questionGroup: { id: string; text: string } | null;
};

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function cutQuestion(text: string) {
  const line = oneLine(text);
  return line.length > MAX_QUESTION_LABEL_LENGTH ? `${line.slice(0, MAX_QUESTION_LABEL_LENGTH - 1).trimEnd()}…` : line;
}

export function adviceAbout(targets: AdviceTargets): AdviceAbout {
  const gone: AdviceAbout = { scope: "COURSE", targetGone: true };
  switch (targets.scope) {
    case "COURSE":
      return { scope: "COURSE", targetGone: false };
    case "EXAM":
      return targets.file && oneLine(targets.file.title) ? { scope: "EXAM", label: oneLine(targets.file.title), fileId: targets.file.id } : gone;
    case "SESSION":
      return targets.term && oneLine(targets.term.name) ? { scope: "SESSION", label: oneLine(targets.term.name) } : gone;
    case "TOPIC":
      return targets.topic && oneLine(targets.topic) ? { scope: "TOPIC", label: oneLine(targets.topic) } : gone;
    case "QUESTION":
      return targets.questionGroup && oneLine(targets.questionGroup.text)
        ? { scope: "QUESTION", label: cutQuestion(targets.questionGroup.text), groupId: targets.questionGroup.id }
        : gone;
    default:
      return gone;
  }
}

// The words before an advice's target, for example "About the exam: Final 2024".
export const SCOPE_PREFIX: Record<AdviceScope, string> = {
  COURSE: "About the whole course",
  EXAM: "About the exam",
  SESSION: "About the term",
  TOPIC: "About the topic",
  QUESTION: "About the question",
};

// A resource link is shown only when it is an https URL (US-35 refuses the rest when advice is published; this keeps
// an older or hand-written row from showing a javascript:, data:, or http: link). Returns the normalized URL or null.
export function safeResourceUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.hostname && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

// A requested page number, clamped to the pages there are; anything that is not a whole number gives the first page.
export function clampPage(requested: unknown, total: number, pageSize = ADVICE_PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const number = Number(requested);
  const page = Number.isInteger(number) && number > 0 ? Math.min(number, totalPages) : 1;
  return { page, totalPages };
}

// "12 Nov 2026", in UTC so the server and the tests agree.
export const adviceDate = (value: Date) => value.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
