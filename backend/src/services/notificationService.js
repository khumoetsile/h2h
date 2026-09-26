import { query } from '../db.js';
import { emitToUser } from '../realtime.js';

/**
 * Create an in-app notification. When `tx` is provided the insert joins that
 * transaction and the realtime push happens after commit.
 */
export async function notify(tx, userId, { type, title, message, link = null }) {
  const run = tx ? tx.q : query;
  const res = await run(
    'INSERT INTO notifications (user_id, type, title, message, link) VALUES (?, ?, ?, ?, ?)',
    [userId, type, title.slice(0, 120), message.slice(0, 255), link],
  );
  const payload = { id: res.insertId, type, title, message, link, isRead: false, createdAt: new Date().toISOString() };
  const push = () => emitToUser(userId, 'notification', payload);
  if (tx) tx.afterCommit(push); else push();
  return payload;
}

export function mapNotification(n) {
  return { id: n.id, type: n.type, title: n.title, message: n.message, link: n.link, isRead: !!n.is_read, createdAt: n.created_at };
}
