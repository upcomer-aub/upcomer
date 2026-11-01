// The confidence scale, its conversion to weakness, and the form's validation (US-24), shared by the service, the action,
// and the page. Nothing here reads the database.

export const CONFIDENCE_SCALE = [
  { rating: 1, label: "Not confident" },
  { rating: 2, label: "Slightly confident" },
  { rating: 3, label: "Somewhat confident" },
  { rating: 4, label: "Confident" },
  { rating: 5, label: "Very confident" },
] as const;
export const SKIP = "skip";
// Each topic's radio group is named RATING_FIELD + its topic key.
export const RATING_FIELD = "rating:";

// 1 (not confident) is the weakest, 1; 5 (very confident) the strongest, 0; 3 is the middle, 0.5.
export const weaknessFromRating = (rating: number) => (5 - rating) / 4;

// One topic of the form: a rating from 1 to 5, or null when skipped.
export type TopicRating = { topicKey: string; rating: number | null };
export type ConfidenceRefusal = "unknown_topic" | "invalid_rating" | "no_ratings" | "rate_limited" | "unexpected";
export type ParsedRatings = { ok: true; ratings: TopicRating[] } | { ok: false; error: "unknown_topic" | "invalid_rating" | "no_ratings" };

// Reads the form's rating fields. Every one must name a topic of this course (so a topic of another course is refused
// too) and hold a whole rating from 1 to 5 or "skip"; otherwise the whole form is refused and nothing is saved. Topics
// missing from the form are left as they are. Other fields (courseId, Next.js's own) are ignored.
export function parseRatings(entries: Iterable<[string, FormDataEntryValue]>, courseTopicKeys: ReadonlySet<string>): ParsedRatings {
  const ratings = new Map<string, number | null>();
  for (const [name, value] of entries) {
    if (!name.startsWith(RATING_FIELD)) continue;
    const key = name.slice(RATING_FIELD.length);
    if (!courseTopicKeys.has(key)) return { ok: false, error: "unknown_topic" };
    if (typeof value !== "string" || ratings.has(key)) return { ok: false, error: "invalid_rating" };
    if (value === SKIP) ratings.set(key, null);
    else if (/^[1-5]$/.test(value)) ratings.set(key, Number(value));
    else return { ok: false, error: "invalid_rating" };
  }
  if (!ratings.size) return { ok: false, error: "no_ratings" };
  return { ok: true, ratings: [...ratings].map(([topicKey, rating]) => ({ topicKey, rating })) };
}

const MESSAGES: Record<ConfidenceRefusal, string> = {
  unknown_topic: "One of those topics isn't part of this course. Reload the page and try again.",
  invalid_rating: "Choose a rating from 1 to 5, or Skip, for each topic.",
  no_ratings: "Choose a rating, or Skip, for at least one topic.",
  rate_limited: "Too many saves in a minute. Wait a moment and try again.",
  unexpected: "Your ratings could not be saved. Please try again.",
};

// Any other value (for example one typed into the URL) gets the general message, never the value itself.
export const confidenceMessage = (error: string) => (Object.hasOwn(MESSAGES, error) ? MESSAGES[error as ConfidenceRefusal] : MESSAGES.unexpected);
