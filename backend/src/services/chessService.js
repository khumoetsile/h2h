// Correspondence chess. All state changes hold the invitation row lock; accepted
// games use the same atomic demo ledger and unique settlement as every match.
import { Chess } from 'chess.js';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { matchCode, randomSeed } from '../utils/ids.js';
import { computePrize, formatMoney, toCents } from '../utils/money.js';
import { emitToUser } from '../realtime.js';
import { chessFromHistory, applyChessMove, chessOutcome, validateChessTurn } from '../games/chess.js';
import { getSettings } from './settingsService.js';
import { lockStake } from './walletService.js';
import { finalizeMatch } from './matchService.js';
import { notify } from './notificationService.js';
import { recordAudit } from './auditService.js';

const PENDING_LIMIT = 10;
const ACTIVE_LIMIT = 10;
const readMoves = (v) => typeof v === 'string' ? JSON.parse(v) : v || [];
const dateAfter = (now, seconds) => new Date(now.getTime() + seconds * 1000);

export async function chessConfig() {
  const settings = await getSettings();
  const game = await queryOne("SELECT is_enabled FROM games WHERE slug = 'chess' AND kind = 'CHESS'");
  return {
    turnSeconds: config.chess.turnSeconds, inviteSeconds: config.chess.inviteSeconds,
    isEnabled: !!game?.is_enabled, stakeAmounts: settings.stake_amounts, platformFeePercent: settings.platform_fee_percent,
    stakeBreakdown: settings.stake_amounts.map(stake => ({ stake, ...computePrize(stake, settings.platform_fee_percent) })),
    serverNow: new Date(), isDemo: true,
  };
}

async function enabledChess(tx) {
  const game = await tx.one("SELECT * FROM games WHERE slug = 'chess' AND kind = 'CHESS'");
  if (!game?.is_enabled) throw conflict('GAME_DISABLED', 'Chess is currently unavailable. Existing games can still be completed.');
  return game;
}

async function activeLimit(tx, userId) {
  const [{ n }] = await tx.q("SELECT COUNT(*) AS n FROM chess_games WHERE status = 'ACTIVE' AND (created_by = ? OR opponent_id = ?)", [userId, userId]);
  if (n >= ACTIVE_LIMIT) throw conflict('TOO_MANY_CHESS_GAMES', `Finish one of your ${ACTIVE_LIMIT} active chess games first.`);
}

function pushUpdate(tx, game) {
  tx.afterCommit(() => {
    for (const id of [game.created_by, game.opponent_id].filter(Boolean)) emitToUser(id, 'chess:update', { code: game.code });
  });
}

async function lockedGame(tx, code) {
  const game = await tx.one('SELECT * FROM chess_games WHERE code = ? FOR UPDATE', [code]);
  if (!game) throw notFound('Chess invitation not found.');
  return game;
}

function participant(game, userId) {
  if (game.created_by !== userId && !(game.match_id && game.opponent_id === userId)) throw forbidden('Only the two players can change this chess game.');
}

async function settleChess(tx, game, { winnerId = null, draw = false, reason, endReason }) {
  if (game.status !== 'ACTIVE') return false;
  const did = await finalizeMatch(tx, game.match_id, { winnerUserId: winnerId, draw, reason, endReason });
  if (!did) {
    const match = await tx.one('SELECT status FROM matches WHERE id = ?', [game.match_id]);
    if (match && ['CANCELLED', 'VOID'].includes(match.status)) {
      await tx.q("UPDATE chess_games SET status = 'CANCELLED', completed_at = NOW(3), turn_deadline = NULL, turn_user_id = NULL, draw_offered_by = NULL WHERE id = ?", [game.id]);
    }
    return false;
  }
  await tx.q("UPDATE chess_games SET status = 'COMPLETED', completed_at = NOW(3), turn_deadline = NULL, turn_user_id = NULL, draw_offered_by = NULL, version = version + 1 WHERE id = ?", [game.id]);
  await recordAudit(tx, { actorType: 'SYSTEM', action: 'CHESS_COMPLETED', entityType: 'MATCH', entityId: game.match_id, matchId: game.match_id, newState: 'COMPLETED', reason, metadata: { winnerId, draw, endReason, code: game.code } });
  pushUpdate(tx, game);
  return true;
}

