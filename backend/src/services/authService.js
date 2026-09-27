import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { queryOne, query, withTransaction } from '../db.js';
import { signToken } from '../middleware/auth.js';
import { badRequest, conflict, forbidden, unauthorized } from '../utils/errors.js';
import { toCents, fromCents } from '../utils/money.js';
import { txReference } from '../utils/ids.js';
import { createWallet } from './walletService.js';
import { getSettings } from './settingsService.js';
import { notify } from './notificationService.js';
import { recordAudit } from './auditService.js';

const AVATAR_COLORS = ['#3B82F6', '#22D3EE', '#A855F7', '#F97316', '#10B981', '#EF4444', '#EAB308', '#EC4899', '#14B8A6', '#6366F1'];
export const BCRYPT_ROUNDS = 10;

export function mapUser(u) {
  return {
    id: u.id,
    firstName: u.first_name,
    lastName: u.last_name,
    username: u.username,
    email: u.email,
    phone: u.phone,
    role: u.role,
    status: u.status,
    bio: u.bio,
    avatarColor: u.avatar_color,
    isBot: !!u.is_bot,
    isDemoData: !!u.is_demo_data,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

async function createSession(userId, remember, meta) {
  const id = crypto.randomUUID();
  const ttlMs = remember ? config.sessionRememberTtlDays * 86400000 : config.sessionTtlHours * 3600000;
  const expiresAt = new Date(Date.now() + ttlMs);
  await query('INSERT INTO sessions (id, user_id, remember, user_agent, ip, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [
    id, userId, remember ? 1 : 0, (meta.userAgent || '').slice(0, 255), (meta.ip || '').slice(0, 64), expiresAt,
  ]);
  return { token: signToken(id, userId, expiresAt), expiresAt };
}

export async function register(data, meta = {}) {
  const settings = await getSettings();
  const email = data.email.toLowerCase();
  const existing = await query('SELECT username, email FROM users WHERE username = ? OR email = ?', [data.username, email]);
  const fields = {};
  for (const e of existing) {
    if (e.username.toLowerCase() === data.username.toLowerCase()) fields.username = 'That username is already taken.';
    if (e.email.toLowerCase() === email) fields.email = 'An account with that email already exists.';
  }
  if (Object.keys(fields).length) throw conflict('ALREADY_EXISTS', Object.values(fields)[0], { fields });
  const hash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);
  const userId = await withTransaction(async (tx) => {
    let res;
    try {
      res = await tx.q(
        `INSERT INTO users (first_name, last_name, username, email, phone, password_hash, avatar_color) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [data.firstName, data.lastName, data.username, email, data.phone, hash, AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]],
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict('ALREADY_EXISTS', 'That username or email is already registered.');
      throw err;
    }
    const uid = res.insertId;
    const walletId = await createWallet(tx, uid);
    const bonus = settings.signup_bonus;
    if (bonus > 0) {
      await tx.q('UPDATE wallets SET available_balance = ? WHERE id = ?', [bonus, walletId]);
      await tx.q(
        `INSERT INTO transactions (reference, user_id, wallet_id, type, direction, amount, available_after, locked_after, description, status, idempotency_key)
         VALUES (?, ?, ?, 'DEPOSIT', 'CREDIT', ?, ?, 0, ?, 'DEMO_COMPLETED', ?)`,
        [txReference(), uid, walletId, bonus, fromCents(toCents(bonus)), 'Welcome bonus, DEMO FUNDS (no real money)', `signup:${uid}`],
      );
    }
    await notify(tx, uid, {
      type: 'WELCOME',
      title: `Welcome to ${config.appName}!`,
      message: bonus > 0 ? `We've added P${bonus.toFixed(2)} DEMO to your demo wallet. No real money is involved.` : 'Your account is ready.',
      link: '/wallet',
    });
    return uid;
  });
  const user = await queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  const session = await createSession(userId, !!data.remember, meta);
  await query('UPDATE users SET last_login_at = NOW(), last_seen_at = NOW() WHERE id = ?', [userId]);
  await recordAudit(null, {
    actorType: 'PLAYER', actorUserId: userId, action: 'USER_REGISTERED', entityType: 'USER', entityId: userId,
    ip: meta.ip, userAgent: meta.userAgent, newState: 'ACTIVE',
  });
  return { user: mapUser(user), ...session };
}

export async function login({ identifier, password, remember }, meta = {}) {
  const id = identifier.trim().replace(/^@/, '');
  const user = await queryOne('SELECT * FROM users WHERE email = ? OR username = ?', [id.toLowerCase(), id]);
  // Always run bcrypt to keep timing similar whether or not the user exists.
  const ok = await bcrypt.compare(password, user?.password_hash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
  if (!user || !ok) {
    await recordAudit(null, {
      actorType: 'PLAYER', action: 'LOGIN_FAILED', entityType: 'USER', entityId: user?.id ?? null,
      actorUserId: user?.id ?? null, ip: meta.ip, userAgent: meta.userAgent, reason: 'incorrect credentials',
      metadata: { identifier: id },
    });
    throw unauthorized('Incorrect email/username or password.');
  }
  if (user.is_bot) throw forbidden('Demo opponent accounts cannot sign in.');
  if (user.status !== 'ACTIVE') {
    await recordAudit(null, {
      actorType: 'PLAYER', actorUserId: user.id, action: 'LOGIN_FAILED', entityType: 'USER', entityId: user.id,
      ip: meta.ip, userAgent: meta.userAgent, reason: 'account disabled',
    });
    throw forbidden('Your account has been disabled. Contact support.');
  }
  const session = await createSession(user.id, !!remember, meta);
  await query('UPDATE users SET last_login_at = NOW(), last_seen_at = NOW() WHERE id = ?', [user.id]);
  await recordAudit(null, {
    actorType: user.role === 'ADMIN' ? 'ADMIN' : 'PLAYER', actorUserId: user.id, action: 'LOGIN_SUCCESS', entityType: 'USER', entityId: user.id,
    ip: meta.ip, userAgent: meta.userAgent,
  });
  return { user: mapUser(user), ...session };
}

export async function logout(sessionId, actorUserId = null) {
  await query('UPDATE sessions SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL', [sessionId]);
  await recordAudit(null, { actorType: 'PLAYER', actorUserId, action: 'LOGOUT', entityType: 'USER', entityId: actorUserId });
}

export async function changePassword(userId, currentPassword, newPassword) {
  const user = await queryOne('SELECT password_hash FROM users WHERE id = ?', [userId]);
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) throw badRequest('INVALID_PASSWORD', 'Your current password is incorrect.', { fields: { currentPassword: 'Incorrect password.' } });
  await query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(newPassword, BCRYPT_ROUNDS), userId]);
  await recordAudit(null, { actorType: 'PLAYER', actorUserId: userId, action: 'PASSWORD_CHANGED', entityType: 'USER', entityId: userId });
}
