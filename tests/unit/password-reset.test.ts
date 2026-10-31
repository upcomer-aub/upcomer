import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFind: vi.fn(), userUpdate: vi.fn(),
  tokenCount: vi.fn(), tokenFind: vi.fn(), tokenCreate: vi.fn(), tokenUpdateMany: vi.fn(), tokenDeleteMany: vi.fn(),
  sessionDeleteMany: vi.fn(),
}));
vi.mock("@/lib/db", () => {
  const tx = {
    user: { findUnique: mocks.userFind, update: mocks.userUpdate },
    passwordResetToken: { count: mocks.tokenCount, findUnique: mocks.tokenFind, create: mocks.tokenCreate, updateMany: mocks.tokenUpdateMany, deleteMany: mocks.tokenDeleteMany },
    session: { deleteMany: mocks.sessionDeleteMany },
  };
  return { db: { ...tx, $transaction: (work: (client: typeof tx) => unknown) => work(tx) } };
});
import {
  checkResetToken, requestPasswordReset, RESET_REQUEST_LIMIT, RESET_TOKEN_TTL_MINUTES, resetPassword,
} from "@/lib/password-reset";
import { MailError, type Mail } from "@/lib/mail";

const now = new Date("2026-10-17T12:00:00Z");
const minutes = (count: number) => new Date(now.getTime() + count * 60_000);
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const student = { id: "user-a", email: "lina@mail.aub.edu" };
const row = (fields: Record<string, unknown> = {}) => ({ id: "token-1", userId: "user-a", expiresAt: minutes(10), usedAt: null, invalidatedAt: null, ...fields });

let errors: ReturnType<typeof vi.spyOn>;
const logged = () => errors.mock.calls.map(call => JSON.parse(String(call[0])));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
let sent: Mail[];
const send = vi.fn(async (mail: Mail) => { sent.push(mail); });
const tokenOf = (mail: Mail) => decodeURIComponent(mail.text.match(/token=([^\s]+)/)![1]);

beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.userFind.mockResolvedValue(student);
  mocks.tokenCount.mockResolvedValue(0);
  mocks.tokenCreate.mockResolvedValue({ id: "token-new" });
  mocks.tokenUpdateMany.mockResolvedValue({ count: 1 });
  mocks.tokenDeleteMany.mockResolvedValue({ count: 0 });
  mocks.sessionDeleteMany.mockResolvedValue({ count: 2 });
  mocks.userUpdate.mockResolvedValue({});
  sent = [];
  send.mockClear();
  vi.stubEnv("APP_URL", "https://upcomer.example.com/");
});
afterEach(() => {
  errors.mockRestore();
  vi.unstubAllEnvs();
});

