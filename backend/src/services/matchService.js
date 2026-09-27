// Match lifecycle: WAITING -> MATCHED -> READY -> IN_PROGRESS -> COMPLETED
//                  (any pre-start state) -> CANCELLED (stakes refunded)
//
//   WAITING      one player, waiting for an opponent (acceptance timer)
//   MATCHED      two players, both must press Lock In (lock-in timer)
//   READY        both locked in — the challenge is LOCKED (game / kickoff timer)
//   IN_PROGRESS  gameplay started / the real fixture kicked off
// Every timer is a deadline stamped on the row — see src/timers.js.
//
// Money rules (DEMO funds):
//  * entering a match moves the stake AVAILABLE -> LOCKED (GAME_ENTRY)
//  * winner: locked stake released + prize credited (GAME_WIN)
//  * loser: locked stake removed (it funded the pool)
//  * draw / cancel / void: locked stake returned (REFUND), zero platform fee
//  * leaving after BOTH players locked in: full refunds + ABANDONMENT_FEE for the leaver only
// Settlement is guarded by `matches.settled_at` and per-event idempotency keys
// so it can never pay out twice.
import { query, queryOne, withTransaction } from '../db.js';
import { emitAll, emitToUser, isUserOnline } from '../realtime.js';
import {
  TIMERS, acceptanceDeadline, earliest, footballCompletionDeadline, isPast, lockInDeadline, owesAction,
  playerActionDeadline, playerDeadline, reconnectDeadline, skillCompletionDeadline,
} from '../timers.js';
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

/** Kickoff of the fixture behind a football match (null for skill games). */
export async function kickoffFor(runner, matchId) {
  const rows = await runner(
    'SELECT fx.kickoff_at FROM football_challenges fc JOIN football_fixtures fx ON fx.id = fc.fixture_id WHERE fc.match_id = ?',
    [matchId],
  );
  return rows[0]?.kickoff_at ?? null;
}

// ---------------------------------------------------------------------------
// Create / join / matchmaking
// ---------------------------------------------------------------------------

/**
 * Insert a match row + lock the creator's stake. Must run inside `tx`.
 * Stamps the timer for the starting phase: WAITING gets an acceptance
 * deadline, MATCHED (a direct challenge just accepted) a lock-in deadline.
 * `kickoffAt` caps both for football — nothing may outlive kickoff.
 */
