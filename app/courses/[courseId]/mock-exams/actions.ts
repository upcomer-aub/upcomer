"use server";

import { redirect } from "next/navigation";
import { getCurrentUser, requireUser } from "@/lib/auth";
import { createMockExam, saveMockExam, startMockExam } from "@/lib/mock-exams";
import type { MockExamError, MockExamFormValues, SittingError } from "@/lib/mock-exam-rules";
import { markMockExam } from "@/lib/mock-marking";

export type MockExamFormState = { status: "idle" | "error"; error?: MockExamError; available?: number; values?: MockExamFormValues };

const field = (formData: FormData, name: string) => String(formData.get(name) ?? "");

// The exam's student is always the session user: any user ID in the form is ignored. On a refusal the typed settings come
// back in the state, so the form keeps them. On success the student goes straight to the exam; `same=1` tells the exam
// page that the difficulty could not choose between the questions.
export async function createMockExamAction(_previous: MockExamFormState, formData: FormData): Promise<MockExamFormState> {
  const courseId = field(formData, "courseId");
  const route = `/courses/${encodeURIComponent(courseId)}/mock-exams`;
  const user = await requireUser(route);
  const values: MockExamFormValues = {
    length: field(formData, "length"), difficulty: field(formData, "difficulty"), topics: formData.getAll("topic").map(String),
    includeGenerated: formData.get("includeGenerated") === "on", timeLimit: field(formData, "timeLimit"),
  };
  const result = await createMockExam(user.id, { courseId, ...values });
  if (!result.ok) return { status: "error", error: result.error, available: result.available, values };
  redirect(`${route}/${encodeURIComponent(result.id)}${result.difficultyApplied ? "" : "?same=1"}`);
}

const examRoute = (formData: FormData) => `/courses/${encodeURIComponent(field(formData, "courseId"))}/mock-exams/${encodeURIComponent(field(formData, "mockExamId"))}`;
const answersOf = (formData: FormData) => {
  const answers: Record<string, string> = {};
  for (const [key, value] of formData.entries()) if (key.startsWith("answer_") && typeof value === "string") answers[key.slice("answer_".length)] = value;
  return answers;
};

// Starts the session student's timed exam (US-48): a plain POST form. The server sets the start and the deadline.
export async function startMockExamAction(formData: FormData) {
  const route = examRoute(formData);
  const user = await requireUser(route);
  const result = await startMockExam(user.id, field(formData, "mockExamId"));
  redirect(result.ok ? route : `${route}?${new URLSearchParams({ error: result.error })}`);
}

export type AutosaveResult = { ok: true; remainingMs?: number; timedOut: boolean } | { ok: false; error: SittingError | "signed_out" };

// The countdown's saves (US-48): every few seconds, and the final one at zero (`intent=finish`). It answers instead of
// redirecting, so the page and what is typed stay as they are, and it returns only the server's time left: never a
// question or an answer. A student whose session ended is told so; they are not sent away from their typed answers.
export async function autosaveMockExamAction(formData: FormData): Promise<AutosaveResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "signed_out" };
  const result = await saveMockExam(user.id, field(formData, "mockExamId"), answersOf(formData), field(formData, "intent") === "finish" ? "finish" : "save");
  return result.ok ? { ok: true, remainingMs: result.remainingMs, timedOut: result.timedOut === true } : { ok: false, error: result.error };
}

// "Save progress" and "Submit exam" are two buttons of one form; the clicked one's value arrives as `intent`.
export async function saveMockExamAction(formData: FormData) {
  const mockExamId = field(formData, "mockExamId");
  const route = examRoute(formData);
  const user = await requireUser(route);
  const answers = answersOf(formData);
  const submit = field(formData, "intent") === "submit";
  const result = await saveMockExam(user.id, mockExamId, answers, submit);
  // US-49: a submitted exam is marked at once. If marking fails the exam stays submitted and the exam page marks it on
  // its next load (markMockExam is safe to repeat).
  if (result.ok && submit) await markMockExam(user.id, mockExamId);
  redirect(`${route}?${new URLSearchParams(result.ok ? { [submit ? "submitted" : "saved"]: "1" } : { error: result.error })}`);
}
