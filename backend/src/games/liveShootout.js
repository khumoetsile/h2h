import { createRng, gauss } from './rng.js';

// LIVE PENALTY SHOOTOUT: pure rules, no database or sockets in here.
//
// Two players alternate as kicker and keeper, one kick ("round") at a time.
// Each round both choose in secret and the server reveals the result together.
//
//   Kicker: picks one of six zones (3 columns x high/low) AND stops a timing
//           bar. The bar decides how well the ball is struck.
//   Keeper: picks one of the same six zones to dive to.
//
// Resolution (see resolveKick):
//   - Struck badly (bar too far from the centre) -> MISSED: wide for a low
//     shot, over the bar for a high one. High shots are harder to keep on target.
//   - A PERFECT strike at a high zone cannot be saved.
//   - Otherwise it is SAVED only if the keeper dived to the very same zone, else GOAL.
//     (A keeper who goes low can't get to a shot in the top corner, and the other way round.)
//
// Format is the real one: five kicks each, alternating; it can end early once a
// side cannot catch up; if level after five each it goes to sudden death.

export const KICKS_PER_SIDE = 5;
/** Safety cap so a perfectly level shootout can't run forever (then it is a draw and stakes are refunded). */
export const MAX_KICKS_EACH = 15;
/** How long each player has to decide a kick once its window opens. */
export const DECISION_MS = 14000;
/** Pause before the first kick, and between kicks (lets the previous result play out). */
export const FIRST_KICK_DELAY_MS = 3000;
export const NEXT_KICK_DELAY_MS = 4800;

// Timing bar: distance of the stop position from the centre (0..0.5 of the track).
export const PERFECT_BAND = 0.09;
export const HIGH_BAND = 0.25;
export const LOW_BAND = 0.4;

export const ZONES = 6;
export const COLS = 3;
export const zoneRow = (z) => Math.floor(z / COLS); // 0 = high, 1 = low
export const zoneCol = (z) => z % COLS;             // 0 left, 1 centre, 2 right
export const isHigh = (z) => zoneRow(z) === 0;

/** Marker position 0..1 (triangle wave) at time t. Shared with the client. */
export function markerAt(periodMs, phase, t) {
  const p = ((t / periodMs) + phase) % 1;
  return p < 0.5 ? p * 2 : 2 - p * 2;
}

/** Timing-bar parameters for a round, derived from the match seed (same maths for any server). */
export function roundParams(seed, roundNo) {
  const rng = createRng(((Number(seed) >>> 0) ^ Math.imul(roundNo, 2654435761)) >>> 0);
  return { periodMs: rng.int(1900, 2500), phase: Math.round(rng.float(0, 1) * 1000) / 1000 };
}

/** Which of the two players (by slot, 1 or 2) takes the first kick: a coin toss from the seed. */
export function firstKickerSlot(seed) {
  return createRng((Number(seed) >>> 0) ^ 0x9e3779b9).bool() ? 1 : 2;
}

/** Kicker slot (1 or 2) for a given round number. */
export function kickerSlotFor(seed, roundNo) {
  const first = firstKickerSlot(seed);
  return roundNo % 2 === 1 ? first : first === 1 ? 2 : 1;
}

/**
 * Resolve one kick. `zone` and `stopMs` may be null when the kicker never shot
 * (ran out of time): that kick is simply missed.
 */
export function resolveKick({ zone, stopMs, keeperZone }, { periodMs, phase }) {
  if (zone == null || stopMs == null) return { outcome: 'MISSED', quality: 'NONE', marker: null };
  const marker = markerAt(periodMs, phase, stopMs);
  const off = Math.abs(marker - 0.5);
  const high = isHigh(zone);
  if (off > (high ? HIGH_BAND : LOW_BAND)) return { outcome: 'MISSED', quality: 'POOR', marker };
  if (high && off <= PERFECT_BAND) return { outcome: 'GOAL', quality: 'PERFECT', marker };
  return { outcome: keeperZone === zone ? 'SAVED' : 'GOAL', quality: 'GOOD', marker };
}

/**
 * Where the shootout stands. `kicks` are the resolved rounds in order, each
 * { kickerId, outcome }. `firstId` took kick 1.
 * Returns scores, kicks taken and whether it is decided (winnerId null + done = drawn at the cap).
 */
export function standing(kicks, firstId, secondId) {
  const goals = { [firstId]: 0, [secondId]: 0 };
  const taken = { [firstId]: 0, [secondId]: 0 };
  for (const k of kicks) {
    taken[k.kickerId] += 1;
    if (k.outcome === 'GOAL') goals[k.kickerId] += 1;
  }
  const a = goals[firstId]; const b = goals[secondId];
  const ka = taken[firstId]; const kb = taken[secondId];
  const leftA = Math.max(0, KICKS_PER_SIDE - ka);
  const leftB = Math.max(0, KICKS_PER_SIDE - kb);
  let winnerId;
  let done = false;
  if (ka >= KICKS_PER_SIDE && kb >= KICKS_PER_SIDE) {
    // Regular kicks used up on both sides: only a level count of kicks can settle it (sudden death).
    if (ka === kb) {
      if (a !== b) { done = true; winnerId = a > b ? firstId : secondId; }
      else if (ka >= MAX_KICKS_EACH) { done = true; winnerId = null; }
    }
  } else if (a > b + leftB) { done = true; winnerId = firstId; }
  else if (b > a + leftA) { done = true; winnerId = secondId; }
  return { goals, taken, done, winnerId: done ? (winnerId ?? null) : null, suddenDeath: ka >= KICKS_PER_SIDE && kb >= KICKS_PER_SIDE };
}

// ---- Choices made for a player who ran out of time, and for house bots ----------------

/** A keeper who never chose gets a random dive (reproducible from the seed, never a free save). */
export function autoKeeperZone(seed, roundNo) {
  return createRng(((Number(seed) >>> 0) ^ Math.imul(roundNo, 40503) ^ 0x51ed270b) >>> 0).int(0, COLS - 1);
}

/** House bot as kicker: picks a zone and aims the bar with a little human-like error. */
export function botKick(seed, roundNo, params) {
  const rng = createRng(((Number(seed) >>> 0) ^ Math.imul(roundNo, 69069) ^ 0xb5297a4d) >>> 0);
  const zone = rng.bool(0.4) ? rng.int(0, 2) : rng.int(3, 5);
  const high = isHigh(zone);
  // Human-like slips: a bot occasionally mistimes it, so it is beatable and not a machine.
  const target = 0.5 + (rng.bool() ? 1 : -1) * Math.abs(gauss(rng, 0, high ? 0.14 : 0.2));
  let best = 600; let bestErr = Infinity;
  for (let t = 600; t < 4000; t += 10) {
    const err = Math.abs(markerAt(params.periodMs, params.phase, t) - target);
    if (err < bestErr) { bestErr = err; best = t; }
  }
  return { zone, stopMs: best };
}

/** House bot as keeper: dives to any of the six zones. */
export function botDive(seed, roundNo) {
  return createRng(((Number(seed) >>> 0) ^ Math.imul(roundNo, 1103515245) ^ 0x2545f491) >>> 0).int(0, COLS - 1);
}

// ---- Legacy interface -------------------------------------------------------------------
// The platform's solo-submission games implement buildSpec/score/... This game is played
// live instead; `live` tells the match service to route it to the live shootout service.
export const live = true;
