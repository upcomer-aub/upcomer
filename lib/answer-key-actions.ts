"use server";

import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { saveAnswerKey } from "@/lib/mock-marking";
import { reviewGeneratedRubric } from "@/lib/generated-rubrics";

// An admin saves or removes the answer key of one question group (US-49). The admin is always the session user. The key
// text is never put in a URL; a refusal comes back as its reason code only.
const field = (formData: FormData, name: string) => String(formData.get(name) ?? "");

export async function saveAnswerKeyAction(formData: FormData) {
  const courseId = field(formData, "courseId");
  const groupId = field(formData, "groupId");
  const list = `/admin/answer-keys/${encodeURIComponent(courseId)}`;
  const route = `${list}/${encodeURIComponent(groupId)}`;
  const admin = await requireAdmin(route);
  const remove = field(formData, "intent") === "remove";
  const result = await saveAnswerKey(admin.id, { courseId, groupId, keyPoints: field(formData, "keyPoints"), explanation: field(formData, "explanation"), remove });
  if (result.ok) redirect(`${list}?${result.removed ? "removed" : "saved"}=${encodeURIComponent(groupId)}`);
  redirect(result.error === "not_found" ? `${list}?error=not_found` : `${route}?error=${result.error}`);
}

export async function reviewGeneratedRubricAction(intent: "approve" | "reject", form: FormData) {
  const courseId = field(form, "courseId");
  const route = `/admin/answer-keys/${encodeURIComponent(courseId)}/generated`;
  const admin = await requireAdmin(route);
  const result = await reviewGeneratedRubric(admin.id, {
    courseId, id: field(form, "id"), intent, revision: field(form, "revision"),
    keyPoints: field(form, "keyPoints"), explanation: field(form, "explanation"),
  });
  const query = new URLSearchParams({ page: field(form, "page"), ...(result.ok ? { saved: "1" } : { error: result.error }) });
  redirect(`${route}?${query}`);
}
