import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { requestPasswordReset, resetPassword, checkResetToken, redirect, after } = vi.hoisted(() => ({
  requestPasswordReset: vi.fn(), resetPassword: vi.fn(), checkResetToken: vi.fn(),
  redirect: vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); }),
  after: vi.fn(),
}));
vi.mock("@/lib/password-reset", async original => ({ ...(await original<typeof import("@/lib/password-reset")>()), requestPasswordReset, resetPassword, checkResetToken }));
vi.mock("next/navigation", () => ({ redirect, notFound: vi.fn() }));
vi.mock("next/server", () => ({ after }));
vi.mock("@/lib/db", () => ({ db: {} }));
import ForgotPasswordPage from "@/app/forgot-password/page";
import ResetPasswordPage, { metadata } from "@/app/reset-password/page";
import LoginPage from "@/app/login/page";
import { requestResetAction, resetPasswordAction } from "@/lib/password-reset-actions";
import { RESET_SENT_MESSAGE } from "@/lib/password-reset";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};
const reset = (params: Record<string, string> = {}) => ResetPasswordPage({ searchParams: Promise.resolve(params) });

beforeEach(() => {
  for (const mock of [requestPasswordReset, resetPassword, checkResetToken, redirect, after]) mock.mockClear();
  requestPasswordReset.mockResolvedValue(undefined);
  checkResetToken.mockResolvedValue({ ok: true, tokenId: "token-1", userId: "user-a" });
});

describe("forgot password (acceptance tests 1 and 3)", () => {
  it("asks for an email", async () => {
    const html = renderToStaticMarkup(await ForgotPasswordPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Reset Your Password");
    expect(html).toContain('<input type="email" autoComplete="email" required="" name="email"/>');
    expect(html).toContain("Send reset link");
    expect(html).not.toContain('role="status"');
  });
  it("shows one neutral message after any request", async () => {
    const html = renderToStaticMarkup(await ForgotPasswordPage({ searchParams: Promise.resolve({ sent: "1" }) }));
    expect(html).toContain(RESET_SENT_MESSAGE.replace("we've", "we&#x27;ve"));
    expect(RESET_SENT_MESSAGE).toBe("If an account exists for that email, we've sent a link to reset your password. The link works once and expires in 30 minutes.");
  });
  it("always redirects to the same page, whatever the email", async () => {
    for (const email of ["lina@mail.aub.edu", "nobody@mail.aub.edu", ""]) {
      await expect(requestResetAction(form({ email }))).rejects.toThrow("NEXT_REDIRECT /forgot-password?sent=1");
      expect(after).toHaveBeenCalledOnce();
      expect(requestPasswordReset).not.toHaveBeenCalled();
      await after.mock.calls[0][0]();
      expect(requestPasswordReset).toHaveBeenLastCalledWith(email);
      after.mockClear();
      requestPasswordReset.mockClear();
    }
  });
});

describe("reset password page (acceptance tests 2 and 4)", () => {
  it("shows the new-password form for a valid link and never sends it as a Referer", async () => {
    const html = renderToStaticMarkup(await reset({ token: "abc" }));
    expect(checkResetToken).toHaveBeenCalledWith("abc");
    expect(html).toContain("Set a New Password");
    expect(html).toContain('<input type="hidden" name="token" value="abc"/>');
    expect(html).toContain('<input type="password" autoComplete="new-password" minLength="8" required="" name="password"/>');
    expect(html).toContain('<input type="password" autoComplete="new-password" minLength="8" required="" name="confirm"/>');
    expect(metadata.referrer).toBe("no-referrer");
  });
  it.each([
    ["used", "This reset link has already been used."],
    ["expired", "This reset link has expired or was replaced by a newer one."],
    ["superseded", "This reset link has expired or was replaced by a newer one."],
    ["unknown", "This reset link isn&#x27;t valid."],
  ])("rejects a %s link with a way to ask for a new one", async (reason, message) => {
    checkResetToken.mockResolvedValue({ ok: false, reason });
    const html = renderToStaticMarkup(await reset({ token: "abc" }));
    expect(html).toContain(message);
    expect(html).toContain('href="/forgot-password"');
    expect(html).toContain("Request a new link");
    expect(html).not.toContain('name="password"');
  });
  it("shows a link error from the action without checking again", async () => {
    const html = renderToStaticMarkup(await reset({ error: "used" }));
    expect(html).toContain("This reset link has already been used.");
    expect(checkResetToken).not.toHaveBeenCalled();
  });
  it("keeps the form for a password error", async () => {
    const html = renderToStaticMarkup(await reset({ token: "abc", error: "password_mismatch" }));
    expect(html).toContain("The two passwords don&#x27;t match.");
    expect(html).toContain('name="password"');
  });
});

describe("resetPasswordAction", () => {
  it("goes to the login page after a reset", async () => {
    resetPassword.mockResolvedValue({ ok: true, userId: "user-a" });
    await expect(resetPasswordAction(form({ token: "abc", password: "new-password", confirm: "new-password" }))).rejects.toThrow("NEXT_REDIRECT /login?reset=1");
    expect(resetPassword).toHaveBeenCalledWith("abc", "new-password", "new-password");
  });
  it("keeps the link for a password the rules refuse, never echoing the password", async () => {
    resetPassword.mockResolvedValue({ ok: false, error: "weak_password" });
    await expect(resetPasswordAction(form({ token: "abc", password: "short", confirm: "short" }))).rejects.toThrow("NEXT_REDIRECT /reset-password?token=abc&error=weak_password");
    expect(String(redirect.mock.calls[0][0])).not.toContain("short");
  });
  it("drops the token for a link that no longer works", async () => {
    resetPassword.mockResolvedValue({ ok: false, error: "expired" });
    await expect(resetPasswordAction(form({ token: "abc", password: "new-password", confirm: "new-password" }))).rejects.toThrow("NEXT_REDIRECT /reset-password?error=expired");
  });
});

describe("login page", () => {
  it("links to the reset and confirms a changed password", async () => {
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ reset: "1" }) }));
    expect(html).toContain('href="/forgot-password"');
    expect(html).toContain("Forgot password?");
    expect(html).toContain("Your password was changed. Log in with your new password.");
  });
});
