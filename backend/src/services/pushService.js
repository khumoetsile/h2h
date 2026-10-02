import crypto from 'node:crypto';
import webpush from 'web-push';
import { config } from '../config.js';
import { query } from '../db.js';

/**
 * Web push: the "your friend is here" ping that reaches a phone whose browser is closed.
 * Needs a VAPID key pair in the environment; without one the whole feature quietly switches itself off.
 */

/** Only the moments someone is waiting on: a challenge that needs an answer or a match that is about to start. */
export const PUSH_TYPES = new Set(['MATCH_FOUND', 'MATCH_STARTING', 'CHALLENGE_RECEIVED', 'CHALLENGE_ACCEPTED']);

const { publicKey, privateKey, subject } = config.push;
let configured = !!(publicKey && privateKey);
if (configured) {
  try { webpush.setVapidDetails(subject, publicKey, privateKey); } catch (err) {
    // A mistyped key must not stop the server from starting: push just stays off.
    console.warn(`Web push disabled: ${err.message}`);
    configured = false;
  }
}

const defaultSender = (sub, body) => webpush.sendNotification(sub, body, { TTL: 120, urgency: 'high' });
let sender = defaultSender;
/** Tests swap the network call for a recorder. */
export function setSender(fn) { sender = fn || defaultSender; }

let forcedEnabled = null;
export function setEnabledForTests(v) { forcedEnabled = v; }

export const isEnabled = () => (forcedEnabled ?? configured);
export const getPublicKey = () => (isEnabled() ? publicKey || 'test-key' : null);

const hash = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex');

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

/** Send to every device of one player. Dead subscriptions (the phone uninstalled the app) are dropped. Never throws. */
export async function sendToUser(userId, { title, body, url, tag }) {
  if (!isEnabled()) return 0;
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
