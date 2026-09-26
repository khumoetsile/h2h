import { config } from '../config.js';

/** Convert to integer cents to avoid floating point drift. */
export const toCents = (amount) => Math.round(Number(amount) * 100);
export const fromCents = (cents) => Math.round(cents) / 100;
export const round2 = (n) => fromCents(toCents(n));

export function formatMoney(amount) {
  const n = Number(amount);
  return `${config.currencySymbol}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Pool / fee / prize for a two-player match. Fee is rounded to cents. */
export function computePrize(stake, feePercent, players = 2) {
  const poolCents = toCents(stake) * players;
  const feeCents = Math.round((poolCents * Number(feePercent)) / 100);
  return { pool: fromCents(poolCents), fee: fromCents(feeCents), prize: fromCents(poolCents - feeCents) };
}
