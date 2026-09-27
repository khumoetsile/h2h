// Match lifecycle: WAITING -> MATCHED -> READY -> IN_PROGRESS -> COMPLETED
//                  (any pre-start state) -> CANCELLED (stakes refunded)
//
// Money rules (DEMO funds):
//  * entering a match moves the stake AVAILABLE -> LOCKED (GAME_ENTRY)
//  * winner: locked stake released + prize credited (GAME_WIN)
//  * loser: locked stake removed (it funded the pool)
//  * draw / cancel: locked stake returned (REFUND)
// Settlement is guarded by `matches.settled_at` and per-event idempotency keys
// so it can never pay out twice.
import { query, queryOne, withTransaction } from '../db.js';
import { emitAll, emitToUser } from '../realtime.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { matchCode, randomSeed } from '../utils/ids.js';
import { computePrize, formatMoney, toCents } from '../utils/money.js';
import { getEngine } from '../games/index.js';
import { createRng } from '../games/rng.js';
import { getSettings } from './settingsService.js';
import { notify } from './notificationService.js';
import { chargeAbandonmentFee, forfeitStake, houseBotFloat, lockStake, payWinner, refundStake, ABANDONMENT_FEE_AMOUNT } from './walletService.js';
import { recordAudit } from './auditService.js';
import { config } from '../config.js';

export const ACTIVE_STATUSES = ['WAITING', 'MATCHED', 'READY', 'IN_PROGRESS'];
const MAX_ACTIVE_MATCHES = 5;
// Allow some network/render jitter when checking that a run took as long as it claims.
const TIMING_TOLERANCE_MS = 1500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadGame(runner, gameId) {
  const g = await runner(`SELECT * FROM games WHERE id = ?`, [gameId]);
  return g[0] || null;
}

async function validateStake(stake) {
  const settings = await getSettings();
  const amount = Number(stake);
  if (!settings.stake_amounts.some((s) => toCents(s) === toCents(amount))) {
    throw badRequest('INVALID_STAKE', `Invalid stake. Choose one of: ${settings.stake_amounts.map((s) => formatMoney(s)).join(', ')}.`);
  }
  return { amount, feePercent: settings.platform_fee_percent };
}

async function requireEnabledGame(tx, gameId) {
  const game = await loadGame(tx.q, gameId);
  if (!game) throw notFound('Game not found.');
  if (!game.is_enabled) throw badRequest('GAME_DISABLED', `${game.name} is currently unavailable.`);
  return game;
}

async function assertActiveLimit(tx, userId) {
  const [{ n }] = await tx.q(
    `SELECT COUNT(*) AS n FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE mp.user_id = ? AND m.status IN ('WAITING','MATCHED','READY','IN_PROGRESS')`,
    [userId],
  );
  if (n >= MAX_ACTIVE_MATCHES) {
    throw conflict('TOO_MANY_ACTIVE_MATCHES', `You already have ${n} active matches. Finish or cancel one first.`);
  }
}

function emitMatch(tx, matchId, userIds) {
  tx.afterCommit(async () => {
    for (const uid of userIds) {
      const view = await getMatchView(matchId, uid).catch(() => null);
      if (view) emitToUser(uid, 'match:update', view);
    }
  });
}

async function playerIds(tx, matchId) {
  return (await tx.q('SELECT user_id FROM match_players WHERE match_id = ? ORDER BY slot', [matchId])).map((r) => r.user_id);
}

// ---------------------------------------------------------------------------
// Create / join / matchmaking
// ---------------------------------------------------------------------------

