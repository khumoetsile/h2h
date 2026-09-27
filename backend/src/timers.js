// Timer policy for 1v1 challenges. Durations come from config.timers; this
// module only turns them into absolute deadlines and answers "has this
// player's time run out?". One clock is used for all of it — this Node
// process's — so a client (or a drifting DB container clock) can never move
// a deadline.
//
// Lifecycle and the deadline that governs each phase:
//   WAITING      acceptance_deadline        -> CANCELLED (NO_OPPONENT), full refund, no fee
//   MATCHED      lock_in_deadline, and player_action_deadline once one side
//                has locked in              -> CANCELLED (LOCK_IN_TIMEOUT), full refunds, no fee
//   READY / IN_PROGRESS (skill game)
//                completion_deadline, and player_action_deadline once one side
//                has finished               -> one finished: the other forfeits (ACTION_TIMEOUT)
//                                              neither finished: CANCELLED (GAME_TIMEOUT), full refunds, no fee
//   READY / IN_PROGRESS (football)
//                kickoff, then completion_deadline (kickoff + result timeout)
//                                           -> VOID (RESULT_TIMEOUT), full refunds, no fee
//
// Reconnection: if a player who still owes an action loses their last
// connection before their deadline, their deadline is extended to the end
// of their reconnection window (never further). Reconnecting in time simply
// continues the challenge.
import { config } from './config.js';

export const TIMERS = config.timers;

export const addSeconds = (date, seconds) => new Date(new Date(date).getTime() + seconds * 1000);

/** The earliest of the given dates, ignoring null/undefined. */
export function earliest(...dates) {
  const valid = dates.filter(Boolean).map((d) => new Date(d));
  if (!valid.length) return null;
  return new Date(Math.min(...valid.map((d) => d.getTime())));
}

export function acceptanceDeadline(from = new Date(), cap = null) {
  return earliest(addSeconds(from, TIMERS.challengeAcceptanceSeconds), cap);
}

export function lockInDeadline(from = new Date(), cap = null) {
  return earliest(addSeconds(from, TIMERS.lockInSeconds), cap);
}

export function playerActionDeadline(from = new Date(), cap = null) {
  return earliest(addSeconds(from, TIMERS.playerActionSeconds), cap);
}

export function skillCompletionDeadline(lockedAt = new Date()) {
  return addSeconds(lockedAt, TIMERS.lockedGameSeconds);
}

export function footballCompletionDeadline(kickoffAt) {
  return addSeconds(kickoffAt, TIMERS.footballResultTimeoutMinutes * 60);
}

export function reconnectDeadline(from = new Date()) {
  return addSeconds(from, TIMERS.reconnectionSeconds);
}

/** Does this player still owe an action in the match's current phase? */
export function owesAction(m, p) {
  if (m.status === 'MATCHED') return !p.ready_at;
  if (m.category === 'SKILL_GAME' && (m.status === 'READY' || m.status === 'IN_PROGRESS')) return !p.submitted_at;
  return false;
}

/** The phase deadline before any reconnection grace (null when no player-driven timer is running). */
export function baseDeadline(m, kickoffAt = null) {
  if (m.status === 'WAITING') return m.acceptance_deadline;
  if (m.status === 'MATCHED') return earliest(m.lock_in_deadline, m.player_action_deadline, kickoffAt);
  if (m.category === 'SKILL_GAME' && (m.status === 'READY' || m.status === 'IN_PROGRESS')) {
    return earliest(m.completion_deadline, m.player_action_deadline);
  }
  return null;
}

/**
 * The moment this specific player's time actually runs out: the phase
 * deadline, extended to their reconnection deadline if they dropped offline
 * before the phase deadline. A football lock-in can never run past kickoff.
 */
export function playerDeadline(m, p, kickoffAt = null) {
  const base = baseDeadline(m, kickoffAt);
  if (!base || !owesAction(m, p)) return base;
  const dropped = p.disconnected_at && new Date(p.disconnected_at) <= new Date(base);
  if (!dropped || !p.reconnect_deadline) return base;
  const extended = new Date(Math.max(new Date(base).getTime(), new Date(p.reconnect_deadline).getTime()));
  return kickoffAt ? earliest(extended, kickoffAt) : extended;
}

export function isPast(deadline, now = new Date(), graceMs = 0) {
  return !!deadline && new Date(deadline).getTime() + graceMs <= now.getTime();
}

/** Public, client-safe description of every timer (durations only — deadlines come per match). */
export function publicTimerConfig() {
  return {
    challengeAcceptanceSeconds: TIMERS.challengeAcceptanceSeconds,
    lockInSeconds: TIMERS.lockInSeconds,
    lockedGameSeconds: TIMERS.lockedGameSeconds,
    playerActionSeconds: TIMERS.playerActionSeconds,
    reconnectionSeconds: TIMERS.reconnectionSeconds,
    footballResultTimeoutMinutes: TIMERS.footballResultTimeoutMinutes,
  };
}
