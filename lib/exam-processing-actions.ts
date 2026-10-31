"use server";

import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { retryFailedExam } from "@/lib/exam-processing";

export async function retryExamAction(form: FormData) {
  await requireAdmin("/admin/processing");
  const fileId = String(form.get("fileId") ?? "");
  const runId = form.get("runId");
  const result = typeof runId === "string" && runId ? await retryFailedExam(fileId, runId) : await retryFailedExam(fileId);
  redirect(`/admin/processing?${"runId" in result ? "retried=1" : `error=${result.reason}`}`);
}
