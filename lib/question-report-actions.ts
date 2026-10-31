"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { reportQuestion } from "@/lib/question-reports";

// A student reports a question from the Upcomer Exam (US-23) and comes back to the same question with the outcome.
// The note is never put in the URL.
export async function reportQuestionAction(formData: FormData) {
  const route = `/courses/${encodeURIComponent(String(formData.get("courseId") ?? ""))}/exam`;
  const user = await requireUser(route);
  const result = await reportQuestion(user.id, {
    groupId: String(formData.get("groupId") ?? ""), reason: String(formData.get("reason") ?? ""), note: String(formData.get("note") ?? ""),
  });
  const position = Number(formData.get("position"));
  const anchor = Number.isInteger(position) && position > 0 ? `#question-${position}` : "";
  redirect(`${route}?${result.ok ? "reported=1" : `report_error=${result.error}`}${anchor}`);
}
