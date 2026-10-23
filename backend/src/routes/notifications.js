import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { ah, notFound } from '../utils/errors.js';
import { mapNotification } from '../services/notificationService.js';
import { validate } from '../middleware/validate.js';
import { escapeLike } from '../utils/search.js';

const router = Router();

const listQuery = z.object({ unread: z.enum(['true', 'false']).optional(), category: z.enum(['all', 'games', 'football', 'wallet']).default('all'), search: z.string().trim().max(100).default(''), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(50) });
const categorySql = `CASE
  WHEN n.type = 'DAILY_PREDICTION' OR n.link LIKE '/football%' OR ((n.link LIKE '/match/%' OR n.link LIKE '/matches/%') AND EXISTS (SELECT 1 FROM matches fm WHERE fm.category = 'FOOTBALL' AND fm.code = SUBSTRING_INDEX(n.link, '/', -1)))
    OR (n.type LIKE 'CHALLENGE!_%' ESCAPE '!' AND n.link = '/challenges' AND n.message LIKE '%football%') THEN 'football'
  WHEN n.link LIKE '/wallet%' OR n.type IN ('DEPOSIT','WITHDRAWAL') THEN 'wallet'
  WHEN n.type LIKE 'MATCH!_%' ESCAPE '!' OR n.type LIKE 'CHESS!_%' ESCAPE '!' OR n.type LIKE 'CHALLENGE!_%' ESCAPE '!' OR n.type = 'WAITING_PLAYER' THEN 'games'
  ELSE 'general' END`;

router.get('/', validate(listQuery, 'query'), ah(async (req, res) => {
  const q = req.validatedQuery;
  const where = ['n.user_id = ?'];
  const params = [req.user.id];
  if (q.unread === 'true') where.push('n.is_read = 0');
  if (q.category !== 'all') { where.push(`(${categorySql}) = ?`); params.push(q.category); }
  if (q.search) {
    where.push("(n.title LIKE ? ESCAPE '!' OR n.message LIKE ? ESCAPE '!')");
    const search = `%${escapeLike(q.search)}%`;
    params.push(search, search);
  }
  const filter = where.join(' AND ');
  const rows = await query(
    `SELECT n.*, ${categorySql} AS category FROM notifications n WHERE ${filter} ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`,
    [...params, q.pageSize, (q.page - 1) * q.pageSize],
  );
  const [unreadRows, totalRows] = await Promise.all([
    query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id]),
    query(`SELECT COUNT(*) AS total FROM notifications n WHERE ${filter}`, params),
  ]);
  res.json({ notifications: rows.map(mapNotification), unread: Number(unreadRows[0].n), total: Number(totalRows[0].total), page: q.page, pageSize: q.pageSize });
}));

router.post('/read-all', ah(async (req, res) => {
  await query('UPDATE notifications SET is_read = 1, read_at = NOW() WHERE user_id = ? AND is_read = 0', [req.user.id]);
  const [{ n }] = await query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id]);
  res.json({ ok: true, unread: Number(n) });
}));

router.post('/:id/read', ah(async (req, res) => {
  // Ownership enforced by the user_id condition.
  const r = await query('UPDATE notifications SET is_read = 1, read_at = COALESCE(read_at, NOW()) WHERE id = ? AND user_id = ?', [Number(req.params.id) || 0, req.user.id]);
  if (r.affectedRows === 0) throw notFound('Notification not found.');
  const [{ n }] = await query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id]);
  res.json({ ok: true, unread: n });
}));

export default router;
