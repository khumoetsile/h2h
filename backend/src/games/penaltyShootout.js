import { clamp, createRng, gauss, isNum } from './rng.js';

// PENALTY SHOOTOUT — 5 shots. An aim marker sweeps across the goal; stop it to
// shoot. The keeper visibly leans one way; where they actually dive is decided
// by the seed and kept on the server. The ball position is computed on the
// server from the reported stop time, so a client can't just claim "goal".
const SHOTS = 5;
const MAX_SHOT_MS = 6000;
// A full left-right-left sweep takes 1.7 to 2.7 s, slow enough to aim on a phone.

function fullSpec(seed) {
  const rng = createRng(seed);
  return Array.from({ length: SHOTS }, () => {
    const lean = rng.pick(['LEFT', 'CENTER', 'RIGHT']);
    const dive = rng.bool(0.55) ? lean : rng.pick(['LEFT', 'CENTER', 'RIGHT'].filter((z) => z !== lean));
    return { periodMs: rng.int(1700, 2700), phase: Math.round(rng.float(0, 1) * 1000) / 1000, lean, dive };
  });
}

export function buildSpec(seed) {
  return { shots: fullSpec(seed).map(({ periodMs, phase, lean }) => ({ periodMs, phase, lean })), maxShotMs: MAX_SHOT_MS, countdownMs: 3000 };
}

/** Marker position 0..1 (triangle wave) at time t. Shared with the client. */
export function markerAt(periodMs, phase, t) {
  const p = ((t / periodMs) + phase) % 1;
  return p < 0.5 ? p * 2 : 2 - p * 2;
}

const zoneOf = (x) => (x < 1 / 3 ? 'LEFT' : x < 2 / 3 ? 'CENTER' : 'RIGHT');

export function score(spec, submission, seed) {
  const shots = fullSpec(seed);
  const input = Array.isArray(submission?.shots) ? submission.shots : [];
  const rounds = shots.map((s, i) => {
    const t = isNum(input[i]?.stopMs) ? clamp(Math.round(input[i].stopMs), 0, MAX_SHOT_MS) : MAX_SHOT_MS;
    const x = markerAt(s.periodMs, s.phase, t);
    const zone = zoneOf(x);
    let status;
    if (x < 0.05 || x > 0.95) status = 'WIDE';
    else if (zone === s.dive) status = 'SAVED';
    else status = 'GOAL';
    const placement = Math.round(Math.abs(x - 0.5) * 200); // 0 centre .. 100 post
    const points = status === 'GOAL' ? 1000 + placement : 0;
    return { round: i + 1, status, position: Math.round(x * 1000) / 1000, zone, keeperDive: s.dive, stopMs: t, points };
  });
  const goals = rounds.filter((r) => r.status === 'GOAL').length;
  return {
    score: rounds.reduce((a, r) => a + r.points, 0),
    tiebreak: -rounds.reduce((a, r) => a + r.stopMs, 0),
    valid: true,
    invalidReason: null,
    rounds,
    summary: { goals, shots: SHOTS, saved: rounds.filter((r) => r.status === 'SAVED').length, wide: rounds.filter((r) => r.status === 'WIDE').length },
  };
}

export function minDurationMs(spec, scored) {
  return spec.countdownMs + scored.rounds.reduce((a, r) => a + r.stopMs, 0);
}

export function botPlay(spec, rng) {
  return {
    shots: spec.shots.map((s) => {
      // Bot aims away from the lean, with human-ish timing error.
      const targets = { LEFT: [0.72, 0.85], CENTER: [0.15, 0.85], RIGHT: [0.15, 0.28] }[s.lean];
      const want = rng.pick(targets) + gauss(rng, 0, 0.08);
      for (let t = 400; t < MAX_SHOT_MS; t += 10) {
        if (Math.abs(markerAt(s.periodMs, s.phase, t) - want) < 0.02) return { stopMs: t };
      }
      return { stopMs: rng.int(500, 3000) };
    }),
  };
}
