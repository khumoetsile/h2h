import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { queryOne, query } from '../db.js';
import { forbidden, unauthorized } from '../utils/errors.js';

export function signToken(sessionId, userId, expiresAt) {
  return jwt.sign({ sub: String(userId), sid: sessionId }, config.jwtSecret, {
    expiresIn: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  });
}

/** Verify a bearer token and its server-side session. Returns the user row or throws. */
export async function authenticateToken(token) {
  if (!token) throw unauthorized();
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    throw unauthorized(err.name === 'TokenExpiredError' ? 'Your session has expired. Please sign in again.' : 'Invalid session. Please sign in again.');
  }
  const row = await queryOne(
    `SELECT u.*, s.id AS session_id, s.revoked_at, s.expires_at AS session_expires
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.user_id = ?`,
    [payload.sid, Number(payload.sub)],
  );
  if (!row || row.revoked_at || new Date(row.session_expires) <= new Date()) {
    throw unauthorized('Your session has ended. Please sign in again.');
  }
  if (row.status !== 'ACTIVE') throw forbidden('Your account has been disabled. Contact support.');
  return row;
}

let lastSeenWrites = new Map();

export async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const user = await authenticateToken(token);
    req.user = { id: user.id, role: user.role, username: user.username, sessionId: user.session_id };
    // Throttled "last seen" update (used for the admin "active users" metric).
    const now = Date.now();
    if ((lastSeenWrites.get(user.id) || 0) < now - 60000) {
      lastSeenWrites.set(user.id, now);
      if (lastSeenWrites.size > 10000) lastSeenWrites = new Map();
      query('UPDATE users SET last_seen_at = NOW() WHERE id = ?', [user.id]).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'ADMIN') return next(forbidden('Administrator access required.'));
  next();
}

export function requirePlayer(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'PLAYER') return next(forbidden('This action is only available to player accounts.'));
  next();
}
