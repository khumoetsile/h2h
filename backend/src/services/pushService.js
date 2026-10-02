import crypto from 'node:crypto';
import webpush from 'web-push';
import { config } from '../config.js';
import { query } from '../db.js';

/**
 * Web push: the "your friend is here" ping that reaches a phone whose browser is closed.
 * Needs a VAPID key pair in the environment; without one the whole feature quietly switches itself off.
 *
 * Pushes are meant to be welcome, never nagging:
 *  - only moments someone is actually waiting on (see CATEGORY),
 *  - a player can switch each kind off, and "someone is looking for a game" starts off,
 *  - no challenge or "looking for a game" pings at night, and no repeats inside a short gap.
 */

/** Notification type -> the preference that controls it. */
const CATEGORY = {
  MATCH_FOUND: 'challenges',
  MATCH_STARTING: 'challenges',
  CHALLENGE_RECEIVED: 'challenges',
  CHALLENGE_ACCEPTED: 'challenges',
  WAITING_PLAYER: 'waiting',
};
export const PUSH_TYPES = new Set(Object.keys(CATEGORY).filter((t) => t !== 'WAITING_PLAYER'));

/** These can wait until morning. A friend joining the invite you are looking at cannot. */
const QUIET_TYPES = new Set(['CHALLENGE_RECEIVED', 'WAITING_PLAYER']);
const MIN_GAP_MS = { CHALLENGE_RECEIVED: 2 * 60 * 1000, MATCH_FOUND: 20 * 1000, MATCH_STARTING: 20 * 1000, CHALLENGE_ACCEPTED: 20 * 1000 };
const WAITING_GAP_MS = 3 * 60 * 60 * 1000;
const WAITING_MAX_RECIPIENTS = 25;

const { publicKey, privateKey, subject, quietStartHour, quietEndHour, utcOffsetHours } = config.push;
let configured = !!(publicKey && privateKey);
/** Why push is on or off, safe to show (never contains a key). */
let status = configured ? 'on' : (publicKey || privateKey ? 'missing one of the two keys' : 'no keys set');
if (configured) {
  try { webpush.setVapidDetails(subject, publicKey, privateKey); } catch (err) {
    // A mistyped key must not stop the server from starting: push just stays off.
    console.warn(`Web push disabled: ${err.message}`);
    configured = false;
    status = `rejected: ${err.message.replace(/[A-Za-z0-9_-]{30,}/g, '…')}`;
  }
}
export const pushStatus = () => (forcedEnabled === null ? status : forcedEnabled ? 'on' : 'off');

const defaultSender = (sub, body) => webpush.sendNotification(sub, body, { TTL: 120, urgency: 'high' });
let sender = defaultSender;
/** Tests swap the network call for a recorder. */
export function setSender(fn) { sender = fn || defaultSender; }

let forcedEnabled = null;
export function setEnabledForTests(v) { forcedEnabled = v; }

export const isEnabled = () => (forcedEnabled ?? configured);
export const getPublicKey = () => (isEnabled() ? publicKey || 'test-key' : null);

const hash = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex');

/** Night, in the players' own time zone. */
export function isQuietHour(date = new Date()) {
  const hour = (date.getUTCHours() + utcOffsetHours + 24) % 24;
  return quietStartHour > quietEndHour ? hour >= quietStartHour || hour < quietEndHour : hour >= quietStartHour && hour < quietEndHour;
}

let clock = () => new Date();
/** Tests move the clock to check quiet hours. */
export function setClockForTests(fn) { clock = fn || (() => new Date()); }

const lastSent = new Map();
export function resetRateLimitsForTests() { lastSent.clear(); }

