"use server";

import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { retryFailedExam } from "@/lib/exam-processing";

export async function retryExamAction(form: FormData) {
  await requireAdmin("/admin/processing");
  const result = await retryFailedExam(String(form.get("fileId") ?? ""));
  redirect(`/admin/processing?${"runId" in result ? "retried=1" : `error=${result.reason}`}`);
}
