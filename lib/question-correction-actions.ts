"use server";

import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { correctQuestion, type Correction } from "@/lib/question-corrections";

const field = (formData: FormData, name: string) => String(formData.get(name) ?? "");

// Every action returns to the question's page with the outcome. The question's text is never put in the URL.
async function run(formData: FormData, build: (questionId: string) => Correction) {
  const courseId = field(formData, "courseId");
  const questionId = field(formData, "questionId");
  const route = `/admin/questions/${encodeURIComponent(courseId)}/${encodeURIComponent(questionId)}`;
  const admin = await requireAdmin(route);
  const correction = build(questionId);
  const result = await correctQuestion(admin.id, courseId, correction);
  const outcome: Record<string, string> = result.ok ? { saved: correction.kind, ...(result.regrouped ? {} : { regroup: "failed" }) } : { error: result.error };
  redirect(`${route}?${new URLSearchParams(outcome)}`);
}

export async function editQuestionTextAction(formData: FormData) {
  await run(formData, questionId => ({ kind: "edit", questionId, text: field(formData, "text"), previousText: field(formData, "previousText") }));
}

export async function moveQuestionAction(formData: FormData) {
  await run(formData, questionId => ({ kind: "move", questionId, groupId: field(formData, "groupId") }));
}

export async function splitQuestionAction(formData: FormData) {
  await run(formData, questionId => ({ kind: "split", questionId }));
}

export async function resetQuestionGroupAction(formData: FormData) {
  await run(formData, questionId => ({ kind: "reset", questionId }));
}