export async function subscribe(userId, sub, userAgent = null) {
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint_hash, endpoint, p256dh, auth, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth), user_agent = VALUES(user_agent)`,
    [userId, hash(sub.endpoint), sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent ? String(userAgent).slice(0, 255) : null],
  );
}

export async function unsubscribe(userId, endpoint) {
  await query('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint_hash = ?', [userId, hash(endpoint)]);
}

export async function subscriptionCount(userId) {
  const rows = await query('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [userId]);
  return Number(rows[0].n);
}

export async function getPreferences(userId) {
  const rows = await query('SELECT notify_challenges, notify_waiting FROM users WHERE id = ?', [userId]);
  const r = rows[0] || {};
  return { challenges: r.notify_challenges !== 0, waiting: r.notify_waiting === 1 };
}

export async function setPreferences(userId, { challenges, waiting }) {
  if (typeof challenges === 'boolean') await query('UPDATE users SET notify_challenges = ? WHERE id = ?', [challenges ? 1 : 0, userId]);
  if (typeof waiting === 'boolean') await query('UPDATE users SET notify_waiting = ? WHERE id = ?', [waiting ? 1 : 0, userId]);
  return getPreferences(userId);
}

/** Send to every device of one player. Dead subscriptions (the phone uninstalled the app) are dropped. Never throws. */
async function deliver(userId, { title, body, url, tag }) {
  let sent = 0;
  try {
    const subs = await query('SELECT endpoint_hash, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', [userId]);
    const payload = JSON.stringify({ title, body, url: url || '/', tag: tag || undefined });
    await Promise.all(subs.map(async (s) => {
      try {
        await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        sent += 1;
      } catch (err) {
        if (err?.statusCode === 404 || err?.statusCode === 410) await query('DELETE FROM push_subscriptions WHERE endpoint_hash = ?', [s.endpoint_hash]);
      }
    }));
  } catch { /* a failed push must never break the action that caused it */ }
  return sent;
}

/**
 * Push for a notification of a given `type`: honours the player's preferences, quiet hours and the repeat gap.
 * Without a type it sends unconditionally (used for direct sends and tests).
 */
export async function sendToUser(userId, message, type = null) {
  if (!isEnabled()) return 0;
  if (type) {
    const category = CATEGORY[type];
    if (!category) return 0;
    const now = clock();
    if (QUIET_TYPES.has(type) && isQuietHour(now)) return 0;
    const gap = MIN_GAP_MS[type];
    const key = `${userId}:${type}`;
    if (gap && now.getTime() - (lastSent.get(key) || 0) < gap) return 0;
    try {
      const prefs = await getPreferences(userId);
      if (!prefs[category]) return 0;
    } catch { return 0; }
    if (lastSent.size > 20000) lastSent.clear();
    lastSent.set(key, now.getTime());
  }
  return deliver(userId, message);
}

/**
 * Someone just started looking for a game and nobody was there. Tell the few players who asked to hear about that:
 * people who have played this game, at most one ping every three hours each, never at night, never more than a handful at once.
 */
export async function announceWaiting({ gameId, gameName, creatorId }) {
  if (!isEnabled()) return 0;
  const now = clock();
  if (isQuietHour(now)) return 0;
  try {
    const rows = await query(
      `SELECT DISTINCT u.id FROM users u
         JOIN push_subscriptions ps ON ps.user_id = u.id
         JOIN match_players mp ON mp.user_id = u.id
         JOIN matches m ON m.id = mp.match_id AND m.game_id = ?
        WHERE u.status = 'ACTIVE' AND u.role = 'PLAYER' AND u.is_bot = 0 AND u.notify_waiting = 1 AND u.id <> ?
          AND (u.last_waiting_push_at IS NULL OR u.last_waiting_push_at < ?)
        LIMIT ${WAITING_MAX_RECIPIENTS}`,
      [gameId, creatorId, new Date(now.getTime() - WAITING_GAP_MS)],
    );
    let sent = 0;
    for (const r of rows) {
      await query('UPDATE users SET last_waiting_push_at = ? WHERE id = ?', [now, r.id]);
      sent += await deliver(r.id, { title: 'Someone wants to play', body: `A player is waiting for a ${gameName} match. Tap to play now.`, url: '/dashboard', tag: 'WAITING_PLAYER' });
    }
    return sent;
  } catch { return 0; }
}