/** Insert a match row + lock the creator's stake. Must run inside `tx`. */
export async function createMatchTx(tx, userId, gameId, stake, { source = 'MATCHMAKING', status = 'WAITING', category = 'SKILL_GAME' } = {}) {
  const game = await requireEnabledGame(tx, gameId);
  const { amount, feePercent } = await validateStake(stake);
  const { pool, fee, prize } = computePrize(amount, feePercent);
  const code = matchCode();
  const res = await tx.q(
    `INSERT INTO matches (code, game_id, category, stake, pool, fee_percent, fee_amount, prize, status, source, created_by, seed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [code, game.id, category, amount, pool, feePercent, fee, prize, status, source, userId, randomSeed()],
  );
  const match = { id: res.insertId, code, stake: amount, prize, fee_percent: feePercent };
  await lockStake(tx, userId, match, game.name);
  await tx.q('INSERT INTO match_players (match_id, user_id, slot, stake) VALUES (?, ?, 1, ?)', [match.id, userId, amount]);
  await recordAudit(tx, {
    actorType: 'PLAYER', actorUserId: userId, action: 'MATCH_CREATED', entityType: 'MATCH', entityId: match.id,
    matchId: match.id, newState: status, reason: source,
    metadata: { code, gameId: game.id, gameSlug: game.slug, category, stake: amount, feePercent, source },
  });
  return { match, game };
}

export async function createMatch(userId, gameId, stake) {
  return withTransaction(async (tx) => {
    await assertActiveLimit(tx, userId);
    const { match } = await createMatchTx(tx, userId, gameId, stake, { source: 'DIRECT' });
    emitMatch(tx, match.id, [userId]);
    return match.id;
  });
}

/** Add `userId` as the second player of a WAITING match (row must be locked). Exported for football matchmaking pairing. */
export async function joinLockedMatch(tx, m, userId, { autoReady = false } = {}) {
  if (m.status !== 'WAITING') {
    if (m.status === 'CANCELLED') throw conflict('MATCH_CANCELLED', 'This match was cancelled.');
    if (m.status === 'COMPLETED') throw conflict('MATCH_COMPLETED', 'This match is already completed.');
    throw conflict('MATCH_ALREADY_STARTED', 'This match already has two players.');
  }
  if (m.created_by === userId) throw badRequest('CANNOT_JOIN_OWN_MATCH', 'You cannot join your own match.');
  const game = await requireEnabledGame(tx, m.game_id);
  await lockStake(tx, userId, m, game.name);
  await tx.q('INSERT INTO match_players (match_id, user_id, slot, stake, ready_at) VALUES (?, ?, 2, ?, ?)', [m.id, userId, m.stake, autoReady ? new Date() : null]);
  await tx.q(`UPDATE matches SET status = 'MATCHED', matched_at = NOW() WHERE id = ?`, [m.id]);
  const [creator, joiner] = await Promise.all([
    tx.one('SELECT username, is_bot FROM users WHERE id = ?', [m.created_by]),
    tx.one('SELECT username, is_bot FROM users WHERE id = ?', [userId]),
  ]);
  await recordAudit(tx, {
    actorType: joiner.is_bot ? 'BOT' : 'PLAYER', actorUserId: userId, action: 'MATCH_JOINED', entityType: 'MATCH', entityId: m.id,
    matchId: m.id, previousState: 'WAITING', newState: 'MATCHED',
  });
  const link = `/match/${m.code}`;
  await notify(tx, m.created_by, { type: 'MATCH_FOUND', title: 'Opponent found', message: `${joiner.username} joined your ${game.name} match. Get ready!`, link });
  await notify(tx, userId, { type: 'MATCH_FOUND', title: 'Match found', message: `You're up against ${creator.username} in ${game.name}.`, link });
  emitMatch(tx, m.id, [m.created_by, userId]);
  tx.afterCommit(() => broadcastQueueCounts());
  return m.id;
}

export async function joinMatch(userId, matchIdOrCode) {
  return withTransaction(async (tx) => {
    await assertActiveLimit(tx, userId);
    const m = await tx.one('SELECT * FROM matches WHERE id = ? OR code = ? FOR UPDATE', [Number(matchIdOrCode) || 0, String(matchIdOrCode)]);
    if (!m) throw notFound('Match not found.');
    if (m.source === 'CHALLENGE') throw forbidden('This match was created from a private challenge.');
    return joinLockedMatch(tx, m, userId);
  });
}

/**
 * FIND OPPONENT: join the oldest WAITING public match for the same game and
 * stake, otherwise open a new WAITING match. Returns { matchId, matched }.
 */
export async function findOpponent(userId, gameId, stake) {
  await validateStake(stake);
  return withTransaction(async (tx) => {
    const own = await tx.one(
      `SELECT m.id FROM matches m WHERE m.created_by = ? AND m.status = 'WAITING' AND m.game_id = ? AND m.stake = ? AND m.source = 'MATCHMAKING' LIMIT 1`,
      [userId, gameId, stake],
    );
    if (own) return { matchId: own.id, matched: false, alreadyQueued: true };
    await assertActiveLimit(tx, userId);
    const candidate = await tx.one(
      `SELECT m.* FROM matches m
       JOIN users u ON u.id = m.created_by AND u.status = 'ACTIVE'
       WHERE m.status = 'WAITING' AND m.source = 'MATCHMAKING' AND m.game_id = ? AND m.stake = ? AND m.created_by <> ?
       ORDER BY m.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [gameId, stake, userId],
    );
    if (candidate) {
      await joinLockedMatch(tx, candidate, userId);
      return { matchId: candidate.id, matched: true };
    }
    const { match } = await createMatchTx(tx, userId, gameId, stake, { source: 'MATCHMAKING' });
    emitMatch(tx, match.id, [userId]);
    tx.afterCommit(() => broadcastQueueCounts());
    return { matchId: match.id, matched: false };
  });
}

/** Demo helper: a house bot joins a WAITING match so a single tester can play. */
export async function addDemoOpponent(userId, matchIdOrCode) {
  if (!config.demoBotsEnabled) throw forbidden('Demo opponents are disabled.');
  return withTransaction(async (tx) => {
    const m = await tx.one('SELECT * FROM matches WHERE (id = ? OR code = ?) FOR UPDATE', [Number(matchIdOrCode) || 0, String(matchIdOrCode)]);
    if (!m) throw notFound('Match not found.');
    if (m.created_by !== userId) throw forbidden('Only the match creator can call in a demo opponent.');
    const bot = await tx.one(
      `SELECT u.id FROM users u JOIN wallets w ON w.user_id = u.id
       WHERE u.is_bot = 1 AND u.status = 'ACTIVE'
         AND u.id NOT IN (SELECT user_id FROM match_players WHERE match_id = ?)
       ORDER BY (SELECT COUNT(*) FROM match_players mp JOIN matches mm ON mm.id = mp.match_id
                 WHERE mp.user_id = u.id AND mm.status IN ('WAITING','MATCHED','READY','IN_PROGRESS')), RAND()
       LIMIT 1`,
      [m.id],
    );
    if (!bot) throw conflict('OPPONENT_UNAVAILABLE', 'No demo opponents are available right now. Try again shortly.');
    // House bots are topped up with demo funds so they can always cover a stake.
    const w = await tx.one('SELECT available_balance FROM wallets WHERE user_id = ? FOR UPDATE', [bot.id]);
    if (toCents(w.available_balance) < toCents(m.stake)) {
      await houseBotFloat(tx, bot.id, 1000);
    }
    await joinLockedMatch(tx, m, bot.id, { autoReady: true });
    return m.id;
  });
}

// ---------------------------------------------------------------------------
// Ready / start / submit
// ---------------------------------------------------------------------------

async function lockMatchForPlayer(tx, userId, matchIdOrCode) {
  const m = await tx.one(
    `SELECT m.*, g.slug AS game_slug, g.name AS game_name FROM matches m JOIN games g ON g.id = m.game_id
     WHERE m.id = ? OR m.code = ? FOR UPDATE`,
    [Number(matchIdOrCode) || 0, String(matchIdOrCode)],
  );
  if (!m) throw notFound('Match not found.');
  const players = await tx.q(
    'SELECT mp.*, u.username, u.is_bot FROM match_players mp JOIN users u ON u.id = mp.user_id WHERE mp.match_id = ? ORDER BY slot FOR UPDATE',
    [m.id],
  );
  const me = players.find((p) => p.user_id === userId);
  if (!me) throw forbidden('You are not a player in this match.');
  return { m, players, me, opp: players.find((p) => p.user_id !== userId) || null };
}

function assertNotFinished(m) {
  if (m.status === 'COMPLETED') throw conflict('MATCH_COMPLETED', 'This match is already completed.');
  if (m.status === 'CANCELLED') throw conflict('MATCH_CANCELLED', `This match was cancelled${m.cancel_reason ? `: ${m.cancel_reason}` : ''}.`);
  if (m.status === 'VOID') throw conflict('MATCH_VOID', `This challenge could not be fairly completed${m.cancel_reason ? `: ${m.cancel_reason}` : ''}. Your entry was refunded.`);
}

export async function setReady(userId, matchIdOrCode) {
  return withTransaction(async (tx) => {
    const { m, players, me } = await lockMatchForPlayer(tx, userId, matchIdOrCode);
    assertNotFinished(m);
    if (m.status === 'WAITING') throw conflict('OPPONENT_UNAVAILABLE', 'Still waiting for an opponent to join.');
    if (m.status !== 'MATCHED') return m.id; // already READY / IN_PROGRESS: idempotent
    if (!me.ready_at) {
      await tx.q('UPDATE match_players SET ready_at = NOW() WHERE id = ?', [me.id]);
      await recordAudit(tx, { actorType: me.is_bot ? 'BOT' : 'PLAYER', actorUserId: userId, action: 'PLAYER_READY', entityType: 'MATCH', entityId: m.id, matchId: m.id });
    }
    const allReady = players.every((p) => p.id === me.id || p.ready_at);
    if (allReady && players.length === 2) {
      await tx.q(`UPDATE matches SET status = 'READY', ready_at = NOW() WHERE id = ?`, [m.id]);
      await recordAudit(tx, { actorType: 'SYSTEM', action: 'MATCH_READY', entityType: 'MATCH', entityId: m.id, matchId: m.id, previousState: 'MATCHED', newState: 'READY' });
      for (const p of players) {
        if (!p.is_bot) await notify(tx, p.user_id, { type: 'MATCH_STARTING', title: 'Your match is starting', message: `${m.game_name} is ready. Good luck!`, link: `/match/${m.code}` });
      }
    }
    emitMatch(tx, m.id, players.map((p) => p.user_id));
    return m.id;
  });
}

/**
 * Start playing. Reveals the (shared) game spec and records the server start
 * time used to sanity-check the submission timing.
 */
export async function startMatch(userId, matchIdOrCode) {
  return withTransaction(async (tx) => {
    const { m, players, me } = await lockMatchForPlayer(tx, userId, matchIdOrCode);
    assertNotFinished(m);
    if (!['READY', 'IN_PROGRESS'].includes(m.status)) throw conflict('MATCH_NOT_READY', 'Both players must be ready before the game starts.');
    if (me.submitted_at) throw conflict('ALREADY_SUBMITTED', 'You have already played this match. Waiting for your opponent.');
    const engine = getEngine(m.game_slug);
    const startedAt = me.started_at || new Date();
    if (!me.started_at) {
      await tx.q('UPDATE match_players SET started_at = ? WHERE id = ?', [startedAt, me.id]);
      await recordAudit(tx, { actorType: me.is_bot ? 'BOT' : 'PLAYER', actorUserId: userId, action: 'GAMEPLAY_STARTED', entityType: 'MATCH', entityId: m.id, matchId: m.id });
    }
    if (m.status === 'READY') {
      await tx.q(`UPDATE matches SET status = 'IN_PROGRESS', started_at = NOW() WHERE id = ?`, [m.id]);
      await recordAudit(tx, { actorType: 'SYSTEM', action: 'MATCH_STARTED', entityType: 'MATCH', entityId: m.id, matchId: m.id, previousState: 'READY', newState: 'IN_PROGRESS' });
      // House bots play as soon as the match goes live.
      for (const p of players) if (p.is_bot && !p.submitted_at) await submitBotResult(tx, m, p);
    }
    emitMatch(tx, m.id, players.map((p) => p.user_id));
    const settings = await getSettings();
    return {
      matchId: m.id,
      code: m.code,
      game: m.game_slug,
      spec: engine.buildSpec(Number(m.seed)),
      startedAt,
      deadline: new Date(new Date(startedAt).getTime() + settings.match_play_timeout_minutes * 60000),
      resumed: !!me.started_at,
    };
  });
}

async function submitBotResult(tx, m, p) {
  const engine = getEngine(m.game_slug);
  const seed = Number(m.seed);
  const spec = engine.buildSpec(seed);
  const actions = engine.botPlay(spec, createRng((seed ^ (p.user_id * 2654435761)) >>> 0), seed);
  const scored = engine.score(spec, actions, seed);
  await tx.q(
    `INSERT INTO game_results (match_id, user_id, score, tiebreak, is_valid, summary, rounds, client_elapsed_ms, server_elapsed_ms)
     VALUES (?, ?, ?, ?, 1, CAST(? AS JSON), CAST(? AS JSON), NULL, NULL)`,
    [m.id, p.user_id, scored.score, scored.tiebreak, JSON.stringify(scored.summary), JSON.stringify(scored.rounds)],
  );
  await tx.q('UPDATE match_players SET started_at = NOW(), submitted_at = NOW() WHERE id = ?', [p.id]);
  await recordAudit(tx, {
    actorType: 'BOT', actorUserId: p.user_id, action: 'ANSWER_SUBMITTED', entityType: 'GAME_RESULT', entityId: m.id,
    matchId: m.id, metadata: { score: scored.score, valid: true },
  });
}

/**
 * Accept the raw in-game actions from a client, score them on the server and,
 * once both players have submitted, determine the winner and settle.
 * The client never tells the server who won.
 */
export async function submitResult(userId, matchIdOrCode, body) {
  return withTransaction(async (tx) => {
    const { m, players, me } = await lockMatchForPlayer(tx, userId, matchIdOrCode);
    assertNotFinished(m);
    if (m.status !== 'IN_PROGRESS' || !me.started_at) throw conflict('MATCH_NOT_STARTED', 'You have not started this match yet.');
    if (me.submitted_at) throw conflict('ALREADY_SUBMITTED', 'Your result has already been recorded.');
    const settings = await getSettings();
    const serverElapsed = Math.max(0, Date.now() - new Date(me.started_at).getTime());
    if (serverElapsed > settings.match_play_timeout_minutes * 60000 + 30000) {
      throw conflict('MATCH_TIMED_OUT', 'Your time to play this match has expired.');
    }
    const engine = getEngine(m.game_slug);
    const seed = Number(m.seed);
    const spec = engine.buildSpec(seed);
    const scored = engine.score(spec, body?.actions ?? {}, seed);
    let valid = scored.valid;
    let invalidReason = scored.invalidReason;
    // Anti-tamper: the run can't have finished faster than the game allows.
    const minMs = engine.minDurationMs(spec, scored);
    if (valid && serverElapsed + TIMING_TOLERANCE_MS < minMs * 0.9) {
      valid = false;
      invalidReason = 'Submission timing does not match gameplay';
    }
    const clientElapsed = Number.isFinite(Number(body?.clientElapsedMs)) ? Math.max(0, Math.round(Number(body.clientElapsedMs))) : null;
    await tx.q(
      `INSERT INTO game_results (match_id, user_id, score, tiebreak, is_valid, invalid_reason, summary, rounds, client_elapsed_ms, server_elapsed_ms)
       VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?)`,
      [m.id, userId, valid ? scored.score : 0, valid ? scored.tiebreak : -2147483647, valid ? 1 : 0, invalidReason, JSON.stringify(scored.summary), JSON.stringify(scored.rounds), clientElapsed, serverElapsed],
    );
    await tx.q('UPDATE match_players SET submitted_at = NOW() WHERE id = ?', [me.id]);
    await recordAudit(tx, {
      actorType: 'PLAYER', actorUserId: userId, action: valid ? 'ANSWER_SUBMITTED' : 'ANSWER_REJECTED', entityType: 'GAME_RESULT', entityId: m.id,
      matchId: m.id, reason: valid ? null : invalidReason,
      metadata: { score: valid ? scored.score : 0, valid, invalidReason, serverElapsedMs: serverElapsed },
    });
    const others = players.filter((p) => p.id !== me.id);
    if (others.every((p) => p.submitted_at)) {
      await finalizeMatch(tx, m.id);
    }
    emitMatch(tx, m.id, players.map((p) => p.user_id));
    return { matchId: m.id, code: m.code, score: valid ? scored.score : 0, valid, invalidReason, summary: scored.summary };
  });
}

/**
 * Decide the winner from stored server-side scores and move the money.
 * Safe to call more than once: only the first call settles.
 */
export async function finalizeMatch(tx, matchId, { forfeitUserId = null, reason = null } = {}) {
  const m = await tx.one(
    'SELECT m.*, g.name AS game_name FROM matches m JOIN games g ON g.id = m.game_id WHERE m.id = ? FOR UPDATE',
    [matchId],
  );
  if (!m || m.settled_at || m.status === 'COMPLETED' || m.status === 'CANCELLED' || m.status === 'VOID') return false;
  const players = await tx.q('SELECT mp.*, u.username, u.is_bot FROM match_players mp JOIN users u ON u.id = mp.user_id WHERE match_id = ? ORDER BY slot', [matchId]);
  const results = await tx.q('SELECT * FROM game_results WHERE match_id = ?', [matchId]);
  const byUser = Object.fromEntries(results.map((r) => [r.user_id, r]));
  const [a, b] = players;
  let winner = null;
  let resultReason = reason;
  if (forfeitUserId) {
    winner = players.find((p) => p.user_id !== forfeitUserId);
  } else {
    const ra = byUser[a.user_id];
    const rb = byUser[b.user_id];
    const cmp = (ra.score - rb.score) || (ra.tiebreak - rb.tiebreak);
    if (cmp > 0) winner = a; else if (cmp < 0) winner = b;
    resultReason = winner ? (ra.score === rb.score ? 'Won on tiebreak' : 'Higher score') : 'Exact tie — stakes refunded';
  }
  // Duplicate-settlement guard.
  const upd = await tx.q(
    `UPDATE matches SET status = 'COMPLETED', completed_at = NOW(), settled_at = NOW(), winner_id = ?, is_draw = ?, result_reason = ?
     WHERE id = ? AND settled_at IS NULL`,
    [winner ? winner.user_id : null, winner ? 0 : 1, resultReason, matchId],
  );
  if (upd.affectedRows !== 1) return false;
  const settlementReference = matchCode().replace('M-', 'S-');
  await tx.q(
    `INSERT INTO settlements (match_id, reference, outcome, winner_id, pool, fee_percent, fee_amount, prize, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [matchId, settlementReference, winner ? 'WIN' : 'DRAW', winner ? winner.user_id : null, m.pool, m.fee_percent, winner ? m.fee_amount : 0, winner ? m.prize : 0, resultReason],
  );
  await recordAudit(tx, {
    actorType: 'SYSTEM', action: 'MATCH_COMPLETED', entityType: 'MATCH', entityId: matchId, matchId,
    previousState: m.status, newState: 'COMPLETED', reason: resultReason,
    metadata: { outcome: winner ? 'WIN' : 'DRAW', winnerId: winner ? winner.user_id : null, forfeited: !!forfeitUserId },
  });
  await recordAudit(tx, {
    actorType: 'SYSTEM', action: 'SETTLEMENT_CREATED', entityType: 'SETTLEMENT', entityId: settlementReference, matchId,
    reason: resultReason,
    metadata: {
      outcome: winner ? 'WIN' : 'DRAW', pool: Number(m.pool), feePercent: Number(m.fee_percent),
      feeAmount: winner ? Number(m.fee_amount) : 0, prize: winner ? Number(m.prize) : 0, winnerId: winner ? winner.user_id : null,
    },
  });
  const link = `/matches/${m.code}`;
  if (!winner) {
    for (const p of players) {
      await refundStake(tx, p.user_id, m, 'match drawn');
      await tx.q(`UPDATE match_players SET outcome = 'DRAW', payout = stake WHERE id = ?`, [p.id]);
      if (!p.is_bot) await notify(tx, p.user_id, { type: 'MATCH_DRAW', title: 'Match drawn', message: `Your ${m.game_name} match ended in a draw. Your ${formatMoney(m.stake)} entry was refunded.`, link });
    }
  } else {
    const loser = players.find((p) => p.user_id !== winner.user_id);
    await payWinner(tx, winner.user_id, m, m.game_name);
    await forfeitStake(tx, loser.user_id, m);
    await tx.q(`UPDATE match_players SET outcome = 'WIN', payout = ? WHERE id = ?`, [m.prize, winner.id]);
    await tx.q(`UPDATE match_players SET outcome = 'LOSS', payout = 0 WHERE id = ?`, [loser.id]);
    if (!winner.is_bot) await notify(tx, winner.user_id, { type: 'MATCH_WON', title: 'Victory!', message: `You won ${formatMoney(m.prize)} DEMO against ${loser.username} in ${m.game_name}.`, link });
    if (!loser.is_bot) await notify(tx, loser.user_id, { type: 'MATCH_LOST', title: 'Match lost', message: `${winner.username} won this ${m.game_name} match. Better luck next time.`, link });
  }
  emitMatch(tx, matchId, players.map((p) => p.user_id));
  tx.afterCommit(() => emitAll('leaderboard:update', {}));
  return true;
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * Cancel (never happened / no fair chance to start) or void (started fairly
 * but could not be objectively settled afterwards, e.g. a football fixture
 * abandoned mid-match) a match. Both refund every locked stake in full and
 * charge zero platform fee — a technical or external-data failure must never
 * cost a player their stake.
 */
export async function cancelMatchTx(tx, m, reason, { notifyPlayers = true, toStatus = 'CANCELLED', actorType = 'SYSTEM', actorUserId = null } = {}) {
  const upd = await tx.q(
    `UPDATE matches SET status = ?, cancelled_at = NOW(), cancel_reason = ?, settled_at = NOW()
     WHERE id = ? AND status IN ('WAITING','MATCHED','READY','IN_PROGRESS') AND settled_at IS NULL`,
    [toStatus, reason, m.id],
  );
  if (upd.affectedRows !== 1) return false;
  const game = await tx.one('SELECT name FROM games WHERE id = ?', [m.game_id]);
  const players = await tx.q('SELECT mp.*, u.is_bot FROM match_players mp JOIN users u ON u.id = mp.user_id WHERE match_id = ?', [m.id]);
  const isVoid = toStatus === 'VOID';
  await recordAudit(tx, {
    actorType, actorUserId, action: isVoid ? 'MATCH_VOID' : 'MATCH_CANCELLED', entityType: 'MATCH', entityId: m.id, matchId: m.id,
    previousState: m.status, newState: toStatus, reason,
    metadata: { pool: Number(m.pool), feeAmount: 0, refundedStakeEach: Number(m.stake) },
  });
  for (const p of players) {
    if (p.stake_locked) await refundStake(tx, p.user_id, m, reason);
    await tx.q(`UPDATE match_players SET outcome = 'REFUNDED', payout = stake WHERE id = ?`, [p.id]);
    if (notifyPlayers && !p.is_bot) {
      await notify(tx, p.user_id, {
        type: isVoid ? 'MATCH_VOID' : 'MATCH_CANCELLED',
        title: isVoid ? 'Challenge voided' : 'Match cancelled',
        message: `Your ${game.name} ${isVoid ? 'challenge could not be fairly completed' : 'match was cancelled'} (${reason}). ${formatMoney(m.stake)} DEMO was returned to your balance. No fee was charged.`,
        link: `/matches/${m.code}`,
      });
    }
  }
  const settlementReference = matchCode().replace('M-', 'S-');
  await tx.q(
    `INSERT INTO settlements (match_id, reference, outcome, pool, fee_percent, fee_amount, prize, reason)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
    [m.id, settlementReference, isVoid ? 'VOID' : 'CANCELLED', m.pool, m.fee_percent, reason],
  );
  await recordAudit(tx, {
    actorType: 'SYSTEM', action: 'SETTLEMENT_CREATED', entityType: 'SETTLEMENT', entityId: settlementReference, matchId: m.id,
    reason, metadata: { outcome: isVoid ? 'VOID' : 'CANCELLED', pool: Number(m.pool), feeAmount: 0, prize: 0 },
  });
  emitMatch(tx, m.id, players.map((p) => p.user_id));
  tx.afterCommit(() => broadcastQueueCounts());
  return true;
}

export async function cancelMatch(userId, matchIdOrCode) {
  return withTransaction(async (tx) => {
    const { m, players, me } = await lockMatchForPlayer(tx, userId, matchIdOrCode);
    assertNotFinished(m);

    // Football has no "started_at"/gameplay step — once MATCHED, both stakes
    // are locked and the challenge is considered LOCKED. Leaving at that
    // point is a real abandonment (see abandonLockedFootballMatch), not a
    // free, no-consequence cancel. Once the real fixture has kicked off
    // (IN_PROGRESS), there is nothing left to "leave" — settlement now
    // depends only on the real result.
    if (m.category === 'FOOTBALL') {
      if (m.status === 'WAITING') {
        await cancelMatchTx(tx, m, 'cancelled by player before an opponent joined', { actorType: me.is_bot ? 'BOT' : 'PLAYER', actorUserId: userId });
        return m.id;
      }
      if (m.status === 'MATCHED') {
        await abandonLockedFootballMatch(tx, m, me);
        return m.id;
      }
      throw conflict('MATCH_ALREADY_STARTED', 'This challenge has already kicked off and can no longer be left.');
    }

    if (m.status === 'IN_PROGRESS' || players.some((p) => p.started_at)) {
      throw conflict('MATCH_ALREADY_STARTED', 'The match has already started and can no longer be cancelled.');
    }
    const reason = m.status === 'WAITING' ? 'cancelled by player before an opponent joined' : `${me.username} left before the game started`;
    await cancelMatchTx(tx, m, reason, { actorType: me.is_bot ? 'BOT' : 'PLAYER', actorUserId: userId });
    return m.id;
  });
}

/**
 * A player voluntarily leaves an already-LOCKED football challenge. Reuses
 * cancelMatchTx exactly as-is for the stake side (both players fully
 * refunded, zero platform fee — the existing cancellation rule is not
 * changed), then separately charges the leaver a flat, disclosed
 * abandonment fee and records a distinct audit event so it's always
 * possible to answer "who left, when, and were they charged". Never
 * triggered by a disconnect — only this explicit, confirmed action.
 */
async function abandonLockedFootballMatch(tx, m, leaver) {
  const ok = await cancelMatchTx(tx, m, `${leaver.username} left the challenge`, { actorType: leaver.is_bot ? 'BOT' : 'PLAYER', actorUserId: leaver.user_id });
  if (!ok) return false; // already settled by someone else — idempotent no-op, no double charge
  await chargeAbandonmentFee(tx, leaver.user_id, m);
  await recordAudit(tx, {
    actorType: leaver.is_bot ? 'BOT' : 'PLAYER', actorUserId: leaver.user_id, action: 'CHALLENGE_ABANDONED',
    entityType: 'MATCH', entityId: m.id, matchId: m.id, previousState: 'MATCHED', newState: 'CANCELLED',
    reason: `${leaver.username} left a locked challenge`,
    metadata: { abandonmentFee: ABANDONMENT_FEE_AMOUNT },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Background maintenance (timeouts)
// ---------------------------------------------------------------------------

export async function sweepMatches() {
  const s = await getSettings();
  // Football matches run on the fixture's own clock (kickoff, full time),
  // which can be hours or days away — they are excluded here and instead
  // managed by the football sync service (src/football/footballSyncService.js).
  const stale = await query(
    `SELECT id, status FROM matches WHERE category = 'SKILL_GAME' AND (
       (status = 'WAITING' AND created_at < NOW() - INTERVAL ? MINUTE) OR
       (status IN ('MATCHED','READY') AND COALESCE(matched_at, created_at) < NOW() - INTERVAL ? MINUTE) OR
       (status = 'IN_PROGRESS' AND started_at < NOW() - INTERVAL ? MINUTE)
     ) LIMIT 50`,
    [s.waiting_match_timeout_minutes, s.match_start_timeout_minutes, s.match_play_timeout_minutes + 1],
  );
  let handled = 0;
  for (const row of stale) {
    await withTransaction(async (tx) => {
      const m = await tx.one('SELECT * FROM matches WHERE id = ? FOR UPDATE', [row.id]);
      if (!m || !ACTIVE_STATUSES.includes(m.status)) return;
      if (m.status === 'WAITING') { await cancelMatchTx(tx, m, 'no opponent found in time'); handled++; return; }
      if (m.status !== 'IN_PROGRESS') { await cancelMatchTx(tx, m, 'players did not start in time'); handled++; return; }
      const players = await tx.q('SELECT * FROM match_players WHERE match_id = ?', [m.id]);
      const submitted = players.filter((p) => p.submitted_at);
      if (submitted.length === 1) {
        const absent = players.find((p) => !p.submitted_at);
        await finalizeMatch(tx, m.id, { forfeitUserId: absent.user_id, reason: 'Opponent did not finish in time (forfeit)' });
      } else if (submitted.length === 0) {
        await cancelMatchTx(tx, m, 'neither player finished in time');
      } else {
        await finalizeMatch(tx, m.id);
      }
      handled++;
    });
  }
  return handled;
}

// ---------------------------------------------------------------------------
// Queries / views
// ---------------------------------------------------------------------------

function parseJson(v) {
  if (v == null) return null;
  return typeof v === 'string' ? JSON.parse(v) : v;
}

/** Football-specific detail attached to a match view/list row (null for skill games). */
export async function loadFootballSummary(matchId) {
  const row = await queryOne(
    `SELECT fc.creator_pick, fc.opponent_pick, ct.slug AS type_slug, ct.name AS type_name, ct.question_template, ct.pick_type,
            fx.id AS fixture_id, fx.kickoff_at, fx.status AS fixture_status, fx.minute, fx.home_score, fx.away_score,
            fx.home_shots, fx.away_shots, fx.home_shots_on_target, fx.away_shots_on_target,
            fx.home_possession, fx.away_possession, fx.home_corners, fx.away_corners, fx.home_cards, fx.away_cards,
            comp.name AS competition_name, comp.code AS competition_code,
            ht.name AS home_team, ht.short_name AS home_team_short, at.name AS away_team, at.short_name AS away_team_short
     FROM football_challenges fc
     JOIN football_challenge_types ct ON ct.id = fc.challenge_type_id
     JOIN football_fixtures fx ON fx.id = fc.fixture_id
     JOIN football_competitions comp ON comp.id = fx.competition_id
     JOIN football_teams ht ON ht.id = fx.home_team_id
     JOIN football_teams at ON at.id = fx.away_team_id
     WHERE fc.match_id = ?`,
    [matchId],
  );
  if (!row) return null;
  const pickLabel = (pick) => {
    if (pick === 'HOME') return row.home_team_short || row.home_team;
    if (pick === 'AWAY') return row.away_team_short || row.away_team;
    return pick;
  };
  return {
    fixtureId: row.fixture_id,
    competition: { name: row.competition_name, code: row.competition_code },
    homeTeam: row.home_team, awayTeam: row.away_team,
    kickoffAt: row.kickoff_at, fixtureStatus: row.fixture_status, minute: row.minute,
    homeScore: row.home_score, awayScore: row.away_score,
    // Whatever the fixture doesn't have yet is simply null here — these
    // columns are only ever populated once the fixture is LIVE/FINISHED, so
    // this can never leak a stat before it's fair for players to see it.
    stats: {
      shots: { home: row.home_shots, away: row.away_shots },
      shotsOnTarget: { home: row.home_shots_on_target, away: row.away_shots_on_target },
      possession: { home: row.home_possession, away: row.away_possession },
      corners: { home: row.home_corners, away: row.away_corners },
      cards: { home: row.home_cards, away: row.away_cards },
    },
    challengeType: { slug: row.type_slug, name: row.type_name, question: row.question_template.replace('{home}', row.home_team_short || row.home_team).replace('{away}', row.away_team_short || row.away_team), pickType: row.pick_type },
    creatorPick: row.creator_pick, creatorPickLabel: pickLabel(row.creator_pick),
    opponentPick: row.opponent_pick, opponentPickLabel: row.opponent_pick ? pickLabel(row.opponent_pick) : null,
  };
}

export async function getMatchView(matchIdOrCode, viewerId, { admin = false } = {}) {
  const m = await queryOne(
    `SELECT m.*, g.slug AS game_slug, g.name AS game_name, g.accent_color FROM matches m JOIN games g ON g.id = m.game_id
     WHERE m.id = ? OR m.code = ?`,
    [Number(matchIdOrCode) || 0, String(matchIdOrCode)],
  );
  if (!m) throw notFound('Match not found.');
  const players = await query(
    `SELECT mp.*, u.username, u.first_name, u.last_name, u.avatar_color, u.is_bot FROM match_players mp
     JOIN users u ON u.id = mp.user_id WHERE mp.match_id = ? ORDER BY slot`,
    [m.id],
  );
  if (!admin && !players.some((p) => p.user_id === viewerId)) throw forbidden('You are not a player in this match.');
  const showResults = m.status === 'COMPLETED' || admin;
  const results = showResults ? await query('SELECT * FROM game_results WHERE match_id = ?', [m.id]) : [];
  const byUser = Object.fromEntries(results.map((r) => [r.user_id, r]));
  const settings = await getSettings();
  const deadline = (base, minutes) => (base ? new Date(new Date(base).getTime() + minutes * 60000) : null);
  const football = m.category === 'FOOTBALL' ? await loadFootballSummary(m.id) : null;
  return {
    id: m.id,
    code: m.code,
    status: m.status,
    source: m.source,
    category: m.category,
    football,
    game: { id: m.game_id, slug: m.game_slug, name: m.game_name, accentColor: m.accent_color },
    stake: Number(m.stake),
    pool: Number(m.pool),
    feePercent: Number(m.fee_percent),
    fee: Number(m.fee_amount),
    prize: Number(m.prize),
    isDemo: true,
    winnerId: m.winner_id,
    isDraw: !!m.is_draw,
    resultReason: m.result_reason,
    cancelReason: m.cancel_reason,
    createdBy: m.created_by,
    createdAt: m.created_at,
    matchedAt: m.matched_at,
    readyAt: m.ready_at,
    startedAt: m.started_at,
    completedAt: m.completed_at,
    cancelledAt: m.cancelled_at,
    deadlines: {
      waitingExpiresAt: m.status === 'WAITING' ? deadline(m.created_at, settings.waiting_match_timeout_minutes) : null,
      startBy: ['MATCHED', 'READY'].includes(m.status) ? deadline(m.matched_at, settings.match_start_timeout_minutes) : null,
    },
    viewerId,
    players: players.map((p) => {
      const r = byUser[p.user_id];
      return {
        userId: p.user_id,
        username: p.username,
        displayName: `${p.first_name} ${p.last_name}`,
        avatarColor: p.avatar_color,
        isBot: !!p.is_bot,
        slot: p.slot,
        ready: !!p.ready_at,
        started: !!p.started_at,
        submitted: !!p.submitted_at,
        outcome: p.outcome,
        payout: Number(p.payout),
        result: r ? {
          score: r.score,
          valid: !!r.is_valid,
          invalidReason: r.invalid_reason,
          summary: parseJson(r.summary),
          rounds: parseJson(r.rounds),
          serverElapsedMs: r.server_elapsed_ms,
        } : null,
      };
    }),
  };
}

export async function listMatchesForUser(userId, { filter = 'all', page = 1, pageSize = 20, active = false, category = null } = {}) {
  const where = ['mp.user_id = ?'];
  const params = [userId];
  if (category === 'FOOTBALL' || category === 'SKILL_GAME') { where.push('m.category = ?'); params.push(category); }
  if (active) where.push(`m.status IN ('WAITING','MATCHED','READY','IN_PROGRESS')`);
  else if (filter === 'wins') where.push(`mp.outcome = 'WIN'`);
  else if (filter === 'losses') where.push(`mp.outcome = 'LOSS'`);
  else if (filter === 'cancelled') where.push(`m.status IN ('CANCELLED','VOID')`);
  else if (filter === 'completed') where.push(`m.status = 'COMPLETED'`);
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const pg = Math.max(Number(page) || 1, 1);
  const whereSql = where.join(' AND ');
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE ${whereSql}`, params);
  const rows = await query(
    `SELECT m.*, g.name AS game_name, g.slug AS game_slug, g.accent_color, mp.outcome, mp.payout,
            o.user_id AS opp_id, ou.username AS opp_username, ou.avatar_color AS opp_color, ou.is_bot AS opp_is_bot,
            gr.score AS my_score, ogr.score AS opp_score,
            comp.name AS fx_competition, ht.short_name AS fx_home, at.short_name AS fx_away, ct.name AS fx_type_name
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     JOIN games g ON g.id = m.game_id
     LEFT JOIN match_players o ON o.match_id = m.id AND o.user_id <> mp.user_id
     LEFT JOIN users ou ON ou.id = o.user_id
     LEFT JOIN game_results gr ON gr.match_id = m.id AND gr.user_id = mp.user_id AND m.status = 'COMPLETED'
     LEFT JOIN game_results ogr ON ogr.match_id = m.id AND ogr.user_id = o.user_id AND m.status = 'COMPLETED'
     LEFT JOIN football_challenges fc ON fc.match_id = m.id
     LEFT JOIN football_fixtures fx ON fx.id = fc.fixture_id
     LEFT JOIN football_competitions comp ON comp.id = fx.competition_id
     LEFT JOIN football_teams ht ON ht.id = fx.home_team_id
     LEFT JOIN football_teams at ON at.id = fx.away_team_id
     LEFT JOIN football_challenge_types ct ON ct.id = fc.challenge_type_id
     WHERE ${whereSql}
     ORDER BY COALESCE(m.completed_at, m.cancelled_at, m.created_at) DESC, m.id DESC LIMIT ? OFFSET ?`,
    [...params, size, (pg - 1) * size],
  );
  return { items: rows.map(mapMatchRow), total, page: pg, pageSize: size };
}

export function mapMatchRow(r) {
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    source: r.source,
    category: r.category,
    football: r.category === 'FOOTBALL' ? {
      competition: r.fx_competition, homeTeam: r.fx_home, awayTeam: r.fx_away, questionName: r.fx_type_name,
    } : null,
    game: { id: r.game_id, slug: r.game_slug, name: r.game_name, accentColor: r.accent_color },
    stake: Number(r.stake),
    prize: Number(r.prize),
    fee: Number(r.fee_amount),
    outcome: r.outcome ?? null,
    payout: r.payout != null ? Number(r.payout) : null,
    opponent: r.opp_id ? { userId: r.opp_id, username: r.opp_username, avatarColor: r.opp_color, isBot: !!r.opp_is_bot } : null,
    myScore: r.my_score ?? null,
    opponentScore: r.opp_score ?? null,
    isDraw: !!r.is_draw,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    cancelledAt: r.cancelled_at,
    isDemo: true,
  };
}

/** Number of players currently waiting per game (optionally per stake). */
export async function queueCounts() {
  const rows = await query(
    `SELECT game_id, stake, COUNT(*) AS n FROM matches WHERE status = 'WAITING' AND source = 'MATCHMAKING' GROUP BY game_id, stake`,
  );
  const out = {};
  for (const r of rows) {
    out[r.game_id] ??= { total: 0, byStake: {} };
    out[r.game_id].total += r.n;
    out[r.game_id].byStake[Number(r.stake)] = r.n;
  }
  return out;
}

async function broadcastQueueCounts() {
  emitAll('queue:update', await queueCounts());
}
