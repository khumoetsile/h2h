// All balances here are DEMO funds. Every mutation happens inside a DB
// transaction with the wallet row locked (SELECT ... FOR UPDATE), which
// prevents double-spending under concurrency. CHECK constraints on the table
// are a last line of defence against negative balances.
import { query, queryOne, withTransaction } from '../db.js';
import { emitToUser } from '../realtime.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { txReference } from '../utils/ids.js';
import { formatMoney, fromCents, toCents } from '../utils/money.js';
import { getSettings } from './settingsService.js';
import { notify } from './notificationService.js';

export function mapWallet(w) {
  const available = Number(w.available_balance);
  const locked = Number(w.locked_balance);
  return {
    id: w.id,
    currency: w.currency,
    available,
    locked,
    total: fromCents(toCents(available) + toCents(locked)),
    isDemo: true,
    updatedAt: w.updated_at,
  };
}

export function mapTransaction(t) {
  return {
    id: t.id,
    reference: t.reference,
    type: t.type,
    direction: t.direction,
    amount: Number(t.amount),
    signedAmount: t.direction === 'DEBIT' ? -Number(t.amount) : Number(t.amount),
    balanceAfter: Number(t.available_after),
    lockedAfter: Number(t.locked_after),
    description: t.description,
    status: t.status,
    matchId: t.match_id,
    matchCode: t.match_code || null,
    isDemo: !!t.is_demo,
    createdAt: t.created_at,
    ...(t.username ? { username: t.username } : {}),
  };
}

export async function getWallet(userId) {
  const w = await queryOne('SELECT * FROM wallets WHERE user_id = ?', [userId]);
  if (!w) throw notFound('Wallet not found.');
  return mapWallet(w);
}

export async function createWallet(tx, userId) {
  const res = await tx.q('INSERT INTO wallets (user_id) VALUES (?)', [userId]);
  return res.insertId;
}

async function lockWallet(tx, userId) {
  const w = await tx.one('SELECT * FROM wallets WHERE user_id = ? FOR UPDATE', [userId]);
  if (!w) throw notFound('Wallet not found.');
  return w;
}

/**
 * Core ledger primitive. Applies deltas (in cents) to available/locked, writes
 * a transaction row (unless `type` is null) and schedules a realtime update.
 * `idempotencyKey` guarantees a given financial event is recorded once.
 */
