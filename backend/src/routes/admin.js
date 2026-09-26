import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import { ah, badRequest, notFound } from '../utils/errors.js';
import { validate } from '../middleware/validate.js';
import { mapUser } from '../services/authService.js';
import { getWallet, listTransactions, TX_TYPES } from '../services/walletService.js';
import { getUserStats } from '../services/statsService.js';
import { cancelMatchTx, getMatchView, mapMatchRow } from '../services/matchService.js';
import { mapChallenge } from '../services/challengeService.js';
import { getSettingRows, updateSettings } from '../services/settingsService.js';
import { listGames, mapGame } from '../services/gameService.js';
import { notify } from '../services/notificationService.js';
import { emitAll, emitToUser } from '../realtime.js';

const router = Router();

async function audit(adminId, action, targetType, targetId, details) {
  await query('INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, CAST(? AS JSON))', [
    adminId, action, targetType, targetId != null ? String(targetId) : null, JSON.stringify(details ?? null),
  ]);
}

const page = (q) => {
  const size = Math.min(Math.max(Number(q.pageSize) || 20, 1), 100);
  const pg = Math.max(Number(q.page) || 1, 1);
  return { size, pg, offset: (pg - 1) * size };
};

// ---- Dashboard ------------------------------------------------------------
router.get('/stats', ah(async (_req, res) => {
  const users = await queryOne(`
    SELECT COUNT(*) AS total,
      SUM(status = 'ACTIVE') AS enabled,
      SUM(status = 'DISABLED') AS disabled,
      SUM(last_seen_at >= NOW() - INTERVAL 1 DAY) AS active24h,
      SUM(last_seen_at >= NOW() - INTERVAL 7 DAY) AS active7d,
      SUM(created_at >= NOW() - INTERVAL 7 DAY) AS new7d
    FROM users WHERE role = 'PLAYER' AND is_bot = 0`);
  const matches = await queryOne(`
    SELECT COUNT(*) AS total, SUM(status = 'COMPLETED') AS completed, SUM(status = 'CANCELLED') AS cancelled,
      SUM(status IN ('WAITING','MATCHED','READY','IN_PROGRESS')) AS active, SUM(status = 'WAITING') AS waiting,
      COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN pool END), 0) AS volume,
      COALESCE(SUM(CASE WHEN status = 'COMPLETED' AND is_draw = 0 THEN fee_amount END), 0) AS fees,
      COALESCE(SUM(CASE WHEN status = 'COMPLETED' AND is_draw = 0 THEN prize END), 0) AS paidOut
    FROM matches`);
  const tx = await query(`SELECT type, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM transactions GROUP BY type`);
  const txMap = Object.fromEntries(tx.map((t) => [t.type, { count: t.n, total: Number(t.total) }]));
  const challenges = await queryOne(`SELECT SUM(status = 'PENDING' AND expires_at > NOW()) AS active, COUNT(*) AS total, SUM(status = 'ACCEPTED') AS accepted FROM challenges`);
  const wallets = await queryOne(`SELECT COALESCE(SUM(available_balance), 0) AS available, COALESCE(SUM(locked_balance), 0) AS locked FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.is_bot = 0`);
  const daily = await query(`
    SELECT DATE(completed_at) AS day, COUNT(*) AS matches, COALESCE(SUM(pool), 0) AS volume, COALESCE(SUM(CASE WHEN is_draw = 0 THEN fee_amount END), 0) AS fees
    FROM matches WHERE status = 'COMPLETED' AND completed_at >= CURDATE() - INTERVAL 13 DAY
    GROUP BY DATE(completed_at) ORDER BY day`);
  const byGame = await query(`
    SELECT g.name, g.accent_color, COUNT(m.id) AS matches, COALESCE(SUM(m.pool), 0) AS volume
    FROM games g LEFT JOIN matches m ON m.game_id = g.id AND m.status = 'COMPLETED' GROUP BY g.id ORDER BY g.sort_order`);
  const n = (v) => Number(v || 0);
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const row = daily.find((r) => new Date(r.day).toISOString().slice(0, 10) === d);
    days.push({ day: d, matches: n(row?.matches), volume: n(row?.volume), fees: n(row?.fees) });
  }
  res.json({
    demoMode: true,
    users: { total: n(users.total), enabled: n(users.enabled), disabled: n(users.disabled), active24h: n(users.active24h), active7d: n(users.active7d), new7d: n(users.new7d) },
    matches: { total: n(matches.total), completed: n(matches.completed), cancelled: n(matches.cancelled), active: n(matches.active), waiting: n(matches.waiting) },
    finance: {
      demoDeposits: txMap.DEPOSIT || { count: 0, total: 0 },
      demoWithdrawals: txMap.WITHDRAWAL || { count: 0, total: 0 },
      demoGamingVolume: n(matches.volume),
      demoPlatformFees: n(matches.fees),
      demoPrizesPaid: n(matches.paidOut),
      demoRefunds: txMap.REFUND || { count: 0, total: 0 },
      walletsAvailable: n(wallets.available),
      walletsLocked: n(wallets.locked),
    },
    challenges: { active: n(challenges.active), total: n(challenges.total), accepted: n(challenges.accepted) },
    daily: days,
    byGame: byGame.map((g) => ({ name: g.name, accentColor: g.accent_color, matches: n(g.matches), volume: n(g.volume) })),
  });
}));

