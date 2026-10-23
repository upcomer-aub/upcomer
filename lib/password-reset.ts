import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { BCRYPT_COST, normalizeEmail, PASSWORD_MIN_LENGTH } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorCode, logError } from "@/lib/logger";
import { appOrigin, MailError, sendMail, type Mail } from "@/lib/mail";

// Password reset (US-03). A link carries a random token; only its SHA-256 hash is stored, as for sessions. A link works once,
// until it expires, and only while it is the user's newest one. Requests always end the same way for the caller, so the
// site never reveals which emails are registered.

export const RESET_TOKEN_TTL_MINUTES = 30;
export const RESET_REQUEST_LIMIT = 3;
export const RESET_REQUEST_WINDOW_MINUTES = 15;
// Old links are deleted the next time the same user asks for one.
const RESET_TOKEN_RETENTION_HOURS = 24;
const MINUTE = 60_000;
// Shown after every request, so the page never says whether an email is registered.
export const RESET_SENT_MESSAGE = `If an account exists for that email, we've sent a link to reset your password. The link works once and expires in ${RESET_TOKEN_TTL_MINUTES} minutes.`;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ResetTokenRejection = "unknown" | "used" | "expired" | "superseded";
export type ResetPasswordError = "weak_password" | "password_mismatch" | ResetTokenRejection | "unexpected";
type Send = (mail: Mail) => Promise<void>;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

function resetEmail(link: string) {
  return [
    "Someone asked to reset the password of your Upcomer account.",
    "",
    `Set a new password here: ${link}`,
    "",
    `The link works once and expires in ${RESET_TOKEN_TTL_MINUTES} minutes. If you didn't ask for it, you can ignore this email; your password stays the same.`,
  ].join("\n");
}

// Always resolves without saying whether the email is registered.
export async function requestPasswordReset(email: string, { now = new Date(), send = sendMail as Send } = {}): Promise<void> {
  const address = normalizeEmail(email);
  try {
    const user = EMAIL_PATTERN.test(address) ? await db.user.findUnique({ where: { email: address }, select: { id: true, email: true } }) : null;
    if (!user) {
      logError("password_reset_requested", { outcome: "unknown_email" });
      return;
    }
    const recent = await db.passwordResetToken.count({ where: { userId: user.id, createdAt: { gt: new Date(now.getTime() - RESET_REQUEST_WINDOW_MINUTES * MINUTE) } } });
    if (recent >= RESET_REQUEST_LIMIT) {
      logError("password_reset_rate_limited", { userId: user.id });
      return;
    }
    const origin = appOrigin();
    if (!origin) {
      logError("password_reset_email_failed", { userId: user.id, reason: "app_url_not_configured" });
      return;
    }
    const token = randomBytes(32).toString("base64url");
    const created = await db.$transaction(async tx => {
      await tx.passwordResetToken.deleteMany({ where: { userId: user.id, createdAt: { lt: new Date(now.getTime() - RESET_TOKEN_RETENTION_HOURS * 60 * MINUTE) } } });
      // A new link replaces every older unused one.
      await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null, invalidatedAt: null }, data: { invalidatedAt: now } });
      return tx.passwordResetToken.create({
        data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * MINUTE), createdAt: now },
        select: { id: true },
      });
    });
    const link = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
    try {
      await send({ to: user.email, subject: "Reset your Upcomer password", text: resetEmail(link) });
      logError("password_reset_requested", { outcome: "sent", userId: user.id, resetLinkId: created.id });
    } catch (error) {
      logError("password_reset_email_failed", { userId: user.id, reason: error instanceof MailError ? error.reason : "send_failed", errorType: errorType(error) });
    }
  } catch (error) {
    logError("password_reset_failed", { stage: "request", errorType: errorType(error), errorCode: errorCode(error) });
  }
}

type TokenRow = { id: string; userId: string; expiresAt: Date; usedAt: Date | null; invalidatedAt: Date | null };

function rejectionOf(row: TokenRow | null, now: Date): ResetTokenRejection | null {
  if (!row) return "unknown";
  if (row.usedAt) return "used";
  if (row.invalidatedAt) return "superseded";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return null;
}

const tokenSelect = { id: true, userId: true, expiresAt: true, usedAt: true, invalidatedAt: true } as const;

// The link's row ID is logged as resetLinkId: the logger drops any key that contains "token".
function rejectToken(reason: ResetTokenRejection, resetLinkId?: string) {
  logError("password_reset_token_rejected", { reason, resetLinkId });
  return { ok: false as const, reason };
}

// Whether a link can still be used, for the reset page. It changes nothing.
export async function checkResetToken(token: string, now = new Date()): Promise<{ ok: true; tokenId: string; userId: string } | { ok: false; reason: ResetTokenRejection | "unexpected" }> {
  if (!token) return rejectToken("unknown");
  try {
    const row = await db.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) }, select: tokenSelect });
    const rejection = rejectionOf(row, now);
    if (rejection) return rejectToken(rejection, row?.id);
    return { ok: true, tokenId: row!.id, userId: row!.userId };
  } catch (error) {
    logError("password_reset_failed", { stage: "check", errorType: errorType(error), errorCode: errorCode(error) });
    return { ok: false, reason: "unexpected" };
  }
}

class Rejected extends Error {
  constructor(public reason: ResetTokenRejection, public tokenId?: string) { super(reason); }
}

// Sets a new password with a link. The password rules are sign-up's. On success the link is used up, the user's other links
// stop working, and every session of the user is ended, so the old password and any stolen session are both locked out.
export async function resetPassword(token: string, password: string, confirm: string, now = new Date()): Promise<{ ok: true; userId: string } | { ok: false; error: ResetPasswordError }> {
  if (password.length < PASSWORD_MIN_LENGTH || password !== confirm) {
    const reason = password.length < PASSWORD_MIN_LENGTH ? "weak_password" : "password_mismatch";
    logError("password_reset_rejected", { reason });
    return { ok: false, error: reason };
  }
  if (!token) return { ok: false, error: rejectToken("unknown").reason };
  const tokenHash = hashToken(token);
  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const result = await db.$transaction(async tx => {
      // Claiming the link and checking it are one statement, so two tabs can never both use it.
      const claimed = await tx.passwordResetToken.updateMany({
        where: { tokenHash, usedAt: null, invalidatedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      const row = await tx.passwordResetToken.findUnique({ where: { tokenHash }, select: tokenSelect });
      if (claimed.count === 0 || !row) throw new Rejected(rejectionOf(row, now) ?? "used", row?.id);
      await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
      const sessions = await tx.session.deleteMany({ where: { userId: row.userId } });
      await tx.passwordResetToken.updateMany({ where: { userId: row.userId, usedAt: null, invalidatedAt: null }, data: { invalidatedAt: now } });
      return { userId: row.userId, sessionsEnded: sessions.count };
    });
    logError("password_reset_completed", { userId: result.userId, sessionsEnded: String(result.sessionsEnded) });
    return { ok: true, userId: result.userId };
  } catch (error) {
    if (error instanceof Rejected) return { ok: false, error: rejectToken(error.reason, error.tokenId).reason };
    logError("password_reset_failed", { stage: "reset", errorType: errorType(error), errorCode: errorCode(error) });
    return { ok: false, error: "unexpected" };
  }
}
