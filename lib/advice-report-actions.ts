"use server";

import { redirect } from "next/navigation";
import { reportAdvice } from "@/lib/advice-reports";
import { requireUser } from "@/lib/auth";

// A student reports a piece of advice (US-43) and comes back to the feed page they came from with the outcome. A reason or
// note to fix, or the rate limit, sends them back to the report page instead. The note is never put in the URL.
export async function reportAdviceAction(formData: FormData) {
  const courseId = String(formData.get("courseId") ?? "");
  const feed = (id: string) => `/courses/${encodeURIComponent(id)}/advice`;
  const route = feed(courseId);
  const user = await requireUser(route);
  const result = await reportAdvice(user.id, {
    adviceId: String(formData.get("adviceId") ?? ""), reason: String(formData.get("reason") ?? ""), note: String(formData.get("note") ?? ""),
  });
  const page = Number(formData.get("page"));
  const back = Number.isInteger(page) && page > 1 ? `page=${page}&` : "";
  // On success the course comes from the stored advice, never from the form.
  if (result.ok) redirect(`${feed(result.courseId)}?${back}reported=1`);
  if (["invalid_reason", "note_too_long", "rate_limited", "unexpected"].includes(result.error)) {
    redirect(`${route}/${encodeURIComponent(String(formData.get("adviceId") ?? ""))}/report?${back}error=${result.error}`);
  }
  redirect(`${route}?${back}report_error=${result.error}`);
}
