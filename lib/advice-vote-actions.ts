"use server";

import { redirect } from "next/navigation";
import { keptAdviceQuery, parseHelpful } from "@/lib/advice-vote-rules";
import { setAdviceHelpful } from "@/lib/advice-votes";
import { requireUser } from "@/lib/auth";
import { logError } from "@/lib/logger";

// A student marks advice as helpful, or undoes it (US-40), and comes back to the same search, filters, sort, and page with
// the outcome. The student is always the session's: a user ID in the form is never read.
export async function setAdviceHelpfulAction(formData: FormData) {
  const courseId = String(formData.get("courseId") ?? "");
  const route = `/courses/${encodeURIComponent(courseId)}/advice`;
  const user = await requireUser(route);
  const adviceId = String(formData.get("adviceId") ?? "");
  const back = keptAdviceQuery(String(formData.get("returnTo") ?? ""));
  const helpful = parseHelpful(formData.get("helpful"));
  if (helpful === null) {
    logError("advice_vote_refused", { userId: user.id, courseId: courseId.slice(0, 100), adviceId: adviceId.slice(0, 100), reason: "invalid_value" });
    back.set("helpful_error", "invalid_value");
  } else {
    const result = await setAdviceHelpful(user.id, courseId, adviceId, helpful);
    if (result.ok) back.set("helpful", result.helpful ? "marked" : "unmarked");
    else back.set("helpful_error", result.error);
  }
  redirect(`${route}?${back}`);
}
