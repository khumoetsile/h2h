// Live penalty shootout: runs a locked PvP match round by round.
//
// The match itself (lock-in, stakes, settlement, refunds, abandonment) is the
// normal match lifecycle in matchService. This service only replaces the
// "each player plays alone and submits a score" part:
//
//   join   both players take the pitch -> round 1 is created
//   kick   the kicker submits { zone, stopMs }       (sealed until the keeper has chosen)
//   dive   the keeper submits { col }                (sealed until the kicker has chosen)
//   -> when both are in (or a round's deadline passes and the missing choice is
//      made for the player) the round resolves, the next one is created, and
//      when the shootout is decided both players' scores are written as normal
//      game results and the match settles through finalizeMatch().
//
// Everything is decided here. A client only ever sends its own choice and only
// ever receives what has already been revealed, never the other side's pending choice.
import { query, queryOne, withTransaction } from '../db.js';
import { emitToUser } from '../realtime.js';
import { TIMERS } from '../timers.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { assertNotFinished, cancelMatchTx, finalizeMatch } from './matchService.js';
import { recordAudit } from './auditService.js';
import { notify } from './notificationService.js';
import { liveSlugs } from '../games/index.js';
import * as rules from '../games/liveShootout.js';

/** A started shootout that is still not finished after this long is abandoned (safety net). */
const LIVE_MAX_MS = 20 * 60 * 1000;
/** Window around the server-observed arrival time in which a reported stop time is believed. */
const STOP_EARLY_TOLERANCE_MS = 1500;
const STOP_LATE_TOLERANCE_MS = 300;
/** A player who lets this many kicks in a row be decided for them has left the game. */
const MAX_AUTO_IN_A_ROW = 2;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** The shootout as one particular player may see it: resolved rounds in full, the open round without anyone's pending choice. */
function buildView(m, players, rounds, viewerId) {
  const firstSlot = rules.firstKickerSlot(m.seed);
  const first = players.find((p) => p.slot === firstSlot);
  const second = players.find((p) => p.slot !== firstSlot);
  const resolved = rounds.filter((r) => r.resolved_at);
  const stand = rules.standing(resolved.map((r) => ({ kickerId: r.kicker_id, outcome: r.outcome })), first.user_id, second.user_id);
  const open = rounds.find((r) => !r.resolved_at) ?? null;
  const allStarted = players.every((p) => p.started_at);
  const finished = ['COMPLETED', 'CANCELLED', 'VOID'].includes(m.status);

  let current = null;
  if (open) {
    const iAmKicker = open.kicker_id === viewerId;
    const myLocked = iAmKicker ? open.kicker_zone != null : open.keeper_col != null;
    const theirLocked = iAmKicker ? open.keeper_col != null : open.kicker_zone != null;
    current = {
      no: open.round_no,
      kickerId: open.kicker_id,
      keeperId: open.keeper_id,
      role: iAmKicker ? 'KICKER' : 'KEEPER',
      startsAt: iso(open.starts_at),
      deadline: iso(open.deadline),
      // Only the kicker needs the bar; it is derived from the match seed, not a secret.
      timing: iAmKicker ? { periodMs: open.period_ms, phase: Number(open.phase) } : null,
      myLocked,
      opponentLocked: theirLocked,
    };
  }

  return {
    code: m.code,
    matchStatus: m.status,
    phase: finished ? 'FINISHED' : !allStarted ? 'LOBBY' : 'ROUND',
    // While waiting for the other player to take the pitch: when they run out of time.
    lobbyDeadline: !finished && !allStarted ? iso(m.player_action_deadline) : null,
    serverNow: new Date().toISOString(),
    viewerId,
    firstKickerId: first.user_id,
    players: players.map((p) => ({ userId: p.user_id, username: p.username, avatarColor: p.avatar_color, isBot: !!p.is_bot, onPitch: !!p.started_at })),
    goals: stand.goals,
    kicksTaken: stand.taken,
    suddenDeath: stand.suddenDeath,
    kicksPerSide: rules.KICKS_PER_SIDE,
    decisionMs: rules.DECISION_MS,
    done: stand.done || finished,
    winnerId: m.winner_id ?? stand.winnerId ?? null,
    current,
    history: resolved.map((r) => ({
      no: r.round_no,
      kickerId: r.kicker_id,
      keeperId: r.keeper_id,
      zone: r.kicker_zone,
      keeperCol: r.keeper_col,
      outcome: r.outcome,
      quality: r.quality,
      marker: r.marker == null ? null : Number(r.marker),
      kickerAuto: !!r.kicker_auto,
      keeperAuto: !!r.keeper_auto,
    })),
    // The viewer's own pending choice, so a reload restores their selection.
    myChoice: open
      ? (open.kicker_id === viewerId
        ? (open.kicker_zone != null ? { zone: open.kicker_zone } : null)
        : (open.keeper_col != null ? { col: open.keeper_col } : null))
      : null,
  };
}

