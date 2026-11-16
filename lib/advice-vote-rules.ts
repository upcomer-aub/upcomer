// US-40: marking advice as helpful, and sorting advice by it. Pure rules shared by the service, the action, and the page.

// The form sets a state instead of toggling, so a double submit or a stale page gives the same result.
export const HELPFUL = "1";
export const NOT_HELPFUL = "0";

// The advice feed's orders: newest first (the default, as before US-40) or most helpful first.
export const ADVICE_SORTS = ["newest", "helpful"] as const;
export type AdviceSort = (typeof ADVICE_SORTS)[number];
export const parseAdviceSort = (value: unknown): AdviceSort => (value === "helpful" ? "helpful" : "newest");

export type VoteRefusal = "invalid_value" | "not_found" | "own_advice" | "rate_limited" | "unexpected";

const MESSAGES: Record<VoteRefusal, string> = {
  invalid_value: "That helpful mark could not be read. Please try again.",
  not_found: "That advice is no longer available.",
  own_advice: "You cannot mark your own advice as helpful.",
  rate_limited: "Too many helpful marks in a minute. Please wait a moment and try again.",
  unexpected: "Your helpful mark could not be saved. Please try again.",
};
export const voteMessage = (error: string) => (Object.hasOwn(MESSAGES, error) ? MESSAGES[error as VoteRefusal] : MESSAGES.unexpected);

// "1" marks helpful, "0" undoes the mark; anything else is refused.
export function parseHelpful(value: FormDataEntryValue | null): boolean | null {
  if (value === HELPFUL) return true;
  if (value === NOT_HELPFUL) return false;
  return null;
}

// The advice page's query parameters that a vote keeps when it sends the student back: the search, the filters, the sort,
// and the page. Anything else (including an old outcome notice) is dropped, and each value is capped.
const KEPT = ["q", "topic", "examId", "termId", "sort", "page"] as const;
export function keptAdviceQuery(raw: string): URLSearchParams {
  const from = new URLSearchParams(raw.slice(0, 1000));
  const kept = new URLSearchParams();
  for (const key of KEPT) {
    const value = from.get(key);
    if (value) kept.set(key, value.slice(0, 200));
  }
  return kept;
}

export const helpfulLabel = (count: number) => `${count} ${count === 1 ? "student" : "students"} found this helpful`;
