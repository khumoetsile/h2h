import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { ah } from '../utils/errors.js';
import { validate } from '../middleware/validate.js';
import { passwordChangeSchema, profileSchema } from './schemas.js';
import { changePassword, mapUser } from '../services/authService.js';
import { getWallet } from '../services/walletService.js';
import { getUserStats, leaderboardPosition } from '../services/statsService.js';
import { listMatchesForUser, queueCounts } from '../services/matchService.js';
import { listChallenges } from '../services/challengeService.js';
import { listGames } from '../services/gameService.js';

const router = Router();

router.get('/me', ah(async (req, res) => {
  const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const [{ n }] = await query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id]);
  res.json({ user: mapUser(user), wallet: await getWallet(req.user.id), unreadNotifications: n });
}));

router.patch('/me', validate(profileSchema), ah(async (req, res) => {
  const map = { firstName: 'first_name', lastName: 'last_name', phone: 'phone', bio: 'bio', avatarColor: 'avatar_color' };
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(map)) {
    if (req.body[k] !== undefined) { sets.push(`${col} = ?`); params.push(req.body[k] || null); }
  }
  if (sets.length) await query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, req.user.id]);
  const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json({ user: mapUser(user) });
}));

router.post('/me/password', validate(passwordChangeSchema), ah(async (req, res) => {
  await changePassword(req.user.id, req.body.currentPassword, req.body.newPassword);
  res.json({ ok: true });
}));

router.get('/me/stats', ah(async (req, res) => {
  res.json({ stats: await getUserStats(req.user.id), leaderboard: await leaderboardPosition(req.user.id) });
}));

/** Everything the player dashboard needs in one round trip. */
router.get('/dashboard', ah(async (req, res) => {
  const uid = req.user.id;
  const [wallet, stats, position, active, recent, challenges, games, queue] = await Promise.all([
    getWallet(uid),
    getUserStats(uid),
    leaderboardPosition(uid),
    listMatchesForUser(uid, { active: true, pageSize: 10 }),
    listMatchesForUser(uid, { filter: 'completed', pageSize: 5 }),
    listChallenges(uid, { status: 'active' }),
    listGames({ includeDisabled: false }),
    queueCounts(),
  ]);
  res.json({
    wallet,
    stats,
    leaderboard: position,
    activeMatches: active.items,
    recentMatches: recent.items,
    activeChallenges: challenges,
    games: games.map((g) => ({ ...g, waiting: queue[g.id]?.total || 0 })),
  });
}));

export default router;