async function enforceDeadline(tx, game, now = new Date()) {
  if (game.status === 'PENDING' && new Date(game.invite_expires_at) <= now) {
    await tx.q("UPDATE chess_games SET status = 'EXPIRED', completed_at = ?, version = version + 1 WHERE id = ? AND status = 'PENDING'", [now, game.id]);
    pushUpdate(tx, game);
    return true;
  }
  if (game.status === 'ACTIVE' && new Date(game.turn_deadline) <= now) {
    const loserId = game.turn_user_id;
    const winnerId = loserId === game.created_by ? game.opponent_id : game.created_by;
    return settleChess(tx, game, { winnerId, reason: 'Move deadline missed; opponent wins', endReason: 'CHESS_TIMEOUT' });
  }
  return false;
}

export async function createChess(userId, { stake, opponent }) {
  const settings = await getSettings();
  if (!settings.stake_amounts.some(v => toCents(v) === toCents(stake))) throw badRequest('INVALID_STAKE', 'Choose one of the available demo entries.');
  const amount = Number(stake);
  if (amount !== toCents(amount) / 100) throw badRequest('INVALID_STAKE', 'Demo entries can have at most two decimal places.');
  const amounts = computePrize(amount, settings.platform_fee_percent);
  const code = matchCode();
  await withTransaction(async tx => {
    await enabledChess(tx);
    // Serialise the player's simultaneous invite requests and check balances
    // without reserving any funds. Wallets share this ordering on acceptance.
    const wallet = await tx.one('SELECT * FROM wallets WHERE user_id = ? FOR UPDATE', [userId]);
    if (!wallet || toCents(wallet.available_balance) < toCents(amount)) throw badRequest('INSUFFICIENT_BALANCE', `You need ${formatMoney(amount)} DEMO available to send this invitation.`);
    await activeLimit(tx, userId);
    const [{ n }] = await tx.q("SELECT COUNT(*) AS n FROM chess_games WHERE created_by = ? AND status = 'PENDING' AND invite_expires_at > NOW(3)", [userId]);
    if (n >= PENDING_LIMIT) throw conflict('TOO_MANY_CHESS_INVITES', 'You already have 10 pending chess invitations. Cancel one first.');
    let target = null;
    if (opponent) {
      target = typeof opponent === 'number'
        ? await tx.one('SELECT id, username, role, status, is_bot, avatar_color FROM users WHERE id = ?', [opponent])
        : await tx.one('SELECT id, username, role, status, is_bot, avatar_color FROM users WHERE username = ?', [String(opponent).replace(/^@/, '').trim()]);
      if (!target) throw notFound('No player found with that username.');
      if (target.id === userId) throw badRequest('CANNOT_CHALLENGE_SELF', 'Choose another player to challenge.');
      if (target.role !== 'PLAYER' || target.status !== 'ACTIVE' || target.is_bot) throw conflict('OPPONENT_UNAVAILABLE', 'This player is unavailable for chess.');
    }
    const now = new Date();
    const chess = new Chess();
    await tx.q(`INSERT INTO chess_games (code, created_by, opponent_id, stake, pool, fee_percent, fee_amount, prize, turn_seconds, invite_expires_at, fen, pgn, moves)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
    [code, userId, target?.id || null, amount, amounts.pool, settings.platform_fee_percent, amounts.fee, amounts.prize, config.chess.turnSeconds, dateAfter(now, config.chess.inviteSeconds), chess.fen(), JSON.stringify([])]);
    await recordAudit(tx, { actorType: 'PLAYER', actorUserId: userId, action: 'CHESS_INVITED', entityType: 'CHESS', entityId: code, newState: 'PENDING', metadata: { stake: amount, opponentId: target?.id || null, turnSeconds: config.chess.turnSeconds, fundsHeld: false } });
    if (target) {
      const me = await tx.one('SELECT username FROM users WHERE id = ?', [userId]);
      await notify(tx, target.id, { type: 'CHALLENGE_RECEIVED', title: `${me.username} invited you to chess`, message: `${formatMoney(amount)} DEMO per player; ${config.chess.turnSeconds / 3600} hours per move. Review before accepting.`, link: `/chess/${code}` });
    }
    pushUpdate(tx, { created_by: userId, opponent_id: target?.id, code });
  });
  return getChessView(code, userId);
}

export async function acceptChess(userId, code) {
  const expired = await withTransaction(async tx => {
    const game = await lockedGame(tx, code);
    if (game.match_id && game.opponent_id === userId) return false; // Lost response: accepting again is safe.
    if (game.created_by === userId) throw badRequest('CANNOT_JOIN_OWN_MATCH', 'Share this invitation with another player.');
    if (game.opponent_id && game.opponent_id !== userId) throw forbidden('This invitation is for another player.');
    if (await enforceDeadline(tx, game)) return true;
    if (game.status !== 'PENDING') throw conflict('CHESS_INVITE_CLOSED', 'This chess invitation is already closed.');
    const chessGame = await enabledChess(tx);
    // All financial actions and capacity checks happen with both wallets locked
    // in ascending user ID order, preventing races and double spending.
    for (const id of [game.created_by, userId].sort((a, b) => a - b)) await tx.q('SELECT id FROM wallets WHERE user_id = ? FOR UPDATE', [id]);
    for (const id of [game.created_by, userId]) {
      const user = await tx.one('SELECT id, role, status, is_bot FROM users WHERE id = ?', [id]);
      if (!user || user.role !== 'PLAYER' || user.status !== 'ACTIVE' || user.is_bot) throw conflict('OPPONENT_UNAVAILABLE', 'Both players must have active player accounts.');
      await activeLimit(tx, id);
    }
    const now = new Date();
    const deadline = dateAfter(now, game.turn_seconds);
    const inserted = await tx.q(`INSERT INTO matches (code, game_id, category, stake, pool, fee_percent, fee_amount, prize, status, source, created_by, seed, matched_at, ready_at, locked_at, started_at)
      VALUES (?, ?, 'CHESS', ?, ?, ?, ?, ?, 'IN_PROGRESS', 'CHALLENGE', ?, ?, ?, ?, ?, ?)`,
    [game.code, chessGame.id, game.stake, game.pool, game.fee_percent, game.fee_amount, game.prize, game.created_by, randomSeed(), now, now, now, now]);
    const match = { id: inserted.insertId, code: game.code, stake: Number(game.stake), prize: Number(game.prize) };
    await lockStake(tx, game.created_by, match, 'Chess');
    await lockStake(tx, userId, match, 'Chess');
    for (const [index, id] of [game.created_by, userId].entries()) await tx.q('INSERT INTO match_players (match_id, user_id, slot, stake, ready_at, started_at) VALUES (?, ?, ?, ?, ?, ?)', [match.id, id, index + 1, game.stake, now, now]);
    await tx.q("UPDATE chess_games SET opponent_id = ?, match_id = ?, status = 'ACTIVE', accepted_at = ?, turn_deadline = ?, turn_user_id = created_by, version = version + 1 WHERE id = ?", [userId, match.id, now, deadline, game.id]);
    await recordAudit(tx, { actorType: 'PLAYER', actorUserId: userId, action: 'CHESS_ACCEPTED', entityType: 'MATCH', entityId: match.id, matchId: match.id, newState: 'IN_PROGRESS', metadata: { code, white: game.created_by, black: userId, turnDeadline: deadline, stake: Number(game.stake), feePercent: Number(game.fee_percent) } });
    await notify(tx, game.created_by, { type: 'CHESS_TURN', title: 'Chess invitation accepted — your move', message: `You play White. Make your first move within ${game.turn_seconds / 3600} hours. Both demo entries are now held.`, link: `/chess/${code}` });
    pushUpdate(tx, { ...game, opponent_id: userId });
    return false;
  });
  if (expired) throw conflict('CHESS_INVITE_EXPIRED', 'This invitation expired. No funds were held.');
  return getChessView(code, userId);
}

// A late action must COMMIT the authoritative timeout before returning an error.
// Throwing within that transaction would roll the payout back.
async function action(userId, code, fn) {
  const expired = await withTransaction(async tx => {
    const game = await lockedGame(tx, code);
    participant(game, userId);
    if (await enforceDeadline(tx, game)) return true;
    await fn(tx, game);
    return false;
  });
  if (expired) throw conflict('CHESS_TURN_EXPIRED', 'The deadline has passed. Refresh to see the result.');
  return getChessView(code, userId);
}

export function moveChess(userId, code, body) {
  return action(userId, code, async (tx, game) => {
    const history = readMoves(game.moves);
    const replay = history.find(move => move.requestVersion === body.version && move.userId === userId);
    if (replay && replay.from === body.from && replay.to === body.to && (replay.promotion || '') === (body.promotion || '')) return;
    validateChessTurn(game, userId, body.version);
    const chess = chessFromHistory(history);
    if (chess.fen() !== game.fen) throw conflict('CHESS_STATE_MISMATCH', 'The saved board needs attention. Contact support.');
    const move = applyChessMove(chess, body);
    const now = new Date();
    history.push({ ...move, userId, requestVersion: body.version, at: now.toISOString() });
    const nextUserId = chess.turn() === 'w' ? game.created_by : game.opponent_id;
    const deadline = dateAfter(now, game.turn_seconds);
    await tx.q('UPDATE chess_games SET fen = ?, pgn = ?, moves = ?, turn_user_id = ?, turn_deadline = ?, draw_offered_by = NULL, version = version + 1 WHERE id = ?', [chess.fen(), chess.pgn(), JSON.stringify(history), nextUserId, deadline, game.id]);
    await recordAudit(tx, { actorType: 'PLAYER', actorUserId: userId, action: 'CHESS_MOVE', entityType: 'MATCH', entityId: game.match_id, matchId: game.match_id, metadata: { from: move.from, to: move.to, promotion: move.promotion, san: move.san, version: game.version + 1, turnDeadline: deadline } });
    const outcome = chessOutcome(chess);
    if (outcome) {
      await settleChess(tx, game, { ...outcome, winnerId: outcome.winnerColor === 'w' ? game.created_by : outcome.winnerColor === 'b' ? game.opponent_id : null });
    } else {
      await notify(tx, nextUserId, { type: 'CHESS_TURN', title: 'Your move in Chess', message: `Your opponent played ${move.san}. You have ${game.turn_seconds / 3600} hours to move.`, link: `/chess/${code}` });
      pushUpdate(tx, game);
    }
  });
}

export function resignChess(userId, code) {
  return action(userId, code, async (tx, game) => {
    if (game.status === 'COMPLETED') return;
    if (game.status !== 'ACTIVE') throw conflict('CHESS_NOT_ACTIVE', 'Only an active chess game can be resigned.');
    await settleChess(tx, game, { winnerId: userId === game.created_by ? game.opponent_id : game.created_by, reason: 'Opponent resigned', endReason: 'CHESS_RESIGNED' });
  });
}

export function cancelChess(userId, code) {
  return action(userId, code, async (tx, game) => {
    if (game.status === 'CANCELLED') return;
    if (game.status !== 'PENDING') throw conflict('CHESS_ALREADY_ACCEPTED', 'Accepted games hold both entries. Resign to concede, or agree a draw.');
    if (game.created_by !== userId) throw forbidden('Only the sender can cancel this invitation.');
    await tx.q("UPDATE chess_games SET status = 'CANCELLED', completed_at = NOW(3), version = version + 1 WHERE id = ?", [game.id]);
    await recordAudit(tx, { actorType: 'PLAYER', actorUserId: userId, action: 'CHESS_INVITE_CANCELLED', entityType: 'CHESS', entityId: code, newState: 'CANCELLED', metadata: { fundsHeld: false } });
    pushUpdate(tx, game);
  });
}

export async function declineChess(userId, code) {
  const expired = await withTransaction(async tx => {
    const game = await lockedGame(tx, code);
    if (game.opponent_id !== userId) throw forbidden('Only the invited player can decline this invitation.');
    if (game.status === 'CANCELLED' && game.invite_end_reason === 'INVITE_DECLINED') return false;
    if (await enforceDeadline(tx, game)) return true;
    if (game.status !== 'PENDING') throw conflict('CHESS_INVITE_CLOSED', 'This chess invitation is already closed.');
    await tx.q("UPDATE chess_games SET status = 'CANCELLED', invite_end_reason = 'INVITE_DECLINED', completed_at = NOW(3), version = version + 1 WHERE id = ?", [game.id]);
    await recordAudit(tx, { actorType: 'PLAYER', actorUserId: userId, action: 'CHESS_INVITE_DECLINED', entityType: 'CHESS', entityId: code, newState: 'CANCELLED', metadata: { fundsHeld: false } });
    await notify(tx, game.created_by, { type: 'CHALLENGE_DECLINED', title: 'Chess invitation declined', message: 'Your friend declined this invitation. No demo funds were held.', link: `/chess/${code}` });
    pushUpdate(tx, game);
    return false;
  });
  if (expired) throw conflict('CHESS_INVITE_EXPIRED', 'This invitation expired. No funds were held.');
  return getChessView(code, userId);
}

export function drawChess(userId, code, { action: drawAction }) {
  return action(userId, code, async (tx, game) => {
    if (game.status !== 'ACTIVE') throw conflict('CHESS_NOT_ACTIVE', 'This chess game is not active.');
    if (drawAction === 'offer') {
      if (game.draw_offered_by === userId) return;
      if (game.draw_offered_by) throw conflict('DRAW_OFFER_PENDING', 'Respond to your opponent’s existing draw offer.');
      await tx.q('UPDATE chess_games SET draw_offered_by = ?, version = version + 1 WHERE id = ?', [userId, game.id]);
      const otherId = userId === game.created_by ? game.opponent_id : game.created_by;
      await notify(tx, otherId, { type: 'CHESS_DRAW_OFFER', title: 'Your opponent offered a draw', message: 'An agreed draw refunds both demo entries without a fee. The move deadline keeps running.', link: `/chess/${code}` });
    } else {
      if (!game.draw_offered_by || game.draw_offered_by === userId) throw conflict('NO_DRAW_OFFER', 'There is no opponent draw offer to respond to.');
      if (drawAction === 'accept') {
        await settleChess(tx, game, { draw: true, reason: 'Draw agreed; both entries refunded', endReason: 'CHESS_AGREED_DRAW' });
        return;
      }
      await tx.q('UPDATE chess_games SET draw_offered_by = NULL, version = version + 1 WHERE id = ?', [game.id]);
    }
    await recordAudit(tx, { actorType: 'PLAYER', actorUserId: userId, action: 'CHESS_DRAW_RESPONSE', entityType: 'MATCH', entityId: game.match_id, matchId: game.match_id, metadata: { action: drawAction, deadlineUnchanged: true } });
    pushUpdate(tx, game);
  });
}

export async function sweepChess(now = new Date()) {
  const rows = await query("SELECT code FROM chess_games WHERE (status = 'PENDING' AND invite_expires_at <= ?) OR (status = 'ACTIVE' AND turn_deadline <= ?) ORDER BY id LIMIT 200", [now, now]);
  let handled = 0;
  for (const { code } of rows) {
    try {
      if (await withTransaction(async tx => enforceDeadline(tx, await lockedGame(tx, code), now))) handled++;
    } catch (err) {
      console.error('Chess sweeper failed for game', code, err);
    }
  }
  return handled;
}

export async function getChessView(code, viewerId = null, { admin = false, enforce = true } = {}) {
  if (enforce) await withTransaction(async tx => enforceDeadline(tx, await lockedGame(tx, code)));
  const game = await queryOne(`SELECT cg.*, m.winner_id, m.is_draw, m.result_reason, m.end_reason, mp.outcome, mp.payout,
      w.username AS white_username, w.avatar_color AS white_color, b.username AS black_username, b.avatar_color AS black_color
    FROM chess_games cg JOIN users w ON w.id = cg.created_by LEFT JOIN users b ON b.id = cg.opponent_id
    LEFT JOIN matches m ON m.id = cg.match_id LEFT JOIN match_players mp ON mp.match_id = cg.match_id AND mp.user_id = ? WHERE cg.code = ?`, [viewerId, code]);
  if (!game) throw notFound('Chess invitation not found.');
  const isPlayer = viewerId === game.created_by || !!(game.match_id && viewerId === game.opponent_id);
  const visibleBoard = isPlayer || admin || game.status === 'PENDING';
  const viewerColor = viewerId === game.created_by ? 'w' : game.match_id && viewerId === game.opponent_id ? 'b' : null;
  const history = visibleBoard ? readMoves(game.moves) : [];
  const chess = visibleBoard ? chessFromHistory(history) : null;
  return {
    code: game.code, status: game.status, matchId: game.match_id, createdBy: game.created_by, opponentId: game.opponent_id,
    white: { id: game.created_by, username: game.white_username, avatarColor: game.white_color },
    black: game.opponent_id ? { id: game.opponent_id, username: game.black_username, avatarColor: game.black_color } : null,
    stake: Number(game.stake), pool: Number(game.pool), feePercent: Number(game.fee_percent), fee: game.is_draw || game.status === 'CANCELLED' || game.status === 'EXPIRED' ? 0 : Number(game.fee_amount), prize: Number(game.prize), isDemo: true,
    turnSeconds: game.turn_seconds, inviteExpiresAt: game.invite_expires_at, turnDeadline: game.turn_deadline, serverNow: new Date(), version: game.version,
    createdAt: game.created_at, completedAt: game.completed_at, viewerColor, isYourTurn: game.status === 'ACTIVE' && game.turn_user_id === viewerId,
    canAccept: game.status === 'PENDING' && !!viewerId && viewerId !== game.created_by && (!game.opponent_id || game.opponent_id === viewerId),
    canCancel: game.status === 'PENDING' && viewerId === game.created_by, drawOfferedBy: isPlayer || admin ? game.draw_offered_by : null,
    canDecline: game.status === 'PENDING' && viewerId === game.opponent_id,
    winnerId: game.winner_id || null, isDraw: !!game.is_draw, resultReason: game.result_reason || (game.invite_end_reason === 'INVITE_DECLINED' ? 'Invitation declined' : null), endReason: game.end_reason || game.invite_end_reason || null,
    myOutcome: game.outcome || null, myPayout: game.payout != null ? Number(game.payout) : null,
    ...(visibleBoard ? {
      fen: game.fen, pgn: game.pgn, moves: history.map(({ requestVersion, userId, ...move }) => move), lastMove: history.length ? history.at(-1) : null,
      turn: chess.turn(), inCheck: chess.inCheck(),
      legalMoves: game.status === 'ACTIVE' && game.turn_user_id === viewerId ? chess.moves({ verbose: true }).map(({ from, to, promotion, san }) => ({ from, to, ...(promotion ? { promotion } : {}), san })) : [],
    } : {}),
  };
}

export async function listChess(userId) {
  // A short, bounded user list; reads also enforce overdue outcomes so nobody
  // sees a stale Your turn if the sweeper has not ticked yet.
  const rows = await query(`SELECT code FROM chess_games WHERE created_by = ? OR opponent_id = ?
    ORDER BY CASE status WHEN 'ACTIVE' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END,
      CASE WHEN status IN ('ACTIVE','PENDING') THEN COALESCE(turn_deadline, invite_expires_at) END,
      updated_at DESC, id DESC LIMIT 100`, [userId, userId]);
  const items = [];
  // Avoid exhausting the connection pool while a deadline settlement's
  // after-commit notification loads the normal match view on another connection.
  for (const { code } of rows) items.push(await getChessView(code, userId));
  return { items, serverNow: new Date() };
}
