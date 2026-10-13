import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import { config } from "../config.js";
import { query, withTransaction } from "../db.js";
import { AppError, badRequest } from "../utils/errors.js";
import { recordAudit } from "./auditService.js";

const digest = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");
// Test-only inbox; never exposed by an HTTP endpoint or populated in production.
export const recoveryTestInbox = [];
export function recoveryAvailable() {
  if (config.isTest) return true;
  try {
    const url = new URL(config.recovery.baseUrl);
    return (
      !!config.recovery.host &&
      !!config.recovery.from &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export async function requestPasswordReset(email) {
  if (!recoveryAvailable())
    throw new AppError(
      503,
      "RECOVERY_UNAVAILABLE",
      "Email recovery is not available yet. Please use the support details on this page.",
    );
  const issued = await withTransaction(async (tx) => {
    const user = await tx.one(
      "SELECT id,email FROM users WHERE email=? AND status='ACTIVE' AND is_bot=0 AND is_guest=0 FOR UPDATE",
      [email.toLowerCase()],
    );
    if (!user) return null;
    const previous = await tx.one(
      "SELECT created_at FROM password_reset_tokens WHERE user_id=?",
      [user.id],
    );
    if (
      previous &&
      Date.now() - new Date(previous.created_at).getTime() < 60000
    )
      return null;
    const token = crypto.randomBytes(32).toString("hex");
    await tx.q(
      `INSERT INTO password_reset_tokens (user_id,token_hash,expires_at) VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE token_hash=VALUES(token_hash),expires_at=VALUES(expires_at),created_at=NOW()`,
      [user.id, digest(token), new Date(Date.now() + 30 * 60000)],
    );
    return { user, token };
  });
  if (!issued) return;
  const { user, token } = issued;
  const url = new URL("/reset-password", config.recovery.baseUrl);
  url.searchParams.set("token", token);
  const text = `Reset your ${config.appName} password: ${url.toString()}\n\nThis link expires in 30 minutes and can be used once. If you did not request it, ignore this email. Your password has not changed.`;
  if (config.isTest) {
    recoveryTestInbox.push({ to: user.email, token, text });
    return;
  }
  const transport = nodemailer.createTransport({
    host: config.recovery.host,
    port: config.recovery.port,
    secure: config.recovery.secure,
    requireTLS: !config.recovery.secure,
    auth: config.recovery.user
      ? { user: config.recovery.user, pass: config.recovery.password }
      : undefined,
    connectionTimeout: 10000,
    socketTimeout: 15000,
  });
  // Delivery is asynchronous so SMTP timing cannot reveal account existence.
  void transport
    .sendMail({
      from: config.recovery.from,
      to: user.email,
      subject: `Reset your ${config.appName} password`,
      text,
    })
    .catch(async () => {
      await query(
        "DELETE FROM password_reset_tokens WHERE user_id = ? AND token_hash = ?",
        [user.id, digest(token)],
      );
      // Keep the public response identical to an unknown account. No email/token enters logs.
      console.error(
        "Password recovery email delivery failed. Check SMTP configuration.",
      );
    })
    .catch(() => console.error("Recovery cleanup failed."))
    .finally(() => transport.close());
}

export async function resetPassword(token, password) {
  const hash = await bcrypt.hash(password, 10);
  await withTransaction(async (tx) => {
    const reset = await tx.one(
      `SELECT pr.user_id, pr.expires_at, u.status FROM password_reset_tokens pr
      JOIN users u ON u.id = pr.user_id WHERE pr.token_hash = ? FOR UPDATE`,
      [digest(token)],
    );
    if (
      !reset ||
      reset.status !== "ACTIVE" ||
      new Date(reset.expires_at).getTime() <= Date.now()
    ) {
      throw badRequest(
        "RESET_EXPIRED",
        "This recovery link is invalid or has expired. Request a new link.",
      );
    }
    await tx.q("UPDATE users SET password_hash = ? WHERE id = ?", [
      hash,
      reset.user_id,
    ]);
    await tx.q(
      "UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL",
      [reset.user_id],
    );
    await tx.q("DELETE FROM password_reset_tokens WHERE user_id = ?", [
      reset.user_id,
    ]);
    await recordAudit(tx, {
      actorType: "SYSTEM",
      action: "PASSWORD_RECOVERED",
      entityType: "USER",
      entityId: reset.user_id,
      reason: "Single-use email recovery link verified",
    });
  });
}
