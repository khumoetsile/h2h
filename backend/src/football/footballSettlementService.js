// Settles football head-to-heads once their underlying fixture is final (or
// can no longer be fairly resolved). This is the ONLY place a football
// challenge's outcome is decided — always from our own database's fixture
// row (populated by the sync service from the provider), NEVER from
// anything the browser sends. Reuses the exact same wallet primitives
// (payWinner/refundStake/forfeitStake) as skill games, so every rule proven
// for skill games (idempotent settlement, no negative balances, no double
// payout) applies here unchanged.
import { query, withTransaction } from '../db.js';
import { formatMoney } from '../utils/money.js';
import { matchCode } from '../utils/ids.js';
import { notify } from '../services/notificationService.js';
import { emitToUser } from '../realtime.js';
import { forfeitStake, payWinner, refundStake } from '../services/walletService.js';
import { resolveOutcome } from './settlementRules.js';
import { logSystemError } from '../services/systemErrorService.js';
import { cancelMatchTx, getMatchView } from '../services/matchService.js';
import { recordAudit } from '../services/auditService.js';

function emitMatch(tx, matchId, userIds) {
  tx.afterCommit(async () => {
    for (const uid of userIds) {
      const view = await getMatchView(matchId, uid).catch(() => null);
      if (view) emitToUser(uid, 'match:update', view);
    }
  });
}

/**
 * Attempt to settle every open football match tied to `fixtureId`. Safe to
 * call repeatedly (e.g. on every sync tick) — matches already settled are
 * skipped by the `settled_at IS NULL` guard, same as skill games.
 */
export async function settleMatchesForFixture(fixtureId) {
  let settledCount = 0;
  const rows = await query(
    `SELECT m.id FROM matches m JOIN football_challenges fc ON fc.match_id = m.id
     WHERE fc.fixture_id = ? AND m.status IN ('MATCHED','READY','IN_PROGRESS') AND m.settled_at IS NULL`,
    [fixtureId],
  );
  for (const { id } of rows) {
    try {
      const did = await settleFootballMatch(id);
      if (did) settledCount++;
    } catch (err) {
      await logSystemError('football-settlement', err);
    }
  }
  return settledCount;
}

/** Void every open football match tied to a fixture that can never produce a fair result (postponed/cancelled/abandoned). */
export async function voidMatchesForFixture(fixtureId, reason, { toStatus = 'CANCELLED', endReason = 'FIXTURE' } = {}) {
  const rows = await query(
    `SELECT m.id FROM matches m JOIN football_challenges fc ON fc.match_id = m.id
     WHERE fc.fixture_id = ? AND m.status IN ('WAITING','MATCHED','READY','IN_PROGRESS') AND m.settled_at IS NULL`,
    [fixtureId],
  );
  let count = 0;
  for (const { id } of rows) {
    try {
      await withTransaction(async (tx) => {
        const m = await tx.one('SELECT * FROM matches WHERE id = ? FOR UPDATE', [id]);
        if (!m || m.settled_at) return;
        const ok = await cancelMatchTx(tx, m, reason, { toStatus, endReason });
        if (ok) count++;
      });
    } catch (err) {
      await logSystemError('football-void', err);
    }
  }
  return count;
}