async function loadAll(runner, matchId) {
  const m = (await runner(`SELECT m.*, g.slug AS game_slug FROM matches m JOIN games g ON g.id = m.game_id WHERE m.id = ?`, [matchId]))[0];
  const players = await runner(
    `SELECT mp.*, u.username, u.avatar_color, u.is_bot FROM match_players mp JOIN users u ON u.id = mp.user_id WHERE mp.match_id = ? ORDER BY slot`,
    [matchId],
  );
  const rounds = await runner('SELECT * FROM shootout_rounds WHERE match_id = ? ORDER BY round_no', [matchId]);
  return { m, players, rounds };
}

/** Push each human player their own view. */
async function emitState(matchId) {
  const { m, players, rounds } = await loadAll(query, matchId);
  if (!m || players.length < 2) return;
  for (const p of players) if (!p.is_bot) emitToUser(p.user_id, 'shootout:state', buildView(m, players, rounds, p.user_id));
}

export async function getLiveState(userId, matchIdOrCode) {
  const row = await queryOne('SELECT id FROM matches WHERE id = ? OR code = ?', [Number(matchIdOrCode) || 0, String(matchIdOrCode)]);
  if (!row) throw notFound('Match not found.');
  const { m, players, rounds } = await loadAll(query, row.id);
  if (!liveSlugs.includes(m.game_slug)) throw badRequest('NOT_A_LIVE_GAME', 'This game is not played live.');
  if (!players.some((p) => p.user_id === userId)) throw forbidden('You are not a player in this match.');
  if (players.length < 2) throw conflict('MATCH_NOT_READY', 'Waiting for an opponent.');
  return buildView(m, players, rounds, userId);
}

// ---------------------------------------------------------------------------
// Locking helpers
// ---------------------------------------------------------------------------

async function lockMatch(tx, matchIdOrCode) {
  const m = await tx.one(
    `SELECT m.*, g.slug AS game_slug, g.name AS game_name FROM matches m JOIN games g ON g.id = m.game_id WHERE m.id = ? OR m.code = ? FOR UPDATE`,
    [Number(matchIdOrCode) || 0, String(matchIdOrCode)],
  );
  if (!m) throw notFound('Match not found.');
  if (!liveSlugs.includes(m.game_slug)) throw badRequest('NOT_A_LIVE_GAME', 'This game is not played live.');
  const players = await tx.q(
    `SELECT mp.*, u.username, u.avatar_color, u.is_bot FROM match_players mp JOIN users u ON u.id = mp.user_id WHERE mp.match_id = ? ORDER BY slot FOR UPDATE`,
    [m.id],
  );
  return { m, players };
}

function requireMember(players, userId) {
  const me = players.find((p) => p.user_id === userId);
  if (!me) throw forbidden('You are not a player in this match.');
  return me;
}

const afterCommitEmit = (tx, matchId) => tx.afterCommit(() => emitState(matchId));

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

/**
 * A player takes the pitch. The first one in moves the match to IN_PROGRESS and
 * starts the (short) window in which the other must also show up; once both are
 * there, round 1 is created. Safe to call again (reload / reconnect).
 */
