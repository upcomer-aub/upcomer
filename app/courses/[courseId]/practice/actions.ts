"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { generateAiPracticeQuestions } from "@/lib/ai-practice";
import { recordPracticeOutcome } from "@/lib/learning-evidence";
import { generatePracticeQuestions } from "@/lib/practice-generation";
import { parseGenerationSettings } from "@/lib/practice-generation-rules";

export async function recordPracticeAction(form: FormData) {
  const courseId = String(form.get("courseId") ?? "");
  const route = `/courses/${encodeURIComponent(courseId)}/practice`;
  const user = await requireUser(route);
  const result = await recordPracticeOutcome(user.id, courseId, {
    eventId: String(form.get("eventId") ?? ""), questionId: String(form.get("questionId") ?? ""), outcome: String(form.get("outcome") ?? ""),
  });
  redirect(`${route}?${result.ok ? "saved=1" : `error=${result.error}`}`);
}

export async function generatePracticeAction(form: FormData) {
  const courseId = String(form.get("courseId") ?? "");
  const route = `/courses/${encodeURIComponent(courseId)}/practice/generated`;
  const user = await requireUser(route);
  const settings = parseGenerationSettings(form);
  if (!settings) redirect(`${route}?error=invalid_settings`);
  const result = form.get("mode") === "ai"
    ? await generateAiPracticeQuestions(user.id, courseId, settings)
    : await generatePracticeQuestions(user.id, courseId, settings);
  if (result.ok) redirect(`${route}?generated=${result.questions.length}`);
  const query = new URLSearchParams({
    error: result.error, count: String(settings.count), difficulty: settings.difficulty, topicKey: settings.topicKey ?? "",
  });
  redirect(`${route}?${query}`);
}
