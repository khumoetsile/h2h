// Direct player challenges. No money moves when a challenge is sent; both
// stakes are locked atomically only when the opponent ACCEPTS, which creates
// a real match (source = CHALLENGE) in the MATCHED state.
import { query, withTransaction } from '../db.js';
import { emitToUser } from '../realtime.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { formatMoney, toCents } from '../utils/money.js';
import { getSettings } from './settingsService.js';
import { notify } from './notificationService.js';
import { createMatchTx, getMatchView, ACTIVE_STATUSES } from './matchService.js';
import { lockStake } from './walletService.js';

const PENDING_LIMIT = 10;

export function mapChallenge(c, viewerId) {
  return {
    id: c.id,
    status: c.status,
    direction: viewerId === c.challenger_id ? 'OUTGOING' : 'INCOMING',
    challenger: { userId: c.challenger_id, username: c.challenger_username, avatarColor: c.challenger_color },
    opponent: { userId: c.opponent_id, username: c.opponent_username, avatarColor: c.opponent_color },
    game: { id: c.game_id, slug: c.game_slug, name: c.game_name, accentColor: c.accent_color },
    stake: Number(c.stake),
    potentialPrize: c.prize_preview != null ? Number(c.prize_preview) : null,
    message: c.message,
    matchId: c.match_id,
    matchCode: c.match_code || null,
    expiresAt: c.expires_at,
    respondedAt: c.responded_at,
    createdAt: c.created_at,
    isDemo: true,
  };
}

const SELECT = `
  SELECT c.*, cu.username AS challenger_username, cu.avatar_color AS challenger_color,
         ou.username AS opponent_username, ou.avatar_color AS opponent_color,
         g.slug AS game_slug, g.name AS game_name, g.accent_color, m.code AS match_code
  FROM challenges c
  JOIN users cu ON cu.id = c.challenger_id
  JOIN users ou ON ou.id = c.opponent_id
  JOIN games g ON g.id = c.game_id
  LEFT JOIN matches m ON m.id = c.match_id`;

async function withPrize(rows) {
  const { platform_fee_percent: fee } = await getSettings();
  return rows.map((r) => ({ ...r, prize_preview: (toCents(r.stake) * 2 * (1 - fee / 100)) / 100 }));
}

export async function getChallenge(id, viewerId, { admin = false } = {}) {
  const rows = await withPrize(await query(`${SELECT} WHERE c.id = ?`, [id]));
  const c = rows[0];
  if (!c) throw notFound('Challenge not found.');
  if (!admin && c.challenger_id !== viewerId && c.opponent_id !== viewerId) throw forbidden('This challenge is not yours.');
  return mapChallenge(c, viewerId);
}