export async function joinLive(userId, matchIdOrCode) {
  const matchId = await withTransaction(async (tx) => {
    const { m, players } = await lockMatch(tx, matchIdOrCode);
    const me = requireMember(players, userId);
    assertNotFinished(m);
    if (!['READY', 'IN_PROGRESS'].includes(m.status) || players.length < 2) {
      throw conflict('MATCH_NOT_READY', 'Both players must lock in before the shootout starts.');
    }
    const now = new Date();
    if (!me.started_at) {
      await tx.q('UPDATE match_players SET started_at = ? WHERE id = ?', [now, me.id]);
      me.started_at = now;
      await recordAudit(tx, { actorType: 'PLAYER', actorUserId: userId, action: 'GAMEPLAY_STARTED', entityType: 'MATCH', entityId: m.id, matchId: m.id });
      // Tell an opponent who isn't there yet that the shootout is waiting for them.
      for (const other of players) {
        if (other.user_id !== userId && !other.is_bot && !other.started_at) {
          await notify(tx, other.user_id, { type: 'MATCH_STARTING', title: 'Your opponent is on the pitch', message: `${me.username} is ready for the penalty shootout. Take the pitch before the timer runs out.`, link: `/match/${m.code}/play` });
        }
      }
    }
    if (m.status === 'READY') {
      await tx.q(
        `UPDATE matches SET status = 'IN_PROGRESS', started_at = ?, completion_deadline = ?, player_action_deadline = ? WHERE id = ?`,
        [now, new Date(now.getTime() + LIVE_MAX_MS), new Date(now.getTime() + TIMERS.playerActionSeconds * 1000), m.id],
      );
      await recordAudit(tx, { actorType: 'SYSTEM', action: 'MATCH_STARTED', entityType: 'MATCH', entityId: m.id, matchId: m.id, previousState: 'READY', newState: 'IN_PROGRESS' });
    }
    // House bots are always on the pitch.
    for (const p of players) {
      if (p.is_bot && !p.started_at) {
        await tx.q('UPDATE match_players SET started_at = ? WHERE id = ?', [now, p.id]);
        p.started_at = now;
      }
    }
    if (players.every((p) => p.started_at)) {
      await tx.q('UPDATE matches SET player_action_deadline = NULL WHERE id = ?', [m.id]);
      const [{ n }] = await tx.q('SELECT COUNT(*) AS n FROM shootout_rounds WHERE match_id = ?', [m.id]);
      if (n === 0) await createRound(tx, m, players, 1, now);
    }
    afterCommitEmit(tx, m.id);
    return m.id;
  });
  return getLiveState(userId, matchId);
}

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

