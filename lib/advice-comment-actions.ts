"use server";

import { redirect } from "next/navigation";
import { addAdviceComment, deleteAdviceComment } from "@/lib/advice-comments";
import { keptAdviceQuery } from "@/lib/advice-vote-rules";
import { requireUser } from "@/lib/auth";

// US-41: post a reply beneath advice, or delete one. The user is always the session's (requireUser first); a user ID or a
// role in the form is never read. The student comes back to the same search, filters, sort and page, with the post's thread
// open (`thread`) and the outcome. The reply text is never put in the URL.

const field = (formData: FormData, name: string) => String(formData.get(name) ?? "");
const back = (formData: FormData, courseId: string, adviceId: string, outcome: Record<string, string>) => {
  const query = keptAdviceQuery(field(formData, "returnTo"));
  if (adviceId) query.set("thread", adviceId.slice(0, 100));
  for (const [key, value] of Object.entries(outcome)) query.set(key, value);
  return `/courses/${encodeURIComponent(courseId)}/advice?${query}`;
};

export async function addAdviceCommentAction(formData: FormData) {
  const courseId = field(formData, "courseId");
  const user = await requireUser(`/courses/${encodeURIComponent(courseId)}/advice`);
  const adviceId = field(formData, "adviceId");
  const result = await addAdviceComment(user.id, courseId, adviceId, field(formData, "body"));
  redirect(back(formData, courseId, adviceId, result.ok ? { comment: "added" } : { comment_error: result.error }));
}

export async function deleteAdviceCommentAction(formData: FormData) {
  const courseId = field(formData, "courseId");
  const user = await requireUser(`/courses/${encodeURIComponent(courseId)}/advice`);
  const result = await deleteAdviceComment({ id: user.id, role: user.role }, courseId, field(formData, "commentId"));
  redirect(back(formData, courseId, result.ok ? result.adviceId : field(formData, "adviceId"), result.ok ? { comment: "deleted" } : { comment_error: result.error }));
}
