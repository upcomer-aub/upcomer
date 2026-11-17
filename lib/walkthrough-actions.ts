"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { generateWalkthrough } from "@/lib/walkthroughs";

// US-51: "Generate walkthrough" / "Try again" on a past-exam question. The student is always the session's (requireUser()
// before anything else runs; a user ID in the form is never read). Afterwards the student comes back to the walkthrough page;
// a refusal adds only its reason code, which the page turns into a fixed message.
export async function generateWalkthroughAction(formData: FormData) {
  const courseId = String(formData.get("courseId") ?? "");
  const questionId = String(formData.get("questionId") ?? "");
  const route = `/courses/${encodeURIComponent(courseId)}/questions/${encodeURIComponent(questionId)}/walkthrough`;
  const user = await requireUser(route);
  const result = await generateWalkthrough(user.id, courseId, questionId);
  redirect(result.ok ? route : `${route}?${new URLSearchParams({ error: result.error })}`);
}
