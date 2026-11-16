// Timed mock exams (US-48): the deadline rules, shared by the server, the actions and the browser countdown. Pure: the
// current time is always passed in, and it is always the server's. The browser never decides how much time is left; it
// only counts down from the `remainingMs` the server gave it.

// The time limits the form offers, in minutes. No time limit is the default.
export const MOCK_EXAM_TIME_LIMITS = [10, 15, 20, 30, 45, 60, 90, 120, 180] as const;
// A save that arrives up to this long after the deadline is still accepted, for network delay. Later ones are refused.
export const MOCK_EXAM_GRACE_MS = 5_000;
// The browser's final save at zero may reach the server slightly before the server's deadline: from this long before it,
// a `finish` save ends the exam. Sent earlier, it is only a save.
export const FINISH_TOLERANCE_MS = 2_000;
// The form's hint: about this many minutes a question.
export const MINUTES_PER_QUESTION = 3;
// The browser saves changed answers this often, and warns at these times left.
export const AUTOSAVE_INTERVAL_MS = 10_000;
export const WARNING_TIMES_MS = [5 * 60_000, 60_000, 0] as const;

export const isTimeLimit = (minutes: number): minutes is (typeof MOCK_EXAM_TIME_LIMITS)[number] => (MOCK_EXAM_TIME_LIMITS as readonly number[]).includes(minutes);

// The smallest offered limit that gives about three minutes a question (the largest when none does). Only a hint.
export function suggestedTimeLimit(length: number): number {
  const wanted = Math.max(0, Number.isFinite(length) ? length : 0) * MINUTES_PER_QUESTION;
  return MOCK_EXAM_TIME_LIMITS.find(limit => limit >= wanted) ?? MOCK_EXAM_TIME_LIMITS[MOCK_EXAM_TIME_LIMITS.length - 1];
}

export const deadlineFrom = (startedAt: Date, minutes: number) => new Date(startedAt.getTime() + minutes * 60_000);
// The time left to show: never negative.
export const timeLeftMs = (deadlineAt: Date, now: Date) => Math.max(0, deadlineAt.getTime() - now.getTime());
// A save is accepted until the deadline plus the grace, inclusive.
export const acceptsSave = (deadlineAt: Date | null, now: Date) => deadlineAt === null || now.getTime() <= deadlineAt.getTime() + MOCK_EXAM_GRACE_MS;
// After the grace the exam has ended, whether or not anything was sent: it is finalized the next time it is touched.
export const isExpired = (deadlineAt: Date | null, now: Date) => !acceptsSave(deadlineAt, now);
// A `finish` save ends the exam when the server's time is at the deadline (within the tolerance).
export const finishesNow = (deadlineAt: Date | null, now: Date) => deadlineAt !== null && now.getTime() >= deadlineAt.getTime() - FINISH_TOLERANCE_MS;
// The oldest deadline that still accepts a save at `now`: for the database's `deadlineAt >= …` filter.
export const oldestOpenDeadline = (now: Date) => new Date(now.getTime() - MOCK_EXAM_GRACE_MS);

// "12:34", or "1:02:03" from an hour up. Rounded up to the whole second, so it reads 0:00 only when the time is up.
export function formatTimeLeft(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const [hours, minutes, seconds] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const two = (value: number) => String(value).padStart(2, "0");
  return hours ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

export const timeLimitLabel = (minutes: number) => (minutes % 60 === 0 ? `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}` : `${minutes} minutes`);

// How urgent the time left is, for the countdown's style.
export const timerLevel = (ms: number): "normal" | "warning" | "urgent" => (ms <= WARNING_TIMES_MS[1] ? "urgent" : ms <= WARNING_TIMES_MS[0] ? "warning" : "normal");

// What a screen reader is told when the time left passes a warning time between two ticks: only at 5 minutes, 1 minute
// and zero, never every second. When several are passed at once (a tab that slept), the latest one.
export function crossedWarning(previousMs: number, ms: number): string | null {
  const crossed = WARNING_TIMES_MS.filter(time => previousMs > time && ms <= time);
  if (!crossed.length) return null;
  const latest = Math.min(...crossed);
  return latest === 0 ? "Time is up." : latest === 60_000 ? "1 minute left." : "5 minutes left.";
}

export const TIME_UP_NOTICE = "Time is up — your answers were submitted automatically.";
export const TIME_UP_UNSAVED_NOTICE = "Time is up. Your last changes could not reach the server, so the answers saved before were submitted.";
