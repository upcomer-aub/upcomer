"use server";

import { redirect } from "next/navigation";
import { moderateAdvice } from "@/lib/advice-moderation";
import { requireAdmin } from "@/lib/auth";

// An admin removes a reported advice or keeps it (US-77) and comes back to the same queue page with the outcome. A
// student, or a visitor, never reaches the service: requireAdmin() shows them the not-found page or the login page.
export async function moderateAdviceAction(formData: FormData) {
  const route = "/admin/advice-reports";
  const admin = await requireAdmin(route);
  const result = await moderateAdvice(admin.id, { adviceId: String(formData.get("adviceId") ?? ""), decision: String(formData.get("decision") ?? "") });
  const page = Number(formData.get("page"));
  const back = Number.isInteger(page) && page > 1 ? `page=${page}&` : "";
  redirect(`${route}?${back}${result.ok ? `${result.decision === "remove" ? "removed" : "kept"}=1` : `error=${result.error}`}`);
}
