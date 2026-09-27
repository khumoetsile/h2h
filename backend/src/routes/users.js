import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { ah, notFound } from '../utils/errors.js';
import { getUserStats, headToHead } from '../services/statsService.js';
import { isUserOnline } from '../realtime.js';

const router = Router();

// Player search for challenges. Only public fields are returned.
router.get('/search', ah(async (req, res) => {
  const q = String(req.query.q || '').replace(/^@/, '').trim().slice(0, 20);
  if (q.length < 1) return res.json({ users: [] });
  const rows = await query(
    `SELECT id, username, first_name, last_name, avatar_color, is_bot FROM users
     WHERE role = 'PLAYER' AND status = 'ACTIVE' AND id <> ? AND (username LIKE ? OR CONCAT(first_name, ' ', last_name) LIKE ?)
     ORDER BY (username LIKE ?) DESC, username LIMIT 10`,
    [req.user.id, `${q}%`, `%${q}%`, `${q}%`],
  );
  res.json({
    users: rows.map((u) => ({ id: u.id, username: u.username, displayName: `${u.first_name} ${u.last_name}`, avatarColor: u.avatar_color, isBot: !!u.is_bot, online: isUserOnline(u.id) })),
  });
}));

router.get('/:username', ah(async (req, res) => {
  const u = await queryOne(`SELECT id, username, first_name, last_name, avatar_color, bio, is_bot, created_at FROM users WHERE username = ? AND role = 'PLAYER'`, [req.params.username]);
  if (!u) throw notFound('No player found with that username.');
  res.json({
    user: { id: u.id, username: u.username, displayName: `${u.first_name} ${u.last_name}`, avatarColor: u.avatar_color, bio: u.bio, isBot: !!u.is_bot, memberSince: u.created_at, online: isUserOnline(u.id) },
    stats: await getUserStats(u.id),
    // The viewer's own record against this player (null when viewing yourself).
    rivalry: u.id === req.user.id ? null : await headToHead(req.user.id, u.id),
  });
}));

export default router;
