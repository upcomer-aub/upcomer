"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createAlternativeMockExam } from "@/lib/mock-exam-versions";

// US-46: "Make an alternative version" on a mock exam. The student is always the session's; a user ID in the form is never
// read. On success the student goes to the new version (in the exam's own course); on a refusal they stay on the exam with
// the reason, and for "not enough questions" the count of unused questions and the length needed (numbers only).
export async function createAlternativeMockExamAction(formData: FormData) {
  const courseId = String(formData.get("courseId") ?? "");
  const mockExamId = String(formData.get("mockExamId") ?? "");
  const route = `/courses/${encodeURIComponent(courseId)}/mock-exams/${encodeURIComponent(mockExamId)}`;
  const user = await requireUser(route);
  const result = await createAlternativeMockExam(user.id, mockExamId);
  if (result.ok) {
    const query = new URLSearchParams({ version: "new", ...(result.difficultyApplied ? {} : { same: "1" }) });
    redirect(`/courses/${encodeURIComponent(result.courseId)}/mock-exams/${encodeURIComponent(result.id)}?${query}`);
  }
  const query = new URLSearchParams({ version_error: result.error });
  if (result.available !== undefined) query.set("available", String(result.available));
  if (result.length !== undefined) query.set("length", String(result.length));
  redirect(`${route}?${query}`);
}