// ---- Users ----------------------------------------------------------------
const usersQuery = z.object({
  q: z.string().max(100).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional().or(z.literal('').transform(() => undefined)),
  role: z.enum(['PLAYER', 'ADMIN']).optional().or(z.literal('').transform(() => undefined)),
  includeBots: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

router.get('/users', validate(usersQuery, 'query'), ah(async (req, res) => {
  const q = req.validatedQuery;
  const where = [];
  const params = [];
  if (q.q) {
    where.push('(u.username LIKE ? OR u.email LIKE ? OR CONCAT(u.first_name, " ", u.last_name) LIKE ? OR u.phone LIKE ?)');
    const s = `%${q.q.replace(/^@/, '')}%`;
    params.push(s, s, s, s);
  }
  if (q.status) { where.push('u.status = ?'); params.push(q.status); }
  if (q.role) { where.push('u.role = ?'); params.push(q.role); }
  if (q.includeBots !== 'true') where.push('u.is_bot = 0');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { size, pg, offset } = page(q);
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM users u ${whereSql}`, params);
  const rows = await query(
    `SELECT u.*, w.available_balance, w.locked_balance,
       (SELECT COUNT(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.user_id = u.id AND m.status = 'COMPLETED') AS played
     FROM users u LEFT JOIN wallets w ON w.user_id = u.id ${whereSql}
     ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?`,
    [...params, size, offset],
  );
  res.json({
    items: rows.map((u) => ({ ...mapUser(u), wallet: { available: Number(u.available_balance || 0), locked: Number(u.locked_balance || 0) }, played: u.played, lastSeenAt: u.last_seen_at })),
    total, page: pg, pageSize: size,
  });
}));

router.get('/users/:id', ah(async (req, res) => {
  const u = await queryOne('SELECT * FROM users WHERE id = ?', [Number(req.params.id) || 0]);
  if (!u) throw notFound('User not found.');
  const [wallet, stats, transactions, matches] = await Promise.all([
    getWallet(u.id),
    getUserStats(u.id),
    listTransactions({ userId: u.id, pageSize: 25 }),
    query(`SELECT m.*, g.name AS game_name, g.slug AS game_slug, g.accent_color, mp.outcome, mp.payout,
             o.user_id AS opp_id, ou.username AS opp_username, ou.avatar_color AS opp_color, ou.is_bot AS opp_is_bot
           FROM match_players mp JOIN matches m ON m.id = mp.match_id JOIN games g ON g.id = m.game_id
           LEFT JOIN match_players o ON o.match_id = m.id AND o.user_id <> mp.user_id LEFT JOIN users ou ON ou.id = o.user_id
           WHERE mp.user_id = ? ORDER BY m.created_at DESC LIMIT 25`, [u.id]),
  ]);
  res.json({ user: { ...mapUser(u), lastSeenAt: u.last_seen_at }, wallet, stats, transactions: transactions.items, matches: matches.map(mapMatchRow) });
}));

router.post('/users/:id/status', validate(z.object({ status: z.enum(['ACTIVE', 'DISABLED']) })), ah(async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (id === req.user.id) throw badRequest('CANNOT_DISABLE_SELF', 'You cannot disable your own account.');
  const u = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) throw notFound('User not found.');
  await query('UPDATE users SET status = ? WHERE id = ?', [req.body.status, id]);
  if (req.body.status === 'DISABLED') {
    await query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [id]);
    emitToUser(id, 'session:revoked', { reason: 'Your account has been disabled.' });
  }
  await audit(req.user.id, req.body.status === 'DISABLED' ? 'USER_DISABLED' : 'USER_ENABLED', 'user', id, { username: u.username });
  const updated = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
  res.json({ user: mapUser(updated) });
}));

// ---- Transactions -----------------------------------------------------------
const txQuery = z.object({
  type: z.enum(TX_TYPES).optional().or(z.literal('').transform(() => undefined)),
  search: z.string().max(100).optional(),
  userId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
router.get('/transactions', validate(txQuery, 'query'), ah(async (req, res) => {
  res.json(await listTransactions(req.validatedQuery));
}));

// ---- Matches ----------------------------------------------------------------
const matchQuery = z.object({
  status: z.enum(['WAITING', 'MATCHED', 'READY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'ACTIVE']).optional().or(z.literal('').transform(() => undefined)),
  search: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
router.get('/matches', validate(matchQuery, 'query'), ah(async (req, res) => {
  const q = req.validatedQuery;
  const where = [];
  const params = [];
  if (q.status === 'ACTIVE') where.push(`m.status IN ('WAITING','MATCHED','READY','IN_PROGRESS')`);
  else if (q.status) { where.push('m.status = ?'); params.push(q.status); }
  if (q.search) {
    where.push('(m.code LIKE ? OR EXISTS (SELECT 1 FROM match_players x JOIN users xu ON xu.id = x.user_id WHERE x.match_id = m.id AND xu.username LIKE ?))');
    params.push(`%${q.search}%`, `%${q.search.replace(/^@/, '')}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { size, pg, offset } = page(q);
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM matches m ${whereSql}`, params);
  const rows = await query(
    `SELECT m.*, g.name AS game_name, g.slug AS game_slug, g.accent_color, wu.username AS winner_username,
       (SELECT GROUP_CONCAT(u.username ORDER BY mp.slot SEPARATOR ',') FROM match_players mp JOIN users u ON u.id = mp.user_id WHERE mp.match_id = m.id) AS players
     FROM matches m JOIN games g ON g.id = m.game_id LEFT JOIN users wu ON wu.id = m.winner_id
     ${whereSql} ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
    [...params, size, offset],
  );
  res.json({
    items: rows.map((m) => ({
      id: m.id, code: m.code, status: m.status, source: m.source,
      game: { id: m.game_id, name: m.game_name, slug: m.game_slug, accentColor: m.accent_color },
      stake: Number(m.stake), pool: Number(m.pool), fee: Number(m.fee_amount), prize: Number(m.prize),
      players: m.players ? m.players.split(',') : [], winner: m.winner_username, isDraw: !!m.is_draw,
      createdAt: m.created_at, completedAt: m.completed_at, cancelReason: m.cancel_reason,
    })),
    total, page: pg, pageSize: size,
  });
}));

router.get('/matches/:id', ah(async (req, res) => {
  res.json({ match: await getMatchView(req.params.id, req.user.id, { admin: true }) });
}));

router.post('/matches/:id/cancel', ah(async (req, res) => {
  const id = await withTransaction(async (tx) => {
    const m = await tx.one('SELECT * FROM matches WHERE id = ? OR code = ? FOR UPDATE', [Number(req.params.id) || 0, String(req.params.id)]);
    if (!m) throw notFound('Match not found.');
    if (!['WAITING', 'MATCHED', 'READY', 'IN_PROGRESS'].includes(m.status)) throw badRequest('MATCH_NOT_ACTIVE', `Match is already ${m.status.toLowerCase()}.`);
    await cancelMatchTx(tx, m, 'cancelled by an administrator');
    return m.id;
  });
  await audit(req.user.id, 'MATCH_CANCELLED', 'match', id, null);
  res.json({ match: await getMatchView(id, req.user.id, { admin: true }) });
}));

// ---- Challenges -------------------------------------------------------------
router.get('/challenges', ah(async (req, res) => {
  const status = ['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'].includes(req.query.status) ? req.query.status : null;
  const rows = await query(
    `SELECT c.*, cu.username AS challenger_username, cu.avatar_color AS challenger_color,
            ou.username AS opponent_username, ou.avatar_color AS opponent_color,
            g.slug AS game_slug, g.name AS game_name, g.accent_color, m.code AS match_code
     FROM challenges c JOIN users cu ON cu.id = c.challenger_id JOIN users ou ON ou.id = c.opponent_id
     JOIN games g ON g.id = c.game_id LEFT JOIN matches m ON m.id = c.match_id
     ${status ? 'WHERE c.status = ?' : ''} ORDER BY c.created_at DESC LIMIT 200`,
    status ? [status] : [],
  );
  res.json({ challenges: rows.map((r) => mapChallenge(r, null)) });
}));

// ---- Settings ---------------------------------------------------------------
router.get('/settings', ah(async (_req, res) => res.json({ settings: await getSettingRows() })));

router.put('/settings', validate(z.record(z.string(), z.unknown())), ah(async (req, res) => {
  const changed = await updateSettings(req.body, req.user.id);
  await audit(req.user.id, 'SETTINGS_UPDATED', 'settings', null, changed);
  emitAll('config:update', {});
  res.json({ settings: await getSettingRows(), changed });
}));

// ---- Games ------------------------------------------------------------------
router.get('/games', ah(async (_req, res) => res.json({ games: await listGames({ includeDisabled: true }) })));

router.patch('/games/:id', validate(z.object({ isEnabled: z.boolean() })), ah(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const g = await queryOne('SELECT * FROM games WHERE id = ?', [id]);
  if (!g) throw notFound('Game not found.');
  await query('UPDATE games SET is_enabled = ? WHERE id = ?', [req.body.isEnabled ? 1 : 0, id]);
  await audit(req.user.id, req.body.isEnabled ? 'GAME_ENABLED' : 'GAME_DISABLED', 'game', id, { name: g.name });
  emitAll('config:update', {});
  res.json({ game: mapGame(await queryOne('SELECT * FROM games WHERE id = ?', [id])) });
}));

// ---- Audit ------------------------------------------------------------------
router.get('/audit', ah(async (_req, res) => {
  const rows = await query(`SELECT a.*, u.username FROM admin_audit_log a JOIN users u ON u.id = a.admin_id ORDER BY a.created_at DESC, a.id DESC LIMIT 100`);
  res.json({ entries: rows.map((r) => ({ id: r.id, admin: r.username, action: r.action, targetType: r.target_type, targetId: r.target_id, details: r.details, createdAt: r.created_at })) });
}));

// Admin broadcast to a user (handy for testing notifications)
router.post('/users/:id/notify', validate(z.object({ title: z.string().min(1).max(120), message: z.string().min(1).max(255) })), ah(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const u = await queryOne('SELECT id FROM users WHERE id = ?', [id]);
  if (!u) throw notFound('User not found.');
  await notify(null, id, { type: 'ADMIN', title: req.body.title, message: req.body.message });
  await audit(req.user.id, 'USER_NOTIFIED', 'user', id, req.body);
  res.json({ ok: true });
}));

export default router;
