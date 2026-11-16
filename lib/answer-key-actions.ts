"use server";

import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { saveAnswerKey } from "@/lib/mock-marking";

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
