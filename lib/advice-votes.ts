import { AdviceStatus } from "@prisma/client";
import type { VoteRefusal } from "@/lib/advice-vote-rules";
import { db } from "@/lib/db";
import { errorCode, logError } from "@/lib/logger";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";

// US-40: a student marks advice as helpful, or undoes it. One AdviceVote row per student and advice (its primary key), so
// a mark can never count twice, however often or however fast it is sent. Students only ever see the count and whether
// they marked it themselves, never who else did, so an anonymous post (US-37) stays anonymous. Nothing here checks the
// caller: the action calls requireUser() first and passes the session user's ID.

// Marks per student per minute. Far above what a person clicks, so it only stops a script or a stolen session.
export const ADVICE_VOTE_WINDOW_MS = 60_000;
export const adviceVoteLimit = () => limitFromEnv("ADVICE_VOTE_RATE_LIMIT_PER_MINUTE", 30);

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

// `changed` is false when the advice already was as asked (a double submit, or a stale page).
export type VoteResult = { ok: true; helpful: boolean; changed: boolean } | { ok: false; error: VoteRefusal };

// Sets the student's helpful mark on one visible piece of advice of one course. Advice of another course, removed advice,
// and an unknown ID are all "not_found", so the answer never says whether an ID exists elsewhere. An author cannot mark
// their own advice.
export async function setAdviceHelpful(userId: string, courseId: string, adviceId: string, helpful: boolean): Promise<VoteResult> {
  const context = { userId, courseId: courseId.slice(0, 100) || undefined, adviceId: adviceId.slice(0, 100) || undefined };
  const refuse = (error: VoteRefusal): VoteResult => {
    logError("advice_vote_refused", { ...context, reason: error });
    return { ok: false, error };
  };
  const limit = checkRateLimit(`advice-vote:${userId}`, adviceVoteLimit(), ADVICE_VOTE_WINDOW_MS);
  if (!limit.ok) {
    logError("advice_vote_rate_limited", { ...context, retryAfterSeconds: String(limit.retryAfterSeconds) });
    return { ok: false, error: "rate_limited" };
  }
  try {
    const advice = adviceId && courseId
      ? await db.advice.findFirst({ where: { id: adviceId, courseId, status: AdviceStatus.VISIBLE }, select: { authorId: true } })
      : null;
    if (!advice) return refuse("not_found");
    if (advice.authorId === userId) return refuse("own_advice");
    // skipDuplicates: marking advice already marked is not an error, and two racing marks still make one row.
    const changed = helpful
      ? (await db.adviceVote.createMany({ data: [{ adviceId, userId }], skipDuplicates: true })).count > 0
      : (await db.adviceVote.deleteMany({ where: { adviceId, userId } })).count > 0;
    logError("advice_vote_saved", { ...context, helpful: String(helpful), changed: String(changed) });
    return { ok: true, helpful, changed };
  } catch (error) {
    // P2003: the advice was deleted between the check and the save.
    if (errorCode(error) === "P2003") return refuse("not_found");
    logError("advice_vote_failed", { ...context, helpful: String(helpful), errorType: errorType(error), errorCode: errorCode(error) });
    return { ok: false, error: "unexpected" };
  }
}

export type HelpfulCount = { count: number; mine: boolean };

// The helpful count of each given advice, and whether the viewer marked it. Advice without marks is { count: 0 }. Only
// counts leave this function, never who voted. Throws on a failed read, after logging it.
export async function getHelpfulCounts(adviceIds: string[], viewerId: string | null): Promise<Map<string, HelpfulCount>> {
  const counts = new Map(adviceIds.map(id => [id, { count: 0, mine: false }]));
  if (!adviceIds.length) return counts;
  try {
    const [groups, mine] = await Promise.all([
      db.adviceVote.groupBy({ by: ["adviceId"], where: { adviceId: { in: adviceIds } }, _count: { _all: true } }),
      viewerId ? db.adviceVote.findMany({ where: { userId: viewerId, adviceId: { in: adviceIds } }, select: { adviceId: true } }) : [],
    ]);
    for (const group of groups) counts.set(group.adviceId, { count: group._count._all, mine: false });
    for (const vote of mine) {
      const entry = counts.get(vote.adviceId);
      if (entry) entry.mine = true;
    }
    return counts;
  } catch (error) {
    logError("advice_vote_retrieval_failed", { userId: viewerId ?? undefined, errorType: errorType(error), errorCode: errorCode(error) });
    throw error;
  }
}