async function createRound(tx, m, players, roundNo, now) {
  const kickerSlot = rules.kickerSlotFor(m.seed, roundNo);
  const kicker = players.find((p) => p.slot === kickerSlot);
  const keeper = players.find((p) => p.slot !== kickerSlot);
  const params = rules.roundParams(m.seed, roundNo);
  const delay = roundNo === 1 ? rules.FIRST_KICK_DELAY_MS : rules.NEXT_KICK_DELAY_MS;
  const startsAt = new Date(now.getTime() + delay);
  const deadline = new Date(startsAt.getTime() + rules.DECISION_MS);
  await tx.q(
    `INSERT INTO shootout_rounds (match_id, round_no, kicker_id, keeper_id, period_ms, phase, starts_at, deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, roundNo, kicker.user_id, keeper.user_id, params.periodMs, params.phase, startsAt, deadline],
  );
  // A house bot decides straight away; its choice stays sealed like anyone's.
  if (kicker.is_bot) {
    const k = rules.botKick(m.seed, roundNo, params);
    await tx.q('UPDATE shootout_rounds SET kicker_zone = ?, kicker_stop_ms = ?, kicker_at = ? WHERE match_id = ? AND round_no = ?', [k.zone, k.stopMs, now, m.id, roundNo]);
  }
  if (keeper.is_bot) {
    await tx.q('UPDATE shootout_rounds SET keeper_col = ?, keeper_at = ? WHERE match_id = ? AND round_no = ?', [rules.botDive(m.seed, roundNo), now, m.id, roundNo]);
  }
}

/** The one round of this match that is open, locked. */
async function openRound(tx, matchId) {
  return tx.one('SELECT * FROM shootout_rounds WHERE match_id = ? AND resolved_at IS NULL ORDER BY round_no DESC LIMIT 1 FOR UPDATE', [matchId]);
}

function assertWindowOpen(round, now, { allowLate = false } = {}) {
  if (now.getTime() < new Date(round.starts_at).getTime() - 300) throw conflict('ROUND_NOT_STARTED', 'This kick has not started yet.');
  if (!allowLate && now.getTime() > new Date(round.deadline).getTime() + TIMERS.latencyGraceMs) throw conflict('ROUND_EXPIRED', 'Time ran out for this kick.');
}

export async function submitKick(userId, matchIdOrCode, { zone, stopMs }) {
  const matchId = await withTransaction(async (tx) => {
    const { m, players } = await lockMatch(tx, matchIdOrCode);
    requireMember(players, userId);
    assertNotFinished(m);
    if (m.status !== 'IN_PROGRESS') throw conflict('MATCH_NOT_STARTED', 'The shootout has not started.');
    const round = await openRound(tx, m.id);
    if (!round) throw conflict('NO_ACTIVE_KICK', 'There is no kick to take right now.');
    if (round.kicker_id !== userId) throw forbidden('It is not your turn to shoot.');
    if (round.kicker_zone != null) { afterCommitEmit(tx, m.id); return m.id; } // already locked in: idempotent
    const now = new Date();
    assertWindowOpen(round, now);
    // The stop time is the client's own report, but it has to be believable
    // given when the request actually reached us.
    const serverMs = now.getTime() - new Date(round.starts_at).getTime();
    const stop = Math.round(Math.min(Math.max(stopMs, serverMs - STOP_EARLY_TOLERANCE_MS), serverMs + STOP_LATE_TOLERANCE_MS));
    await tx.q('UPDATE shootout_rounds SET kicker_zone = ?, kicker_stop_ms = ?, kicker_server_ms = ?, kicker_at = ? WHERE id = ?', [zone, Math.max(0, stop), serverMs, now, round.id]);
    await afterChoice(tx, m, players, round.round_no, now);
    return m.id;
  });
  return getLiveState(userId, matchId);
}

export async function submitDive(userId, matchIdOrCode, { col }) {
  const matchId = await withTransaction(async (tx) => {
    const { m, players } = await lockMatch(tx, matchIdOrCode);
    requireMember(players, userId);
    assertNotFinished(m);
    if (m.status !== 'IN_PROGRESS') throw conflict('MATCH_NOT_STARTED', 'The shootout has not started.');
    const round = await openRound(tx, m.id);
    if (!round) throw conflict('NO_ACTIVE_KICK', 'There is no kick to save right now.');
    if (round.keeper_id !== userId) throw forbidden('It is not your turn to keep goal.');
    if (round.keeper_col != null) { afterCommitEmit(tx, m.id); return m.id; }
    const now = new Date();
    assertWindowOpen(round, now);
    await tx.q('UPDATE shootout_rounds SET keeper_col = ?, keeper_at = ? WHERE id = ?', [col, now, round.id]);
    await afterChoice(tx, m, players, round.round_no, now);
    return m.id;
  });
  return getLiveState(userId, matchId);
}

/** After a choice is stored: resolve the round if both sides are in, otherwise just tell the players. */
async function afterChoice(tx, m, players, roundNo, now) {
  const r = await tx.one('SELECT * FROM shootout_rounds WHERE match_id = ? AND round_no = ?', [m.id, roundNo]);
  if (r.kicker_zone != null && r.keeper_col != null) await resolveRound(tx, m, players, roundNo, now);
  afterCommitEmit(tx, m.id);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** How many of this player's most recent decisions were made for them, uninterrupted. */
function autoStreak(rounds, userId) {
  let n = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const r = rounds[i];
    if (!r.resolved_at) continue;
    const mine = r.kicker_id === userId ? r.kicker_auto : r.keeper_auto;
    if (!mine) break;
    n += 1;
  }
  return n;
}

async function resolveRound(tx, m, players, roundNo, now) {
  const r = await tx.one('SELECT * FROM shootout_rounds WHERE match_id = ? AND round_no = ? FOR UPDATE', [m.id, roundNo]);
  if (!r || r.resolved_at) return;
  const keeperAuto = r.keeper_col == null;
  const keeperCol = keeperAuto ? rules.autoKeeperCol(m.seed, roundNo) : r.keeper_col;
  const kickerAuto = r.kicker_zone == null;
  const res = rules.resolveKick({ zone: r.kicker_zone, stopMs: r.kicker_stop_ms, keeperCol }, { periodMs: r.period_ms, phase: Number(r.phase) });
  await tx.q(
    `UPDATE shootout_rounds SET keeper_col = ?, kicker_auto = ?, keeper_auto = ?, outcome = ?, quality = ?, marker = ?, resolved_at = ? WHERE id = ? AND resolved_at IS NULL`,
    [keeperCol, kickerAuto ? 1 : 0, keeperAuto ? 1 : 0, res.outcome, res.quality, res.marker, now, r.id],
  );
  await recordAudit(tx, {
    actorType: 'SYSTEM', action: 'SHOOTOUT_KICK', entityType: 'MATCH', entityId: m.id, matchId: m.id,
    newState: res.outcome,
    metadata: { round: roundNo, kickerId: r.kicker_id, keeperId: r.keeper_id, zone: r.kicker_zone, keeperCol, quality: res.quality, kickerAuto, keeperAuto, stopMs: r.kicker_stop_ms, serverMs: r.kicker_server_ms },
  });

  const rounds = await tx.q('SELECT * FROM shootout_rounds WHERE match_id = ? ORDER BY round_no', [m.id]);
  const firstSlot = rules.firstKickerSlot(m.seed);
  const first = players.find((p) => p.slot === firstSlot);
  const second = players.find((p) => p.slot !== firstSlot);
  const stand = rules.standing(rounds.filter((x) => x.resolved_at).map((x) => ({ kickerId: x.kicker_id, outcome: x.outcome })), first.user_id, second.user_id);

  // Someone who keeps letting kicks be decided for them has left.
  const streaks = players.map((p) => ({ p, n: autoStreak(rounds, p.user_id) }));
  const gone = streaks.filter((s) => s.n >= MAX_AUTO_IN_A_ROW);
  if (gone.length === players.length) {
    await cancelMatchTx(tx, m, 'Neither player took part in the shootout', { endReason: 'GAME_TIMEOUT' });
    return;
  }
  if (gone.length === 1) {
    await finalizeMatch(tx, m.id, { forfeitUserId: gone[0].p.user_id, reason: `${gone[0].p.username} stopped playing and forfeited`, endReason: 'ACTION_TIMEOUT' });
    return;
  }
  if (stand.done) {
    await finishShootout(tx, m, players, rounds, stand);
    return;
  }
  await createRound(tx, m, players, roundNo + 1, now);
}

/** Write each player's score as a normal game result and let the match settle. */
async function finishShootout(tx, m, players, rounds, stand) {
  const resolved = rounds.filter((r) => r.resolved_at);
  for (const p of players) {
    const kicks = resolved.filter((r) => r.kicker_id === p.user_id);
    const goals = kicks.filter((r) => r.outcome === 'GOAL').length;
    const entries = kicks.map((r, i) => ({
      round: i + 1,
      status: r.outcome === 'GOAL' ? 'GOAL' : r.outcome === 'SAVED' ? 'SAVED' : 'WIDE',
      zone: r.kicker_zone, quality: r.quality, keeperCol: r.keeper_col,
    }));
    const summary = {
      goals, shots: kicks.length,
      saved: kicks.filter((r) => r.outcome === 'SAVED').length,
      wide: kicks.filter((r) => r.outcome === 'MISSED').length,
      saves: resolved.filter((r) => r.keeper_id === p.user_id && r.outcome === 'SAVED').length,
    };
    await tx.q(
      `INSERT INTO game_results (match_id, user_id, score, tiebreak, is_valid, summary, rounds, client_elapsed_ms, server_elapsed_ms)
       VALUES (?, ?, ?, 0, 1, ?, ?, NULL, NULL)`,
      [m.id, p.user_id, goals, JSON.stringify(summary), JSON.stringify(entries)],
    );
  }
  await tx.q('UPDATE match_players SET submitted_at = NOW() WHERE match_id = ?', [m.id]);
  const [a, b] = Object.values(stand.goals);
  await finalizeMatch(tx, m.id, {
    reason: stand.winnerId ? `Won the shootout ${Math.max(a, b)}-${Math.min(a, b)}${stand.suddenDeath ? ' in sudden death' : ''}` : 'Level after sudden death, stakes refunded',
  });
}

// ---------------------------------------------------------------------------
// Background enforcement
// ---------------------------------------------------------------------------

/**
 * Called from the server's sweeper. Idempotent; each match is re-read under a lock.
 *  1. A kick whose deadline has passed is decided: a missing keeper dive is
 *     random, a kicker who never shot has missed.
 *  2. A player who never took the pitch loses by forfeit; if neither did,
 *     the match is cancelled and refunded. A shootout that somehow runs past
 *     its overall limit is cancelled and refunded as well.
 */
export async function sweepLiveShootouts(now = new Date()) {
  if (!liveSlugs.length) return 0;
  let handled = 0;

  const due = await query(
    `SELECT r.match_id, r.round_no FROM shootout_rounds r JOIN matches m ON m.id = r.match_id
     WHERE r.resolved_at IS NULL AND m.status = 'IN_PROGRESS' AND r.deadline <= ? ORDER BY r.deadline LIMIT 100`,
    [new Date(now.getTime() - TIMERS.latencyGraceMs)],
  );
  for (const d of due) {
    try {
      const did = await withTransaction(async (tx) => {
        const { m, players } = await lockMatch(tx, d.match_id);
        if (m.status !== 'IN_PROGRESS' || m.settled_at) return false;
        const round = await tx.one('SELECT * FROM shootout_rounds WHERE match_id = ? AND round_no = ? FOR UPDATE', [m.id, d.round_no]);
        if (!round || round.resolved_at || new Date(round.deadline).getTime() + TIMERS.latencyGraceMs > now.getTime()) return false;
        await resolveRound(tx, m, players, round.round_no, now);
        afterCommitEmit(tx, m.id);
        return true;
      });
      if (did) handled++;
    } catch (err) {
      console.error('Live shootout sweep failed for match', d.match_id, err);
    }
  }

  const stuck = await query(
    `SELECT m.id FROM matches m JOIN games g ON g.id = m.game_id
     WHERE g.slug IN (?) AND m.status IN ('READY','IN_PROGRESS') AND (m.completion_deadline <= ? OR m.player_action_deadline <= ?) LIMIT 100`,
    [liveSlugs, now, now],
  );
  for (const s of stuck) {
    try {
      const did = await withTransaction(async (tx) => {
        const { m, players } = await lockMatch(tx, s.id);
        if (!['READY', 'IN_PROGRESS'].includes(m.status) || m.settled_at) return false;
        const absent = players.filter((p) => !p.started_at);
        const actionLate = m.player_action_deadline && new Date(m.player_action_deadline) <= now;
        const overall = m.completion_deadline && new Date(m.completion_deadline) <= now;
        if (absent.length && (actionLate || overall)) {
          if (absent.length === players.length) return cancelMatchTx(tx, m, 'Neither player took the pitch before the timer ran out', { endReason: 'GAME_TIMEOUT' });
          const gone = absent[0];
          return finalizeMatch(tx, m.id, { forfeitUserId: gone.user_id, reason: `${gone.username} did not take the pitch in time`, endReason: 'ACTION_TIMEOUT' });
        }
        if (!absent.length && overall) return cancelMatchTx(tx, m, 'The shootout ran out of time', { endReason: 'GAME_TIMEOUT' });
        return false;
      });
      if (did) handled++;
    } catch (err) {
      console.error('Live shootout timeout failed for match', s.id, err);
    }
  }
  return handled;
}