export async function createMatchTx(tx, userId, gameId, stake, { source = 'MATCHMAKING', status = 'WAITING', category = 'SKILL_GAME', kickoffAt = null, lockIn = false } = {}) {
  const game = await requireEnabledGame(tx, gameId);
  const { amount, feePercent } = await validateStake(stake);
  const { pool, fee, prize } = computePrize(amount, feePercent);
  const code = matchCode();
  const now = new Date();
  const acceptBy = status === 'WAITING' ? acceptanceDeadline(now, kickoffAt) : null;
  const lockBy = status === 'MATCHED' ? lockInDeadline(now, kickoffAt) : null;
  const res = await tx.q(
    `INSERT INTO matches (code, game_id, category, stake, pool, fee_percent, fee_amount, prize, status, source, created_by, seed,
                          acceptance_deadline, lock_in_deadline, matched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [code, game.id, category, amount, pool, feePercent, fee, prize, status, source, userId, randomSeed(), acceptBy, lockBy, status === 'MATCHED' ? now : null],
  );
  const match = { id: res.insertId, code, stake: amount, prize, fee_percent: feePercent };
  await lockStake(tx, userId, match, game.name);
  // `lockIn`: the creator confirmed the lock-in terms (with the abandonment
  // fee disclosed) as part of creating it — e.g. a football Find Opponent.
  await tx.q('INSERT INTO match_players (match_id, user_id, slot, stake, ready_at) VALUES (?, ?, 1, ?, ?)', [match.id, userId, amount, lockIn ? now : null]);
  await recordAudit(tx, {
    actorType: 'PLAYER', actorUserId: userId, action: 'MATCH_CREATED', entityType: 'MATCH', entityId: match.id,
    matchId: match.id, newState: status, reason: source,
    metadata: { code, gameId: game.id, gameSlug: game.slug, category, stake: amount, feePercent, source, acceptanceDeadline: acceptBy, lockInDeadline: lockBy, creatorLockedIn: lockIn },
  });
  if (lockIn) await recordAudit(tx, { actorType: 'PLAYER', actorUserId: userId, action: 'PLAYER_READY', entityType: 'MATCH', entityId: match.id, matchId: match.id, metadata: { lockedIn: true, atCreation: true } });
  return { match, game };
}

/**
 * Record that `userId` pressed Lock In on a MATCHED match (row must be
 * locked). If the opponent hasn't locked in yet, their player-action timer
 * starts. Once both have, the challenge is LOCKED: status READY, locked_at
 * set, and the completion timer starts (skill game: game timer; football:
 * the fixture's result deadline). Idempotent per player.
 */
export async function recordLockIn(tx, matchId, userId, { actorType = 'PLAYER' } = {}) {
  const m = await tx.one(`SELECT m.*, g.name AS game_name FROM matches m JOIN games g ON g.id = m.game_id WHERE m.id = ? FOR UPDATE`, [matchId]);
  if (m.status !== 'MATCHED') return m.status;
  const players = await tx.q('SELECT mp.*, u.is_bot FROM match_players mp JOIN users u ON u.id = mp.user_id WHERE mp.match_id = ? ORDER BY slot', [matchId]);
  const me = players.find((p) => p.user_id === userId);
  const now = new Date();
  if (!me.ready_at) {
    await tx.q('UPDATE match_players SET ready_at = ? WHERE id = ?', [now, me.id]);
    me.ready_at = now;
    await recordAudit(tx, { actorType, actorUserId: userId, action: 'PLAYER_READY', entityType: 'MATCH', entityId: matchId, matchId, metadata: { lockedIn: true } });
  }
  const other = players.find((p) => p.user_id !== userId);
  if (!other) return m.status;
  if (!other.ready_at) {
    if (!m.player_action_deadline) {
      const actBy = playerActionDeadline(now, m.lock_in_deadline);
      await tx.q('UPDATE matches SET player_action_deadline = ? WHERE id = ?', [actBy, matchId]);
      await recordAudit(tx, { actorType: 'SYSTEM', action: 'PLAYER_ACTION_TIMER_STARTED', entityType: 'MATCH', entityId: matchId, matchId, metadata: { waitingFor: other.user_id, deadline: actBy, phase: 'LOCK_IN' } });
    }
    emitMatch(tx, matchId, players.map((p) => p.user_id));
    return 'MATCHED';
  }
  const kickoffAt = m.category === 'FOOTBALL' ? await kickoffFor(tx.q, matchId) : null;
  const completeBy = m.category === 'FOOTBALL' ? footballCompletionDeadline(kickoffAt) : skillCompletionDeadline(now);
  await tx.q(
    `UPDATE matches SET status = 'READY', ready_at = ?, locked_at = ?, completion_deadline = ?, player_action_deadline = NULL WHERE id = ?`,
    [now, now, completeBy, matchId],
  );
  await recordAudit(tx, {
    actorType: 'SYSTEM', action: 'MATCH_READY', entityType: 'MATCH', entityId: matchId, matchId, previousState: 'MATCHED', newState: 'READY',
    reason: 'Both players locked in', metadata: { lockedAt: now, completionDeadline: completeBy },
  });
  for (const p of players) {
    if (!p.is_bot) {
      await notify(tx, p.user_id, {
        type: 'MATCH_STARTING', title: 'Locked in',
        message: m.category === 'FOOTBALL' ? 'Both players are locked in. The challenge goes live at kickoff.' : `Both players are locked in — ${m.game_name} is ready. Good luck!`,
        link: `/match/${m.code}`,
      });
    }
  }
  emitMatch(tx, matchId, players.map((p) => p.user_id));
  return 'READY';
}

export async function createMatch(userId, gameId, stake) {
  return withTransaction(async (tx) => {
    await assertActiveLimit(tx, userId);
    const { match } = await createMatchTx(tx, userId, gameId, stake, { source: 'DIRECT' });
    emitMatch(tx, match.id, [userId]);
    return match.id;
  });
}

/**
 * Add `userId` as the second player of a WAITING match (row must be locked).
 * Exported for football matchmaking pairing. Strictly 1v1: anything but
 * WAITING — including a WAITING match whose acceptance timer already ran out
 * but hasn't been swept yet — is rejected. `lockIn` records the joiner's
 * Lock In in the same transaction (they confirmed "Accept & Lock In").
 */
export async function joinLockedMatch(tx, m, userId, { lockIn = false, isBot = false } = {}) {
  if (m.status !== 'WAITING') {
    if (m.status === 'CANCELLED') throw conflict('MATCH_CANCELLED', 'This match was cancelled.');
    if (m.status === 'COMPLETED') throw conflict('MATCH_COMPLETED', 'This match is already completed.');
    throw conflict('MATCH_ALREADY_STARTED', 'This match already has two players.');
  }
  if (m.created_by === userId) throw badRequest('CANNOT_JOIN_OWN_MATCH', 'You cannot join your own match.');
  const now = new Date();
  if (isPast(m.acceptance_deadline, now)) throw conflict('CHALLENGE_EXPIRED', 'This challenge expired — no opponent joined in time.');
  const game = await requireEnabledGame(tx, m.game_id);
  const kickoffAt = m.category === 'FOOTBALL' ? await kickoffFor(tx.q, m.id) : null;
  await lockStake(tx, userId, m, game.name);
  await tx.q('INSERT INTO match_players (match_id, user_id, slot, stake) VALUES (?, ?, 2, ?)', [m.id, userId, m.stake]);
  const lockBy = lockInDeadline(now, kickoffAt);
  await tx.q(`UPDATE matches SET status = 'MATCHED', matched_at = ?, lock_in_deadline = ? WHERE id = ?`, [now, lockBy, m.id]);
  const [creator, joiner] = await Promise.all([
    tx.one('SELECT username, is_bot FROM users WHERE id = ?', [m.created_by]),
    tx.one('SELECT username, is_bot FROM users WHERE id = ?', [userId]),
  ]);
  await recordAudit(tx, {
    actorType: joiner.is_bot ? 'BOT' : 'PLAYER', actorUserId: userId, action: 'MATCH_JOINED', entityType: 'MATCH', entityId: m.id,
    matchId: m.id, previousState: 'WAITING', newState: 'MATCHED', metadata: { lockInDeadline: lockBy },
  });
  const link = `/match/${m.code}`;
  const creatorLocked = !!(await tx.one('SELECT ready_at FROM match_players WHERE match_id = ? AND user_id = ?', [m.id, m.created_by]))?.ready_at;
  await notify(tx, m.created_by, creatorLocked
    ? { type: 'MATCH_FOUND', title: 'Opponent found — locked in', message: `${joiner.username} joined your challenge. You're both locked in.`, link }
    : { type: 'MATCH_FOUND', title: 'Opponent found — lock in now', message: `${joiner.username} joined your ${game.name} match. Lock in before the timer runs out.`, link });
  if (!joiner.is_bot) await notify(tx, userId, { type: 'MATCH_FOUND', title: 'Match found', message: `You're up against ${creator.username} in ${game.name}.`, link });
  if (lockIn || isBot) await recordLockIn(tx, m.id, userId, { actorType: joiner.is_bot ? 'BOT' : 'PLAYER' });
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
         AND (m.acceptance_deadline IS NULL OR m.acceptance_deadline > ?)
       ORDER BY m.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [gameId, stake, userId, new Date()],
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
    await joinLockedMatch(tx, m, bot.id, { isBot: true });
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

/** This player's own deadline in the current phase (with reconnection grace), for enforcement. */
async function myDeadline(tx, m, me) {
  const kickoffAt = m.category === 'FOOTBALL' ? await kickoffFor(tx.q, m.id) : null;
  return playerDeadline(m, me, kickoffAt);
}

/** LOCK IN. Rejected once this player's lock-in time has run out (even if the sweeper hasn't caught up yet). */
export async function setReady(userId, matchIdOrCode) {
  return withTransaction(async (tx) => {
    const { m, me } = await lockMatchForPlayer(tx, userId, matchIdOrCode);
    assertNotFinished(m);
    if (m.status === 'WAITING') throw conflict('OPPONENT_UNAVAILABLE', 'Still waiting for an opponent to join.');
    if (m.status !== 'MATCHED') return m.id; // already locked: idempotent
    if (m.category === 'FOOTBALL') {
      const kickoffAt = await kickoffFor(tx.q, m.id);
      if (isPast(kickoffAt)) throw conflict('CHALLENGE_CLOSED', 'This match has already kicked off, so this challenge can no longer be locked in.');
    }
    if (!me.ready_at && isPast(await myDeadline(tx, m, me), new Date(), TIMERS.latencyGraceMs)) {
      throw conflict('LOCK_IN_EXPIRED', 'Your time to lock in has run out.');
    }
    await recordLockIn(tx, m.id, userId, { actorType: me.is_bot ? 'BOT' : 'PLAYER' });
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
    if (m.category !== 'SKILL_GAME') throw conflict('MATCH_NOT_READY', 'Football challenges are decided by the real match — there is nothing to play.');
    if (!['READY', 'IN_PROGRESS'].includes(m.status)) throw conflict('MATCH_NOT_READY', 'Both players must lock in before the game starts.');
    if (me.submitted_at) throw conflict('ALREADY_SUBMITTED', 'You have already played this match. Waiting for your opponent.');
    const deadline = await myDeadline(tx, m, me);
    if (isPast(deadline)) throw conflict('MATCH_TIMED_OUT', 'Your time to play this match has run out.');
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
    return {
      matchId: m.id,
      code: m.code,
      game: m.game_slug,
      spec: engine.buildSpec(Number(m.seed)),
      startedAt,
      deadline,
      serverNow: new Date(),
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
    const serverElapsed = Math.max(0, Date.now() - new Date(me.started_at).getTime());
    // The deadline is the stored one — whatever the client's clock says or
    // claims about elapsed time is irrelevant here.
    if (isPast(await myDeadline(tx, m, me), new Date(), TIMERS.latencyGraceMs)) {
      throw conflict('MATCH_TIMED_OUT', 'Your time to play this match has run out.');
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
    } else if (!m.player_action_deadline) {
      // First to finish: the opponent now has the (shorter) player-action
      // window, never beyond the overall game deadline.
      const actBy = playerActionDeadline(new Date(), m.completion_deadline);
      await tx.q('UPDATE matches SET player_action_deadline = ? WHERE id = ?', [actBy, m.id]);
      await recordAudit(tx, {
        actorType: 'SYSTEM', action: 'PLAYER_ACTION_TIMER_STARTED', entityType: 'MATCH', entityId: m.id, matchId: m.id,
        metadata: { waitingFor: others[0]?.user_id ?? null, deadline: actBy, phase: 'GAME' },
      });
    }
    emitMatch(tx, m.id, players.map((p) => p.user_id));
    return { matchId: m.id, code: m.code, score: valid ? scored.score : 0, valid, invalidReason, summary: scored.summary };
  });
}

/**
 * Decide the winner from stored server-side scores and move the money.
 * Safe to call more than once: only the first call settles.
 */
export async function finalizeMatch(tx, matchId, { forfeitUserId = null, reason = null, endReason = null } = {}) {
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
    `UPDATE matches SET status = 'COMPLETED', completed_at = NOW(), settled_at = NOW(), winner_id = ?, is_draw = ?, result_reason = ?, end_reason = ?
     WHERE id = ? AND settled_at IS NULL`,
    [winner ? winner.user_id : null, winner ? 0 : 1, resultReason, endReason, matchId],
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
export async function cancelMatchTx(tx, m, reason, { notifyPlayers = true, toStatus = 'CANCELLED', actorType = 'SYSTEM', actorUserId = null, endReason = null, abandonedBy = null } = {}) {
  const upd = await tx.q(
    `UPDATE matches SET status = ?, cancelled_at = NOW(), cancel_reason = ?, settled_at = NOW(), end_reason = ?, abandoned_by = ?
     WHERE id = ? AND status IN ('WAITING','MATCHED','READY','IN_PROGRESS') AND settled_at IS NULL`,
    [toStatus, reason, endReason, abandonedBy, m.id],
  );
  if (upd.affectedRows !== 1) return false;
  const game = await tx.one('SELECT name FROM games WHERE id = ?', [m.game_id]);
  const players = await tx.q('SELECT mp.*, u.is_bot FROM match_players mp JOIN users u ON u.id = mp.user_id WHERE match_id = ?', [m.id]);
  const isVoid = toStatus === 'VOID';
  await recordAudit(tx, {
    actorType, actorUserId, action: isVoid ? 'MATCH_VOID' : 'MATCH_CANCELLED', entityType: 'MATCH', entityId: m.id, matchId: m.id,
    previousState: m.status, newState: toStatus, reason,
    metadata: { pool: Number(m.pool), feeAmount: 0, refundedStakeEach: Number(m.stake), endReason },
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

/**
 * LEAVE / CANCEL. The rule is the same for every category:
 *   WAITING  (no opponent yet)            free — full refund, no fee
 *   MATCHED  (not both locked in yet)     free — both refunded in full, no fee
 *   READY    (both locked in = LOCKED)    abandonment — both refunded in full,
 *                                         the leaver alone pays the abandonment fee
 *   IN_PROGRESS (game started / kicked off) cannot be left; the timers decide it
 * The fee is only ever reachable after the player pressed Lock In on a
 * screen that disclosed it.
 */
export async function cancelMatch(userId, matchIdOrCode) {
  return withTransaction(async (tx) => {
    const { m, players, me } = await lockMatchForPlayer(tx, userId, matchIdOrCode);
    assertNotFinished(m);
    const actor = { actorType: me.is_bot ? 'BOT' : 'PLAYER', actorUserId: userId };
    if (m.status === 'IN_PROGRESS' || players.some((p) => p.started_at)) {
      throw conflict('MATCH_ALREADY_STARTED', m.category === 'FOOTBALL'
        ? 'This challenge has already kicked off and can no longer be left.'
        : 'The match has already started and can no longer be cancelled.');
    }
    if (m.status === 'WAITING') {
      await cancelMatchTx(tx, m, 'cancelled by player before an opponent joined', { ...actor, endReason: 'PLAYER_CANCELLED' });
    } else if (m.status === 'MATCHED') {
      await cancelMatchTx(tx, m, `${me.username} left before the challenge was locked`, { ...actor, endReason: 'PLAYER_CANCELLED' });
    } else {
      await abandonLockedMatch(tx, m, me);
    }
    return m.id;
  });
}

/**
 * A player voluntarily leaves a LOCKED challenge. Reuses cancelMatchTx
 * as-is for the stakes (both players fully refunded, zero platform fee),
 * then separately charges only the leaver the flat, disclosed abandonment
 * fee and records a distinct audit event. Never triggered by a disconnect
 * or a timeout — only this explicit, confirmed action.
 */
async function abandonLockedMatch(tx, m, leaver) {
  const ok = await cancelMatchTx(tx, m, `${leaver.username} left the challenge`, {
    actorType: leaver.is_bot ? 'BOT' : 'PLAYER', actorUserId: leaver.user_id, endReason: 'ABANDONED', abandonedBy: leaver.user_id,
  });
  if (!ok) return false; // already settled by someone else — idempotent no-op, no double charge
  await chargeAbandonmentFee(tx, leaver.user_id, m);
  await recordAudit(tx, {
    actorType: leaver.is_bot ? 'BOT' : 'PLAYER', actorUserId: leaver.user_id, action: 'CHALLENGE_ABANDONED',
    entityType: 'MATCH', entityId: m.id, matchId: m.id, previousState: m.status, newState: 'CANCELLED',
    reason: `${leaver.username} left a locked challenge`,
    metadata: { abandonmentFee: ABANDONMENT_FEE_AMOUNT },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Background maintenance (timeouts)
// ---------------------------------------------------------------------------

/**
 * Give any active row that predates stored deadlines (or was created by a
 * path that didn't stamp one) its deadline from config, so every active
 * challenge is always governed by a timer. Cheap no-op once filled in.
 */
export async function backfillDeadlines() {
  await query(
    `UPDATE matches SET acceptance_deadline = created_at + INTERVAL ? SECOND WHERE status = 'WAITING' AND acceptance_deadline IS NULL`,
    [TIMERS.challengeAcceptanceSeconds],
  );
  await query(
    `UPDATE matches SET lock_in_deadline = COALESCE(matched_at, created_at) + INTERVAL ? SECOND WHERE status = 'MATCHED' AND lock_in_deadline IS NULL`,
    [TIMERS.lockInSeconds],
  );
  await query(
    `UPDATE matches SET locked_at = COALESCE(locked_at, ready_at, matched_at, created_at),
            completion_deadline = COALESCE(ready_at, matched_at, created_at) + INTERVAL ? SECOND
     WHERE category = 'SKILL_GAME' AND status IN ('READY','IN_PROGRESS') AND completion_deadline IS NULL`,
    [TIMERS.lockedGameSeconds],
  );
  await query(
    `UPDATE matches m JOIN football_challenges fc ON fc.match_id = m.id JOIN football_fixtures fx ON fx.id = fc.fixture_id
     SET m.locked_at = COALESCE(m.locked_at, m.ready_at, m.matched_at, m.created_at), m.completion_deadline = fx.kickoff_at + INTERVAL ? MINUTE
     WHERE m.category = 'FOOTBALL' AND m.status IN ('READY','IN_PROGRESS') AND m.completion_deadline IS NULL`,
    [TIMERS.footballResultTimeoutMinutes],
  );
}

async function usernames(tx, ids) {
  if (!ids.length) return [];
  const rows = await tx.q('SELECT id, username FROM users WHERE id IN (?)', [ids]);
  return ids.map((id) => rows.find((r) => r.id === id)?.username ?? 'A player');
}

/** Returns the owing players whose time is up, or null while any owing player's time (incl. reconnection grace) is still running. */
function expiredOwers(m, players, now, kickoffAt = null) {
  const owing = players.filter((p) => owesAction(m, p));
  if (owing.some((p) => !isPast(playerDeadline(m, p, kickoffAt), now))) return null;
  return owing;
}

/**
 * Background enforcement of every timer. Idempotent and safe to run on
 * several servers at once: each match is re-read under a row lock, every
 * condition is re-checked, and settlement is guarded by `settled_at`.
 * Timeout rules (deterministic, all server-side):
 *  - WAITING past its acceptance deadline      -> CANCELLED, NO_OPPONENT, full refund, no fee
 *  - MATCHED and a player never locked in      -> CANCELLED, LOCK_IN_TIMEOUT, full refunds, no fee
 *  - skill game, one finished, other didn't    -> the one who didn't forfeits (ACTION_TIMEOUT)
 *  - skill game, neither finished              -> CANCELLED, GAME_TIMEOUT, full refunds, no fee
 *  - skill game, both finished                 -> normal result
 *  - football locked, no verifiable result by the result deadline -> VOID, RESULT_TIMEOUT, full refunds, no fee
 * The abandonment fee is never charged by a timeout.
 */
export async function sweepMatches(now = new Date()) {
  await backfillDeadlines();
  let handled = 0;
  const run = async (id, fn) => {
    try {
      const did = await withTransaction(async (tx) => {
        const m = await tx.one('SELECT * FROM matches WHERE id = ? FOR UPDATE', [id]);
        if (!m || m.settled_at || !ACTIVE_STATUSES.includes(m.status)) return false;
        return fn(tx, m);
      });
      if (did) handled++;
    } catch (err) {
      console.error('Sweeper failed for match', id, err);
    }
  };

  // 1. Acceptance timer.
  for (const { id } of await query(`SELECT id FROM matches WHERE status = 'WAITING' AND acceptance_deadline <= ? LIMIT 200`, [now])) {
    await run(id, async (tx, m) => {
      if (m.status !== 'WAITING' || !isPast(m.acceptance_deadline, now)) return false;
      return cancelMatchTx(tx, m, 'No opponent joined in time', { endReason: 'NO_OPPONENT' });
    });
  }

  // 2. Lock-in timer (and the player-action timer within it).
  const lockIns = await query(
    `SELECT m.id FROM matches m LEFT JOIN football_challenges fc ON fc.match_id = m.id LEFT JOIN football_fixtures fx ON fx.id = fc.fixture_id
     WHERE m.status = 'MATCHED' AND (m.lock_in_deadline <= ? OR m.player_action_deadline <= ? OR fx.kickoff_at <= ?) LIMIT 200`,
    [now, now, now],
  );
  for (const { id } of lockIns) {
    await run(id, async (tx, m) => {
      if (m.status !== 'MATCHED') return false;
      const kickoffAt = m.category === 'FOOTBALL' ? await kickoffFor(tx.q, m.id) : null;
      const players = await tx.q('SELECT * FROM match_players WHERE match_id = ? ORDER BY slot FOR UPDATE', [m.id]);
      const late = expiredOwers(m, players, now, kickoffAt);
      if (!late || !late.length) return false;
      const names = await usernames(tx, late.map((p) => p.user_id));
      const reason = late.length === players.length ? 'Neither player locked in before the timer ran out' : `${names[0]} did not lock in before the timer ran out`;
      return cancelMatchTx(tx, m, reason, { endReason: 'LOCK_IN_TIMEOUT' });
    });
  }

  // 3. Skill-game completion timer and player-action timer.
  const games = await query(
    `SELECT id FROM matches WHERE category = 'SKILL_GAME' AND status IN ('READY','IN_PROGRESS')
       AND (completion_deadline <= ? OR player_action_deadline <= ?) LIMIT 200`,
    [now, now],
  );
  for (const { id } of games) {
    await run(id, async (tx, m) => {
      const players = await tx.q('SELECT * FROM match_players WHERE match_id = ? ORDER BY slot FOR UPDATE', [m.id]);
      const late = expiredOwers(m, players, now);
      if (!late) return false;
      if (late.length === 0) return finalizeMatch(tx, m.id);
      if (late.length === 1 && players.length === 2) {
        const [name] = await usernames(tx, [late[0].user_id]);
        return finalizeMatch(tx, m.id, { forfeitUserId: late[0].user_id, reason: `${name} did not finish in time (timed out)`, endReason: 'ACTION_TIMEOUT' });
      }
      return cancelMatchTx(tx, m, 'Neither player finished before the game timer ran out', { endReason: 'GAME_TIMEOUT' });
    });
  }

  // 4. Football result deadline (a safety net under the football sync service,
  //    judged against the fixture's CURRENT kickoff in case it moved).
  const football = await query(
    `SELECT m.id FROM matches m JOIN football_challenges fc ON fc.match_id = m.id JOIN football_fixtures fx ON fx.id = fc.fixture_id
     WHERE m.category = 'FOOTBALL' AND m.status IN ('READY','IN_PROGRESS')
       AND fx.kickoff_at + INTERVAL ? MINUTE <= ? LIMIT 200`,
    [TIMERS.footballResultTimeoutMinutes, now],
  );
  for (const { id } of football) {
    await run(id, async (tx, m) => cancelMatchTx(tx, m, 'the result could not be verified in time', { toStatus: 'VOID', endReason: 'RESULT_TIMEOUT' }));
  }
  return handled;
}

// ---------------------------------------------------------------------------
// Presence (reconnection window)
// ---------------------------------------------------------------------------

/**
 * Called when a player's last socket drops (online=false) or a socket
 * connects (online=true). Only matches where the player still owes an
 * action get a reconnection window — a locked football challenge waiting
 * for kickoff needs nothing from anyone, so going offline there is a no-op.
 * Losing connection never costs anything by itself; see timers.js.
 *
 * A drop opens a window only if none is already running, so repeated
 * drops can't stack extensions. Reconnecting deliberately leaves the
 * window in place: a player who comes back inside it keeps the time it
 * granted to actually act (it's still capped at deadline + window).
 */
export async function markPresence(userId, online, now = new Date()) {
  const rows = await query(
    `SELECT mp.id, mp.match_id, mp.reconnect_deadline FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE mp.user_id = ? AND (
       (m.status = 'MATCHED' AND mp.ready_at IS NULL) OR
       (m.category = 'SKILL_GAME' AND m.status IN ('READY','IN_PROGRESS') AND mp.submitted_at IS NULL)
     )`,
    [userId],
  );
  const running = (r) => r.reconnect_deadline && new Date(r.reconnect_deadline) > now;
  const affected = online ? rows.filter(running) : rows.filter((r) => !running(r));
  if (!affected.length) return 0;
  if (!online) {
    await query('UPDATE match_players SET disconnected_at = ?, reconnect_deadline = ? WHERE id IN (?)', [now, reconnectDeadline(now), affected.map((r) => r.id)]);
  }
  for (const { match_id: matchId } of affected) {
    await recordAudit(null, {
      actorType: 'SYSTEM', actorUserId: userId, action: online ? 'PLAYER_RECONNECTED' : 'PLAYER_DISCONNECTED', entityType: 'MATCH', entityId: matchId, matchId,
      metadata: online ? {} : { reconnectDeadline: reconnectDeadline(now) },
    }).catch(() => {});
    const uids = (await query('SELECT user_id FROM match_players WHERE match_id = ?', [matchId])).map((r) => r.user_id);
    for (const uid of uids) {
      const view = await getMatchView(matchId, uid).catch(() => null);
      if (view) emitToUser(uid, 'match:update', view);
    }
  }
  return affected.length;
}

// ---------------------------------------------------------------------------
// Server restarts
// ---------------------------------------------------------------------------

export async function heartbeat(now = new Date()) {
  await query(
    `INSERT INTO system_heartbeats (name, beat_at) VALUES ('sweeper', ?) ON DUPLICATE KEY UPDATE beat_at = VALUES(beat_at)`,
    [now],
  );
}

/**
 * On boot: if the sweeper's last heartbeat is older than `thresholdMs`, the
 * platform itself was down and nobody could act. Extend every player-driven
 * timer that was still running at that moment by the outage length, so no
 * one is timed out for our downtime. Football result deadlines follow the
 * real match and are deliberately not extended. Returns seconds extended.
 */
export async function compensateDowntime({ now = new Date(), thresholdMs = 30000 } = {}) {
  const row = await queryOne(`SELECT beat_at FROM system_heartbeats WHERE name = 'sweeper'`);
  if (!row) return 0;
  const since = new Date(row.beat_at);
  const gapMs = now.getTime() - since.getTime();
  if (gapMs <= thresholdMs) return 0;
  const gap = Math.round(gapMs / 1000);
  await query(`UPDATE matches SET acceptance_deadline = acceptance_deadline + INTERVAL ? SECOND WHERE status = 'WAITING' AND acceptance_deadline > ?`, [gap, since]);
  await query(`UPDATE matches SET lock_in_deadline = lock_in_deadline + INTERVAL ? SECOND WHERE status = 'MATCHED' AND lock_in_deadline > ?`, [gap, since]);
  await query(`UPDATE matches SET player_action_deadline = player_action_deadline + INTERVAL ? SECOND WHERE status IN ('MATCHED','READY','IN_PROGRESS') AND player_action_deadline > ?`, [gap, since]);
  await query(`UPDATE matches SET completion_deadline = completion_deadline + INTERVAL ? SECOND WHERE category = 'SKILL_GAME' AND status IN ('READY','IN_PROGRESS') AND completion_deadline > ?`, [gap, since]);
  await query(`UPDATE match_players mp JOIN matches m ON m.id = mp.match_id SET mp.reconnect_deadline = mp.reconnect_deadline + INTERVAL ? SECOND
               WHERE m.status IN ('MATCHED','READY','IN_PROGRESS') AND mp.reconnect_deadline > ?`, [gap, since]);
  await query(`UPDATE challenges SET expires_at = expires_at + INTERVAL ? SECOND WHERE status = 'PENDING' AND expires_at > ?`, [gap, since]);
  await recordAudit(null, { actorType: 'SYSTEM', action: 'TIMERS_EXTENDED_AFTER_DOWNTIME', entityType: 'SYSTEM', entityId: 'sweeper', metadata: { downtimeSeconds: gap, lastHeartbeat: since } }).catch(() => {});
  return gap;
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
            fx.home_possession, fx.away_possession, fx.home_corners, fx.away_corners, fx.home_cards, fx.away_cards, fx.first_goal_team,
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
    homeScore: row.home_score, awayScore: row.away_score, firstGoalTeam: row.first_goal_team,
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
  const football = m.category === 'FOOTBALL' ? await loadFootballSummary(m.id) : null;
  const kickoffAt = football?.kickoffAt ?? null;
  const active = ACTIVE_STATUSES.includes(m.status);
  const viewer = players.find((p) => p.user_id === viewerId) ?? null;
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
    endReason: m.end_reason,
    abandonedBy: m.abandoned_by,
    createdBy: m.created_by,
    createdAt: m.created_at,
    matchedAt: m.matched_at,
    readyAt: m.ready_at,
    lockedAt: m.locked_at,
    startedAt: m.started_at,
    completedAt: m.completed_at,
    cancelledAt: m.cancelled_at,
    // Authoritative timestamps. Clients render remaining time as
    // (deadline - serverNow), corrected for their own clock offset — they
    // never decide when anything expires.
    timers: {
      serverNow: new Date(),
      acceptanceDeadline: m.status === 'WAITING' ? m.acceptance_deadline : null,
      lockInDeadline: m.status === 'MATCHED' ? earliest(m.lock_in_deadline, kickoffAt) : null,
      playerActionDeadline: active ? m.player_action_deadline : null,
      completionDeadline: active && m.status !== 'WAITING' && m.status !== 'MATCHED' ? m.completion_deadline : null,
      kickoffAt,
      myDeadline: active && viewer ? playerDeadline(m, viewer, kickoffAt) : null,
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
        lockedIn: !!p.ready_at,
        started: !!p.started_at,
        submitted: !!p.submitted_at,
        owesAction: active && owesAction(m, p),
        deadline: active ? playerDeadline(m, p, kickoffAt) : null,
        connected: p.is_bot ? true : isUserOnline(p.user_id),
        // Only while they're actually offline with a window still running.
        reconnectDeadline: active && !p.is_bot && !isUserOnline(p.user_id) && p.reconnect_deadline && new Date(p.reconnect_deadline) > new Date() ? p.reconnect_deadline : null,
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
  else if (filter === 'draws') where.push(`m.status = 'COMPLETED' AND m.is_draw = 1`);
  else if (filter === 'void') where.push(`m.status = 'VOID'`);
  else if (filter === 'timed_out') where.push(`m.end_reason IN ('NO_OPPONENT','LOCK_IN_TIMEOUT','ACTION_TIMEOUT','GAME_TIMEOUT','RESULT_TIMEOUT')`);
  else if (filter === 'cancelled') where.push(`m.status IN ('CANCELLED','VOID')`);
  else if (filter === 'completed') where.push(`m.status = 'COMPLETED'`);
  else if (filter === 'ended') where.push(`m.status IN ('COMPLETED','CANCELLED','VOID')`);
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const pg = Math.max(Number(page) || 1, 1);
  const whereSql = where.join(' AND ');
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE ${whereSql}`, params);
  const rows = await query(
    `SELECT m.*, g.name AS game_name, g.slug AS game_slug, g.accent_color, mp.outcome, mp.payout,
            mp.user_id AS me_id, mp.ready_at AS me_ready, mp.submitted_at AS me_submitted, mp.disconnected_at AS me_disconnected, mp.reconnect_deadline AS me_reconnect,
            o.user_id AS opp_id, ou.username AS opp_username, ou.avatar_color AS opp_color, ou.is_bot AS opp_is_bot, o.ready_at AS opp_ready,
            gr.score AS my_score, ogr.score AS opp_score,
            comp.name AS fx_competition, ht.short_name AS fx_home, at.short_name AS fx_away, ct.name AS fx_type_name,
            ct.slug AS fx_type_slug, ct.question_template AS fx_question, fc.creator_pick AS fx_creator_pick, fc.opponent_pick AS fx_opponent_pick,
            fx.id AS fx_id, fx.kickoff_at AS fx_kickoff, fx.status AS fx_status, fx.minute AS fx_minute, fx.home_score AS fx_home_score, fx.away_score AS fx_away_score
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
  return { items: rows.map(mapMatchRow), total, page: pg, pageSize: size, serverNow: new Date() };
}

/**
 * What a player should read on their history row — one unambiguous state
 * per challenge: WAITING_FOR_OPPONENT, LOCKING_IN, LOCKED_IN, IN_PROGRESS,
 * WON, LOST, DRAW, VOID, EXPIRED, TIMED_OUT, LEFT (you left), OPPONENT_LEFT, CANCELLED.
 */
export function displayState(r, outcome = r.outcome) {
  switch (r.status) {
    case 'WAITING': return 'WAITING_FOR_OPPONENT';
    case 'MATCHED': return 'LOCKING_IN';
    case 'READY': return 'LOCKED_IN';
    case 'IN_PROGRESS': return 'IN_PROGRESS';
    case 'COMPLETED': return r.is_draw ? 'DRAW' : outcome === 'WIN' ? 'WON' : 'LOST';
    case 'VOID': return 'VOID';
    default:
      if (r.end_reason === 'NO_OPPONENT') return 'EXPIRED';
      if (['LOCK_IN_TIMEOUT', 'GAME_TIMEOUT', 'ACTION_TIMEOUT'].includes(r.end_reason)) return 'TIMED_OUT';
      if (r.end_reason === 'ABANDONED') return r.me_id != null && r.abandoned_by !== r.me_id ? 'OPPONENT_LEFT' : 'LEFT';
      return 'CANCELLED';
  }
}

export function mapMatchRow(r) {
  const pickLabel = (pick) => (pick === 'HOME' ? r.fx_home : pick === 'AWAY' ? r.fx_away : pick === 'YES' ? 'Yes' : pick === 'NO' ? 'No' : null);
  const iAmCreator = r.me_id != null ? r.me_id === r.created_by : null;
  const active = ACTIVE_STATUSES.includes(r.status);
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    displayState: displayState(r),
    endReason: r.end_reason ?? null,
    abandonedBy: r.abandoned_by ?? null,
    source: r.source,
    category: r.category,
    football: r.category === 'FOOTBALL' ? {
      fixtureId: r.fx_id ?? null,
      competition: r.fx_competition, homeTeam: r.fx_home, awayTeam: r.fx_away, questionName: r.fx_type_name,
      challengeTypeSlug: r.fx_type_slug ?? null,
      question: r.fx_question ? r.fx_question.replace('{home}', r.fx_home).replace('{away}', r.fx_away) : null,
      kickoffAt: r.fx_kickoff ?? null, fixtureStatus: r.fx_status ?? null, minute: r.fx_minute ?? null,
      homeScore: r.fx_home_score ?? null, awayScore: r.fx_away_score ?? null,
      myPickLabel: iAmCreator == null ? null : pickLabel(iAmCreator ? r.fx_creator_pick : r.fx_opponent_pick),
      opponentPickLabel: iAmCreator == null ? null : pickLabel(iAmCreator ? r.fx_opponent_pick : r.fx_creator_pick),
    } : null,
    timers: active ? {
      acceptanceDeadline: r.status === 'WAITING' ? r.acceptance_deadline : null,
      lockInDeadline: r.status === 'MATCHED' ? earliest(r.lock_in_deadline, r.fx_kickoff) : null,
      playerActionDeadline: r.player_action_deadline ?? null,
      completionDeadline: r.status === 'READY' || r.status === 'IN_PROGRESS' ? r.completion_deadline : null,
      myDeadline: r.me_id != null ? playerDeadline(r, { ready_at: r.me_ready, submitted_at: r.me_submitted, disconnected_at: r.me_disconnected, reconnect_deadline: r.me_reconnect }, r.fx_kickoff ?? null) : null,
    } : null,
    lockedIn: r.me_id != null ? !!r.me_ready : null,
    opponentLockedIn: r.opp_id ? !!r.opp_ready : null,
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