describe("requestPasswordReset (acceptance test 1)", () => {
  it("sends one single-use link that expires in 30 minutes, storing only its hash", async () => {
    await requestPasswordReset("  Lina@Mail.AUB.edu ", { now, send });
    await settle();
    expect(mocks.userFind).toHaveBeenCalledWith({ where: { email: "lina@mail.aub.edu" }, select: { id: true, email: true } });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("lina@mail.aub.edu");
    expect(sent[0].text).toMatch(/^Set a new password here: https:\/\/upcomer\.example\.com\/reset-password\?token=[A-Za-z0-9_-]{43}$/m);
    expect(sent[0].text).toContain("expires in 30 minutes");
    const token = tokenOf(sent[0]);
    const { data } = mocks.tokenCreate.mock.calls[0][0];
    expect(data).toEqual({ userId: "user-a", tokenHash: hash(token), expiresAt: minutes(RESET_TOKEN_TTL_MINUTES), createdAt: now });
    expect(JSON.stringify(mocks.tokenCreate.mock.calls)).not.toContain(token);
  });
  it("replaces every older unused link and drops day-old ones", async () => {
    await requestPasswordReset(student.email, { now, send });
    expect(mocks.tokenUpdateMany).toHaveBeenCalledWith({ where: { userId: "user-a", usedAt: null, invalidatedAt: null }, data: { invalidatedAt: now } });
    expect(mocks.tokenDeleteMany).toHaveBeenCalledWith({ where: { userId: "user-a", createdAt: { lt: new Date(now.getTime() - 24 * 3_600_000) } } });
  });
  it("makes a different token every time", async () => {
    await requestPasswordReset(student.email, { now, send });
    await requestPasswordReset(student.email, { now, send });
    await settle();
    expect(tokenOf(sent[0])).not.toBe(tokenOf(sent[1]));
  });
  it("logs the request with IDs only", async () => {
    await requestPasswordReset(student.email, { now, send });
    await settle();
    expect(logged()).toEqual([expect.objectContaining({ event: "password_reset_requested", level: "info", outcome: "sent", userId: "user-a", resetLinkId: "token-new" })]);
    expect(JSON.stringify(logged())).not.toMatch(/lina|token=|reset-password/i);
  });
  it("logs a failed send without the address or link", async () => {
    send.mockRejectedValueOnce(new MailError("not_configured"));
    await requestPasswordReset(student.email, { now, send });
    await settle();
    expect(logged()).toContainEqual(expect.objectContaining({ event: "password_reset_email_failed", level: "error", userId: "user-a", reason: "not_configured" }));
    expect(JSON.stringify(logged())).not.toMatch(/lina|token=/i);
  });
  it("waits for the email send before finishing the request", async () => {
    let finishSend!: () => void;
    const pendingSend = new Promise<void>(resolve => { finishSend = resolve; });
    send.mockImplementationOnce(async mail => { sent.push(mail); await pendingSend; });
    let finished = false;
    const request = requestPasswordReset(student.email, { now, send }).then(() => { finished = true; });
    await settle();
    expect(send).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    finishSend();
    await request;
    expect(finished).toBe(true);
    expect(logged()).toContainEqual(expect.objectContaining({ event: "password_reset_requested", outcome: "sent" }));
  });
  it("creates no link when the site address is unknown", async () => {
    vi.stubEnv("APP_URL", "");
    await requestPasswordReset(student.email, { now, send });
    expect(mocks.tokenCreate).not.toHaveBeenCalled();
    expect(logged()).toEqual([expect.objectContaining({ event: "password_reset_email_failed", reason: "app_url_not_configured" })]);
  });
});

describe("requestPasswordReset never reveals an email (acceptance test 3)", () => {
  it.each(["nobody@mail.aub.edu", "not an email", ""])("does nothing visible for %j", async email => {
    mocks.userFind.mockResolvedValue(null);
    await expect(requestPasswordReset(email, { now, send })).resolves.toBeUndefined();
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(mocks.tokenCreate).not.toHaveBeenCalled();
    expect(logged()).toEqual([expect.objectContaining({ event: "password_reset_requested", outcome: "unknown_email" })]);
    expect(JSON.stringify(logged())).not.toContain("nobody");
  });
  it(`limits one account to ${RESET_REQUEST_LIMIT} links per 15 minutes, with the same answer`, async () => {
    mocks.tokenCount.mockResolvedValue(RESET_REQUEST_LIMIT);
    await expect(requestPasswordReset(student.email, { now, send })).resolves.toBeUndefined();
    expect(mocks.tokenCount).toHaveBeenCalledWith({ where: { userId: "user-a", createdAt: { gt: minutes(-15) } } });
    expect(send).not.toHaveBeenCalled();
    expect(mocks.tokenCreate).not.toHaveBeenCalled();
    expect(logged()).toEqual([expect.objectContaining({ event: "password_reset_rate_limited", level: "warn", userId: "user-a" })]);
  });
  it("answers the same way when the database fails", async () => {
    mocks.userFind.mockRejectedValue(new TypeError("boom"));
    await expect(requestPasswordReset(student.email, { now, send })).resolves.toBeUndefined();
    expect(logged()).toEqual([expect.objectContaining({ event: "password_reset_failed", stage: "request", errorType: "TypeError" })]);
  });
});

