"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { generateMockAiFeedback } from "@/lib/mock-ai-feedback";

export async function generateMockAiFeedbackAction(courseId: string, mockExamId: string, itemId: string, form: FormData) {
  const route = `/courses/${encodeURIComponent(courseId)}/mock-exams/${encodeURIComponent(mockExamId)}/results`;
  const user = await requireUser(route);
  const result = await generateMockAiFeedback(user.id, courseId, mockExamId, itemId, form.get("consent") === "deepseek");
  const query = result.ok ? "" : `?${new URLSearchParams({ aiError: result.error, item: itemId })}`;
  redirect(`${route}${query}#feedback-${encodeURIComponent(itemId)}`);
}