export async function listChallenges(userId, { box = 'all', status } = {}) {
  const where = [];
  const params = [];
  if (box === 'incoming') { where.push('c.opponent_id = ?'); params.push(userId); }
  else if (box === 'outgoing') { where.push('c.challenger_id = ?'); params.push(userId); }
  else { where.push('(c.challenger_id = ? OR c.opponent_id = ?)'); params.push(userId, userId); }
  if (status === 'active') where.push(`c.status = 'PENDING'`);
  else if (status === 'history') where.push(`c.status <> 'PENDING'`);
  const rows = await withPrize(await query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT 100`, params));
  return rows.map((r) => mapChallenge(r, userId));
}

export async function createChallenge(challengerId, { opponent, gameId, stake, message }) {
  const settings = await getSettings();
  if (!settings.stake_amounts.some((s) => toCents(s) === toCents(stake))) {
    throw badRequest('INVALID_STAKE', `Invalid stake. Choose one of: ${settings.stake_amounts.map((s) => formatMoney(s)).join(', ')}.`);
  }
  const id = await withTransaction(async (tx) => {
    const handle = String(opponent || '').replace(/^@/, '').trim();
    const opp = typeof opponent === 'number'
      ? await tx.one('SELECT * FROM users WHERE id = ?', [opponent])
      : await tx.one('SELECT * FROM users WHERE username = ?', [handle]);
    if (!opp) throw notFound('No player found with that username.');
    if (opp.id === challengerId) throw badRequest('CANNOT_CHALLENGE_SELF', "You can't challenge yourself.");
    if (opp.status !== 'ACTIVE') throw conflict('OPPONENT_UNAVAILABLE', `@${opp.username} is not available for challenges.`);
    if (opp.role !== 'PLAYER') throw conflict('OPPONENT_UNAVAILABLE', `@${opp.username} cannot be challenged.`);
    const game = await tx.one('SELECT * FROM games WHERE id = ?', [gameId]);
    if (!game) throw notFound('Game not found.');
    if (!game.is_enabled) throw badRequest('GAME_DISABLED', `${game.name} is currently unavailable.`);
    const wallet = await tx.one('SELECT available_balance FROM wallets WHERE user_id = ?', [challengerId]);
    if (toCents(wallet.available_balance) < toCents(stake)) {
      throw badRequest('INSUFFICIENT_BALANCE', `You need ${formatMoney(stake)} DEMO available to send this challenge.`);
    }
    const dup = await tx.one(
      `SELECT id FROM challenges WHERE status = 'PENDING' AND expires_at > NOW() AND game_id = ?
       AND ((challenger_id = ? AND opponent_id = ?) OR (challenger_id = ? AND opponent_id = ?)) LIMIT 1 FOR UPDATE`,
      [gameId, challengerId, opp.id, opp.id, challengerId],
    );
    if (dup) throw conflict('DUPLICATE_CHALLENGE', `There is already a pending ${game.name} challenge between you and @${opp.username}.`);
    const [{ n }] = await tx.q(`SELECT COUNT(*) AS n FROM challenges WHERE challenger_id = ? AND status = 'PENDING' AND expires_at > NOW()`, [challengerId]);
    if (n >= PENDING_LIMIT) throw conflict('TOO_MANY_CHALLENGES', `You can have at most ${PENDING_LIMIT} pending challenges.`);
    const me = await tx.one('SELECT username FROM users WHERE id = ?', [challengerId]);
    const res = await tx.q(
      `INSERT INTO challenges (challenger_id, opponent_id, game_id, stake, message, expires_at)
       VALUES (?, ?, ?, ?, ?, NOW() + INTERVAL ? MINUTE)`,
      [challengerId, opp.id, gameId, stake, message ? String(message).slice(0, 140) : null, settings.challenge_expiry_minutes],
    );
    await notify(tx, opp.id, {
      type: 'CHALLENGE_RECEIVED',
      title: `${me.username} challenged you`,
      message: `@${me.username} challenged you to ${game.name} for ${formatMoney(stake)} DEMO.`,
      link: '/challenges',
    });
    tx.afterCommit(() => emitToUser(opp.id, 'challenge:update', { id: res.insertId }));
    return res.insertId;
  });
  return getChallenge(id, challengerId);
}

async function lockChallenge(tx, id) {
  const c = await tx.one('SELECT * FROM challenges WHERE id = ? FOR UPDATE', [id]);
  if (!c) throw notFound('Challenge not found.');
  return c;
}

function assertPending(c) {
  if (c.status === 'PENDING' && new Date(c.expires_at) <= new Date()) throw conflict('CHALLENGE_EXPIRED', 'This challenge has expired.');
  if (c.status !== 'PENDING') throw conflict('CHALLENGE_CLOSED', `This challenge is already ${c.status.toLowerCase()}.`);
}

export async function acceptChallenge(userId, id) {
  const matchId = await withTransaction(async (tx) => {
    const c = await lockChallenge(tx, id);
    if (c.opponent_id !== userId) throw forbidden('Only the challenged player can accept.');
    assertPending(c);
    const [challenger, me] = await Promise.all([
      tx.one('SELECT * FROM users WHERE id = ?', [c.challenger_id]),
      tx.one('SELECT username FROM users WHERE id = ?', [userId]),
    ]);
    if (challenger.status !== 'ACTIVE') throw conflict('OPPONENT_UNAVAILABLE', 'The challenger is no longer available.');
    const [{ n }] = await tx.q(
      `SELECT COUNT(*) AS n FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.user_id IN (?, ?) AND m.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`,
      [c.challenger_id, userId, ...ACTIVE_STATUSES],
    );
    if (n >= 10) throw conflict('TOO_MANY_ACTIVE_MATCHES', 'Too many active matches. Finish one first.');
    // Lock wallets in a consistent (id) order to avoid deadlocks.
    for (const uid of [c.challenger_id, userId].sort((a, b) => a - b)) {
      await tx.q('SELECT id FROM wallets WHERE user_id = ? FOR UPDATE', [uid]);
    }
    const cw = await tx.one('SELECT available_balance FROM wallets WHERE user_id = ?', [c.challenger_id]);
    if (toCents(cw.available_balance) < toCents(c.stake)) {
      throw conflict('OPPONENT_INSUFFICIENT_BALANCE', `@${challenger.username} no longer has enough demo funds for this challenge.`);
    }
    // Creates the match and locks the challenger's stake…
    const { match, game } = await createMatchTx(tx, c.challenger_id, c.game_id, c.stake, { source: 'CHALLENGE', status: 'MATCHED' });
    // …then locks the accepting player's stake (throws INSUFFICIENT_BALANCE -> full rollback).
    await lockStake(tx, userId, match, game.name);
    await tx.q('INSERT INTO match_players (match_id, user_id, slot, stake) VALUES (?, ?, 2, ?)', [match.id, userId, c.stake]);
    await tx.q('UPDATE matches SET matched_at = NOW() WHERE id = ?', [match.id]);
    await tx.q(`UPDATE challenges SET status = 'ACCEPTED', responded_at = NOW(), match_id = ? WHERE id = ?`, [match.id, c.id]);
    await notify(tx, c.challenger_id, {
      type: 'CHALLENGE_ACCEPTED',
      title: 'Challenge accepted',
      message: `@${me.username} accepted your ${game.name} challenge. Your match is ready to start.`,
      link: `/match/${match.code}`,
    });
    for (const uid of [c.challenger_id, userId]) tx.afterCommit(() => emitToUser(uid, 'challenge:update', { id: c.id }));
    return match.id;
  });
  return getMatchView(matchId, userId);
}

export async function declineChallenge(userId, id) {
  await withTransaction(async (tx) => {
    const c = await lockChallenge(tx, id);
    if (c.opponent_id !== userId) throw forbidden('Only the challenged player can decline.');
    assertPending(c);
    await tx.q(`UPDATE challenges SET status = 'DECLINED', responded_at = NOW() WHERE id = ?`, [c.id]);
    const [me, game] = await Promise.all([
      tx.one('SELECT username FROM users WHERE id = ?', [userId]),
      tx.one('SELECT name FROM games WHERE id = ?', [c.game_id]),
    ]);
    await notify(tx, c.challenger_id, { type: 'CHALLENGE_DECLINED', title: 'Challenge declined', message: `@${me.username} declined your ${game.name} challenge.`, link: '/challenges' });
    for (const uid of [c.challenger_id, userId]) tx.afterCommit(() => emitToUser(uid, 'challenge:update', { id: c.id }));
  });
  return getChallenge(id, userId);
}

export async function cancelChallenge(userId, id) {
  await withTransaction(async (tx) => {
    const c = await lockChallenge(tx, id);
    if (c.challenger_id !== userId) throw forbidden('Only the challenger can cancel this challenge.');
    assertPending(c);
    await tx.q(`UPDATE challenges SET status = 'CANCELLED', responded_at = NOW() WHERE id = ?`, [c.id]);
    for (const uid of [c.challenger_id, c.opponent_id]) tx.afterCommit(() => emitToUser(uid, 'challenge:update', { id: c.id }));
  });
  return getChallenge(id, userId);
}

export async function expireChallenges() {
  const rows = await query(
    `SELECT c.id FROM challenges c WHERE c.status = 'PENDING' AND c.expires_at <= NOW() LIMIT 100`,
  );
  for (const { id } of rows) {
    await withTransaction(async (tx) => {
      const c = await tx.one(`SELECT c.*, g.name AS game_name, ou.username AS opp FROM challenges c JOIN games g ON g.id = c.game_id JOIN users ou ON ou.id = c.opponent_id WHERE c.id = ? FOR UPDATE`, [id]);
      if (!c || c.status !== 'PENDING') return;
      await tx.q(`UPDATE challenges SET status = 'EXPIRED' WHERE id = ?`, [id]);
      await notify(tx, c.challenger_id, { type: 'CHALLENGE_EXPIRED', title: 'Challenge expired', message: `Your ${c.game_name} challenge to @${c.opp} expired without a response.`, link: '/challenges' });
    });
  }
  return rows.length;
}