async function applyMovement(tx, userId, { availableDelta = 0, lockedDelta = 0, type, direction, amount, description, status = 'COMPLETED', matchId = null, idempotencyKey = null }) {
  const w = await lockWallet(tx, userId);
  if (idempotencyKey) {
    const existing = await tx.one('SELECT id FROM transactions WHERE idempotency_key = ?', [idempotencyKey]);
    if (existing) throw conflict('DUPLICATE_TRANSACTION', 'This transaction has already been processed.');
  }
  const newAvail = toCents(w.available_balance) + availableDelta;
  const newLocked = toCents(w.locked_balance) + lockedDelta;
  if (newAvail < 0) {
    throw badRequest('INSUFFICIENT_BALANCE', `Insufficient demo balance. Available: ${formatMoney(w.available_balance)} DEMO.`);
  }
  if (newLocked < 0) throw conflict('LOCKED_BALANCE_MISMATCH', 'Locked balance is lower than expected.');
  await tx.q('UPDATE wallets SET available_balance = ?, locked_balance = ? WHERE id = ?', [fromCents(newAvail), fromCents(newLocked), w.id]);
  let txId = null;
  if (type) {
    const res = await tx.q(
      `INSERT INTO transactions (reference, user_id, wallet_id, type, direction, amount, available_after, locked_after, description, status, match_id, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [txReference(), userId, w.id, type, direction, amount, fromCents(newAvail), fromCents(newLocked), description, status, matchId, idempotencyKey],
    );
    txId = res.insertId;
  }
  const snapshot = mapWallet({ ...w, available_balance: fromCents(newAvail), locked_balance: fromCents(newLocked) });
  tx.afterCommit(() => emitToUser(userId, 'wallet:update', snapshot));
  return { wallet: snapshot, transactionId: txId };
}

function validateAmount(raw, { max } = {}) {
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('INVALID_AMOUNT', 'Enter an amount greater than zero.');
  if (toCents(amount) !== Math.round(amount * 100 * 1e6) / 1e6) throw badRequest('INVALID_AMOUNT', 'Amounts can have at most 2 decimal places.');
  if (max && amount > max) throw badRequest('INVALID_AMOUNT', `The maximum is ${formatMoney(max)} DEMO per transaction.`);
  return fromCents(toCents(amount));
}

export async function demoDeposit(userId, rawAmount, { source = 'Demo deposit', silent = false } = {}) {
  const settings = await getSettings();
  const amount = validateAmount(rawAmount, { max: settings.max_deposit });
  return withTransaction(async (tx) => {
    const result = await applyMovement(tx, userId, {
      availableDelta: toCents(amount), type: 'DEPOSIT', direction: 'CREDIT', amount,
      description: `${source} — DEMO FUNDS (no real money)`, status: 'DEMO_COMPLETED',
    });
    if (!silent) {
      await notify(tx, userId, { type: 'DEPOSIT', title: 'Demo deposit successful', message: `${formatMoney(amount)} DEMO has been added to your demo wallet.`, link: '/wallet' });
    }
    return { ...result, amount };
  });
}

export async function demoWithdrawal(userId, rawAmount) {
  const settings = await getSettings();
  const amount = validateAmount(rawAmount);
  if (amount < settings.min_withdrawal) {
    throw badRequest('INVALID_AMOUNT', `The minimum demo withdrawal is ${formatMoney(settings.min_withdrawal)}.`);
  }
  return withTransaction(async (tx) => {
    const result = await applyMovement(tx, userId, {
      availableDelta: -toCents(amount), type: 'WITHDRAWAL', direction: 'DEBIT', amount,
      description: 'Demo withdrawal — no real money transferred', status: 'DEMO_COMPLETED',
    });
    await notify(tx, userId, { type: 'WITHDRAWAL', title: 'Demo withdrawal completed', message: `${formatMoney(amount)} DEMO was withdrawn. No real money was transferred.`, link: '/wallet' });
    return { ...result, amount };
  });
}

/** Demo float for house bots so they can always cover a stake (recorded in the ledger). */
export function houseBotFloat(tx, userId, amount) {
  return applyMovement(tx, userId, {
    availableDelta: toCents(amount), type: 'DEPOSIT', direction: 'CREDIT', amount,
    description: 'House bot float — DEMO FUNDS', status: 'DEMO_COMPLETED',
  });
}

/** AVAILABLE -> LOCKED when a player enters a match. */
export function lockStake(tx, userId, match, gameName) {
  const cents = toCents(match.stake);
  return applyMovement(tx, userId, {
    availableDelta: -cents, lockedDelta: cents, type: 'GAME_ENTRY', direction: 'DEBIT', amount: match.stake,
    description: `${gameName} entry`, matchId: match.id,
    idempotencyKey: `match:${match.id}:entry:${userId}`,
  });
}

/** LOCKED -> AVAILABLE when a match is cancelled / drawn. */
export function refundStake(tx, userId, match, reason) {
  const cents = toCents(match.stake);
  return applyMovement(tx, userId, {
    availableDelta: cents, lockedDelta: -cents, type: 'REFUND', direction: 'CREDIT', amount: match.stake,
    description: `Refund: ${reason}`, matchId: match.id,
    idempotencyKey: `match:${match.id}:refund:${userId}`,
  });
}

/** Winner: locked stake released and prize credited. */
export function payWinner(tx, userId, match, gameName) {
  return applyMovement(tx, userId, {
    availableDelta: toCents(match.prize), lockedDelta: -toCents(match.stake), type: 'GAME_WIN', direction: 'CREDIT', amount: match.prize,
    description: `${gameName} win`, matchId: match.id,
    idempotencyKey: `match:${match.id}:win`,
  });
}

/** Loser: locked stake is forfeited to the pool. Still gets its own ledger row and idempotency key — every wallet mutation must be independently traceable and safe to retry. */
export function forfeitStake(tx, userId, match) {
  return applyMovement(tx, userId, {
    lockedDelta: -toCents(match.stake), type: 'FORFEIT', direction: 'DEBIT', amount: match.stake,
    description: 'Stake forfeited — lost to the pool', matchId: match.id,
    idempotencyKey: `match:${match.id}:forfeit:${userId}`,
  });
}

const TX_TYPES = ['DEPOSIT', 'WITHDRAWAL', 'GAME_ENTRY', 'GAME_WIN', 'REFUND', 'FORFEIT'];

export async function listTransactions({ userId = null, type, from, to, search, page = 1, pageSize = 20 }) {
  const where = [];
  const params = [];
  if (userId) { where.push('t.user_id = ?'); params.push(userId); }
  if (type && TX_TYPES.includes(type)) { where.push('t.type = ?'); params.push(type); }
  if (from) { where.push('t.created_at >= ?'); params.push(new Date(from)); }
  if (to) { where.push('t.created_at <= ?'); params.push(new Date(to)); }
  if (search) {
    where.push('(t.reference LIKE ? OR t.description LIKE ? OR u.username LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const pg = Math.max(Number(page) || 1, 1);
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM transactions t JOIN users u ON u.id = t.user_id ${whereSql}`, params);
  const rows = await query(
    `SELECT t.*, m.code AS match_code, u.username FROM transactions t
     JOIN users u ON u.id = t.user_id
     LEFT JOIN matches m ON m.id = t.match_id
     ${whereSql} ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`,
    [...params, size, (pg - 1) * size],
  );
  return { items: rows.map(mapTransaction), total, page: pg, pageSize: size };
}

export { TX_TYPES };
