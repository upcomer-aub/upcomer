"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { requestPasswordReset, resetPassword } from "@/lib/password-reset";

const field = (formData: FormData, name: string) => String(formData.get(name) ?? "");

// Always the same answer, whether or not the email is registered or was limited.
export async function requestResetAction(formData: FormData) {
  const email = field(formData, "email");
  after(() => requestPasswordReset(email));
  redirect("/forgot-password?sent=1");
}

export async function resetPasswordAction(formData: FormData) {
  const token = field(formData, "token");
  const result = await resetPassword(token, field(formData, "password"), field(formData, "confirm"));
  if (result.ok) redirect("/login?reset=1");
  // A password the rules refuse leaves the link usable, so the form comes back with it.
  if (result.error === "weak_password" || result.error === "password_mismatch") {
    redirect(`/reset-password?${new URLSearchParams({ token, error: result.error })}`);
  }
  redirect(`/reset-password?error=${result.error}`);
}
