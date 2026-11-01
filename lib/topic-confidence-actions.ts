"use server";

import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getCourseById } from "@/lib/courses";
import { saveTopicConfidence } from "@/lib/topic-confidence";

// A student saves their confidence in a course's topics (US-24) and comes back to the form with the outcome. The student
// is always the session's: a user ID in the form is never read. An unknown course gives the not-found page.
export async function saveTopicConfidenceAction(formData: FormData) {
  const courseId = String(formData.get("courseId") ?? "");
  const route = `/courses/${encodeURIComponent(courseId)}/confidence`;
  const user = await requireUser(route);
  if (!(await getCourseById(courseId))) notFound();
  const result = await saveTopicConfidence(user.id, courseId, formData.entries());
  redirect(`${route}?${result.ok ? "saved=1" : `error=${result.error}`}`);
}
