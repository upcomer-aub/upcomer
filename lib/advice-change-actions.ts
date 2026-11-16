"use server";

import { redirect } from "next/navigation";
import { deleteAdvice, editAdvice } from "@/lib/advice-changes";
import { requireUser } from "@/lib/auth";

// An author saves or deletes their own advice (US-36) and comes back to the course's advice with the outcome. The advice
// text is never put in a URL. Which course the advice is in is taken from the stored advice, never from the form; the
// form's course only decides where a refusal is shown. Both forms sit on the edit page, which is where their posts go.

const field = (formData: FormData, name: string) => String(formData.get(name) ?? "");
const feedRoute = (courseId: string) => `/courses/${encodeURIComponent(courseId)}/advice`;
// The feed page the author came from, so they land back where they were; anything else is page 1.
const backTo = (formData: FormData) => {
  const page = Number(formData.get("page"));
  return Number.isInteger(page) && page > 1 ? `page=${page}&` : "";
};

export async function editAdviceAction(formData: FormData) {
  const courseId = field(formData, "courseId");
  const adviceId = field(formData, "adviceId");
  const editRoute = `${feedRoute(courseId)}/${encodeURIComponent(adviceId)}/edit`;
  const user = await requireUser(editRoute);
  const result = await editAdvice(user.id, {
    adviceId, title: field(formData, "title"), body: field(formData, "body"), resourceUrl: field(formData, "resourceUrl"), resourceTitle: field(formData, "resourceTitle"),
  });
  if (result.ok) redirect(`${feedRoute(result.courseId)}?${backTo(formData)}${result.changed ? "edited" : "unchanged"}=1`);
  // Advice that is not the author's (or no longer shown) has no edit page to go back to.
  if (result.error === "not_found") redirect(`${feedRoute(courseId)}?change_error=not_found`);
  redirect(`${editRoute}?${backTo(formData)}error=${result.error}`);
}

export async function deleteAdviceAction(formData: FormData) {
  const courseId = field(formData, "courseId");
  const adviceId = field(formData, "adviceId");
  const user = await requireUser(`${feedRoute(courseId)}/${encodeURIComponent(adviceId)}/edit`);
  const result = await deleteAdvice(user.id, adviceId);
  redirect(result.ok ? `${feedRoute(result.courseId)}?${backTo(formData)}deleted=1` : `${feedRoute(courseId)}?change_error=${result.error}`);
}