describe("checkResetToken (acceptance test 4)", () => {
  it("accepts an unused, current link looked up by its hash", async () => {
    mocks.tokenFind.mockResolvedValue(row());
    expect(await checkResetToken("raw-token", now)).toEqual({ ok: true, tokenId: "token-1", userId: "user-a" });
    expect(mocks.tokenFind).toHaveBeenCalledWith(expect.objectContaining({ where: { tokenHash: hash("raw-token") } }));
  });
  it.each([
    ["used", row({ usedAt: minutes(-1) })],
    ["superseded", row({ invalidatedAt: minutes(-1) })],
    ["expired", row({ expiresAt: now })],
    ["unknown", null],
  ])("rejects a %s link and logs the reason", async (reason, found) => {
    mocks.tokenFind.mockResolvedValue(found);
    expect(await checkResetToken("raw-token", now)).toEqual({ ok: false, reason });
    expect(logged()).toEqual([expect.objectContaining({ event: "password_reset_token_rejected", level: "warn", reason, ...(found ? { resetLinkId: "token-1" } : {}) })]);
    expect(JSON.stringify(logged())).not.toContain("raw-token");
  });
  it("rejects a missing token without a lookup", async () => {
    expect(await checkResetToken("", now)).toEqual({ ok: false, reason: "unknown" });
    expect(mocks.tokenFind).not.toHaveBeenCalled();
  });
});

describe("resetPassword (acceptance tests 2 and 4)", () => {
  beforeEach(() => mocks.tokenFind.mockResolvedValue(row({ usedAt: now })));

  it("claims the link once, sets the new password, ends every session, and stops other links", async () => {
    expect(await resetPassword("raw-token", "new-password-1", "new-password-1", now)).toEqual({ ok: true, userId: "user-a" });
    expect(mocks.tokenUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { tokenHash: hash("raw-token"), usedAt: null, invalidatedAt: null, expiresAt: { gt: now } }, data: { usedAt: now },
    });
    const { passwordHash } = mocks.userUpdate.mock.calls[0][0].data;
    expect(mocks.userUpdate.mock.calls[0][0].where).toEqual({ id: "user-a" });
    expect(await bcrypt.compare("new-password-1", passwordHash)).toBe(true);
    expect(mocks.sessionDeleteMany).toHaveBeenCalledWith({ where: { userId: "user-a" } });
    expect(mocks.tokenUpdateMany).toHaveBeenNthCalledWith(2, { where: { userId: "user-a", usedAt: null, invalidatedAt: null }, data: { invalidatedAt: now } });
    expect(logged()).toEqual([expect.objectContaining({ event: "password_reset_completed", level: "info", userId: "user-a", sessionsEnded: "2" })]);
    expect(JSON.stringify(logged())).not.toMatch(/new-password|raw-token|\$2[aby]\$/);
  });
  it.each([
    ["weak_password", "short", "short"],
    ["password_mismatch", "new-password-1", "new-password-2"],
  ])("refuses %s without using up the link", async (error, password, confirm) => {
    expect(await resetPassword("raw-token", password, confirm, now)).toEqual({ ok: false, error });
    expect(mocks.tokenUpdateMany).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(logged()).toEqual([expect.objectContaining({ event: "password_reset_rejected", reason: error })]);
  });
  it.each([
    ["used", row({ usedAt: minutes(-5) })],
    ["expired", row({ expiresAt: minutes(-1) })],
    ["superseded", row({ invalidatedAt: minutes(-1) })],
    ["unknown", null],
  ])("rejects a %s link and changes nothing", async (error, found) => {
    mocks.tokenUpdateMany.mockResolvedValue({ count: 0 });
    mocks.tokenFind.mockResolvedValue(found);
    expect(await resetPassword("raw-token", "new-password-1", "new-password-1", now)).toEqual({ ok: false, error });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.sessionDeleteMany).not.toHaveBeenCalled();
    expect(logged()).toEqual([expect.objectContaining({ event: "password_reset_token_rejected", reason: error })]);
  });
  it("reports a database failure", async () => {
    mocks.userUpdate.mockRejectedValue(Object.assign(new Error("lost"), { code: "P1001" }));
    expect(await resetPassword("raw-token", "new-password-1", "new-password-1", now)).toEqual({ ok: false, error: "unexpected" });
    expect(logged()).toEqual([expect.objectContaining({ event: "password_reset_failed", level: "error", stage: "reset", errorCode: "P1001" })]);
  });
});