export async function settleFootballMatch(matchId) {
  return withTransaction(async (tx) => {
    const m = await tx.one(
      `SELECT m.*, g.name AS game_name FROM matches m JOIN games g ON g.id = m.game_id WHERE m.id = ? FOR UPDATE`,
      [matchId],
    );
    if (!m || m.settled_at || !['MATCHED', 'READY', 'IN_PROGRESS'].includes(m.status)) return false;
    const fc = await tx.one(
      `SELECT fc.*, ct.slug AS type_slug, ct.name AS type_name, ct.requires_stats, ct.pick_type
       FROM football_challenges fc JOIN football_challenge_types ct ON ct.id = fc.challenge_type_id
       WHERE fc.match_id = ?`,
      [matchId],
    );
    if (!fc) return false;
    const fixture = await tx.one(
      `SELECT fx.*, ht.name AS home_name, at.name AS away_name FROM football_fixtures fx
       JOIN football_teams ht ON ht.id = fx.home_team_id JOIN football_teams at ON at.id = fx.away_team_id
       WHERE fx.id = ?`,
      [fc.fixture_id],
    );
    if (!fixture) return false;

    // Only FINISHED fixtures can produce a normal result. Anything else
    // reaching here (POSTPONED/CANCELLED/ABANDONED) is handled by
    // voidMatchesForFixture instead — this function leaves it untouched.
    if (fixture.status !== 'FINISHED') return false;
    if (fc.requires_stats && !fixture.stats_available) return false; // wait for stats, or the sync loop will eventually give up and void it

    const players = await tx.q(
      `SELECT mp.*, u.username, u.is_bot FROM match_players mp JOIN users u ON u.id = mp.user_id WHERE match_id = ? ORDER BY slot`,
      [matchId],
    );
    const creator = players.find((p) => p.slot === 1);
    const opponent = players.find((p) => p.slot === 2);
    const decision = resolveOutcome(fc.type_slug, fixture);
    const matchLabel = `${fixture.home_name} vs ${fixture.away_name}`;
    const link = `/matches/${m.code}`;

    if (decision.outcome === 'VOID') {
      const upd = await tx.q(
        `UPDATE matches SET status = 'VOID', cancelled_at = NOW(), cancel_reason = ?, settled_at = NOW() WHERE id = ? AND settled_at IS NULL`,
        [decision.reason, matchId],
      );
      if (upd.affectedRows !== 1) return false;
      for (const p of players) {
        await refundStake(tx, p.user_id, m, decision.reason);
        await tx.q(`UPDATE match_players SET outcome = 'REFUNDED', payout = stake WHERE id = ?`, [p.id]);
        if (!p.is_bot) await notify(tx, p.user_id, { type: 'MATCH_VOID', title: 'Challenge voided', message: `${matchLabel}: this challenge could not be fairly completed (${decision.reason}). ${formatMoney(m.stake)} DEMO was returned to your balance. No fee was charged.`, link });
      }
      const voidRef = matchCode().replace('M-', 'S-');
      await tx.q(`INSERT INTO settlements (match_id, reference, outcome, pool, fee_percent, fee_amount, prize, reason) VALUES (?, ?, 'VOID', ?, ?, 0, 0, ?)`, [matchId, voidRef, m.pool, m.fee_percent, decision.reason]);
      await recordAudit(tx, {
        actorType: 'SYSTEM', action: 'MATCH_VOID', entityType: 'MATCH', entityId: matchId, matchId,
        previousState: m.status, newState: 'VOID', reason: decision.reason,
        metadata: { fixtureId: fc.fixture_id, challengeTypeSlug: fc.type_slug },
      });
      await recordAudit(tx, {
        actorType: 'SYSTEM', action: 'SETTLEMENT_CREATED', entityType: 'SETTLEMENT', entityId: voidRef, matchId,
        reason: decision.reason, metadata: { outcome: 'VOID', pool: Number(m.pool), feeAmount: 0, prize: 0 },
      });
      emitMatch(tx, matchId, players.map((p) => p.user_id));
      return true;
    }

    if (decision.outcome === 'DRAW') {
      const upd = await tx.q(
        `UPDATE matches SET status = 'COMPLETED', completed_at = NOW(), settled_at = NOW(), is_draw = 1, result_reason = ? WHERE id = ? AND settled_at IS NULL`,
        [decision.reason, matchId],
      );
      if (upd.affectedRows !== 1) return false;
      for (const p of players) {
        await refundStake(tx, p.user_id, m, decision.reason);
        await tx.q(`UPDATE match_players SET outcome = 'DRAW', payout = stake WHERE id = ?`, [p.id]);
        if (!p.is_bot) await notify(tx, p.user_id, { type: 'MATCH_DRAW', title: 'Match drawn', message: `${matchLabel}: ${decision.reason} Your ${formatMoney(m.stake)} entry was refunded. No platform fee was charged.`, link });
      }
      const drawRef = matchCode().replace('M-', 'S-');
      await tx.q(`INSERT INTO settlements (match_id, reference, outcome, pool, fee_percent, fee_amount, prize, reason) VALUES (?, ?, 'DRAW', ?, ?, 0, 0, ?)`, [matchId, drawRef, m.pool, m.fee_percent, decision.reason]);
      await recordAudit(tx, {
        actorType: 'SYSTEM', action: 'MATCH_COMPLETED', entityType: 'MATCH', entityId: matchId, matchId,
        previousState: m.status, newState: 'COMPLETED', reason: decision.reason,
        metadata: { outcome: 'DRAW', fixtureId: fc.fixture_id, challengeTypeSlug: fc.type_slug },
      });
      await recordAudit(tx, {
        actorType: 'SYSTEM', action: 'SETTLEMENT_CREATED', entityType: 'SETTLEMENT', entityId: drawRef, matchId,
        reason: decision.reason, metadata: { outcome: 'DRAW', pool: Number(m.pool), feeAmount: 0, prize: 0 },
      });
      emitMatch(tx, matchId, players.map((p) => p.user_id));
      return true;
    }

    // WIN: whichever player made the winning pick takes the prize.
    const winnerSide = decision.winnerPick === fc.creator_pick ? creator : opponent;
    const loserSide = winnerSide === creator ? opponent : creator;
    const upd = await tx.q(
      `UPDATE matches SET status = 'COMPLETED', completed_at = NOW(), settled_at = NOW(), winner_id = ?, is_draw = 0, result_reason = ? WHERE id = ? AND settled_at IS NULL`,
      [winnerSide.user_id, `Correct pick`, matchId],
    );
    if (upd.affectedRows !== 1) return false;
    await payWinner(tx, winnerSide.user_id, m, m.game_name);
    await forfeitStake(tx, loserSide.user_id, m);
    await tx.q(`UPDATE match_players SET outcome = 'WIN', payout = ? WHERE id = ?`, [m.prize, winnerSide.id]);
    await tx.q(`UPDATE match_players SET outcome = 'LOSS', payout = 0 WHERE id = ?`, [loserSide.id]);
    if (!winnerSide.is_bot) await notify(tx, winnerSide.user_id, { type: 'MATCH_WON', title: 'Victory!', message: `${matchLabel}: you won ${formatMoney(m.prize)} DEMO. Your pick was correct.`, link });
    if (!loserSide.is_bot) await notify(tx, loserSide.user_id, { type: 'MATCH_LOST', title: 'Match lost', message: `${matchLabel}: ${winnerSide.username} won this challenge. Better luck next time.`, link });
    const winRef = matchCode().replace('M-', 'S-');
    await tx.q(`INSERT INTO settlements (match_id, reference, outcome, winner_id, pool, fee_percent, fee_amount, prize, reason) VALUES (?, ?, 'WIN', ?, ?, ?, ?, ?, 'Correct pick')`, [matchId, winRef, winnerSide.user_id, m.pool, m.fee_percent, m.fee_amount, m.prize]);
    await recordAudit(tx, {
      actorType: 'SYSTEM', action: 'MATCH_COMPLETED', entityType: 'MATCH', entityId: matchId, matchId,
      previousState: m.status, newState: 'COMPLETED', reason: 'Correct pick',
      metadata: { outcome: 'WIN', winnerId: winnerSide.user_id, fixtureId: fc.fixture_id, challengeTypeSlug: fc.type_slug },
    });
    await recordAudit(tx, {
      actorType: 'SYSTEM', action: 'SETTLEMENT_CREATED', entityType: 'SETTLEMENT', entityId: winRef, matchId,
      reason: 'Correct pick',
      metadata: { outcome: 'WIN', winnerId: winnerSide.user_id, pool: Number(m.pool), feePercent: Number(m.fee_percent), feeAmount: Number(m.fee_amount), prize: Number(m.prize) },
    });
    emitMatch(tx, matchId, players.map((p) => p.user_id));
    return true;
  });
}
