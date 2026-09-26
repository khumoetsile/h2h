import { Router } from 'express';
import { query } from '../db.js';
import { ah, notFound } from '../utils/errors.js';
import { mapNotification } from '../services/notificationService.js';

const router = Router();

router.get('/', ah(async (req, res) => {
  const unreadOnly = req.query.unread === 'true';
  const rows = await query(
    `SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? 'AND is_read = 0' : ''} ORDER BY created_at DESC, id DESC LIMIT 50`,
    [req.user.id],
  );
  const [{ n }] = await query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id]);
  res.json({ notifications: rows.map(mapNotification), unread: n });
}));

router.post('/read-all', ah(async (req, res) => {
  await query('UPDATE notifications SET is_read = 1, read_at = NOW() WHERE user_id = ? AND is_read = 0', [req.user.id]);
  res.json({ ok: true, unread: 0 });
}));

router.post('/:id/read', ah(async (req, res) => {
  // Ownership enforced by the user_id condition.
  const r = await query('UPDATE notifications SET is_read = 1, read_at = COALESCE(read_at, NOW()) WHERE id = ? AND user_id = ?', [Number(req.params.id) || 0, req.user.id]);
  if (r.affectedRows === 0) throw notFound('Notification not found.');
  const [{ n }] = await query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id]);
  res.json({ ok: true, unread: n });
}));

export default router;
