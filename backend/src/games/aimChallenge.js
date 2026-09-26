import { clamp, createRng, gauss, isNum } from './rng.js';

// AIM CHALLENGE — 20 small targets appear one after another and shrink away.
// Points reward speed and precision (distance from the bullseye).
const TARGETS = 20;
const LIFETIME_MS = 1200;

export function buildSpec(seed) {
  const rng = createRng(seed);
  const targets = [];
  for (let i = 0; i < TARGETS; i++) {
    targets.push({ x: Math.round(rng.float(8, 92) * 10) / 10, y: Math.round(rng.float(10, 90) * 10) / 10, size: rng.int(38, 58) });
  }
  return { targets, lifetimeMs: LIFETIME_MS, gapMs: 250, countdownMs: 3000 };
}

export function score(spec, submission) {
  const input = Array.isArray(submission?.targets) ? submission.targets : [];
  const rounds = spec.targets.map((t, i) => {
    const s = input[i] || {};
    const rt = isNum(s.reactionMs) ? Math.round(s.reactionMs) : null;
    const offset = isNum(s.offset) ? clamp(s.offset, 0, 1) : 1;
    if (s.hit !== true || rt === null || rt > spec.lifetimeMs) return { round: i + 1, status: 'MISS', reactionMs: null, precision: 0, points: 0 };
    if (rt < 120) return { round: i + 1, status: 'TOO_FAST', reactionMs: null, precision: 0, points: 0 };
    const speedPts = clamp(Math.round(600 - (rt - 150) * 0.5), 50, 600);
    const precisionPct = Math.round((1 - offset) * 100);
    return { round: i + 1, status: 'HIT', reactionMs: rt, precision: precisionPct, points: speedPts + precisionPct * 4 };
  });
  const hits = rounds.filter((r) => r.status === 'HIT');
  const tooFast = rounds.filter((r) => r.status === 'TOO_FAST').length;
  const totalRt = hits.reduce((a, r) => a + r.reactionMs, 0);
  return {
    score: rounds.reduce((a, r) => a + r.points, 0),
    tiebreak: hits.length * 10000 - totalRt,
    valid: tooFast < 5,
    invalidReason: tooFast >= 5 ? 'Too many impossible reactions' : null,
    rounds,
    summary: {
      hits: hits.length,
      misses: TARGETS - hits.length,
      accuracyPct: Math.round((hits.length / TARGETS) * 100),
      averageReactionMs: hits.length ? Math.round(totalRt / hits.length) : null,
      averagePrecisionPct: hits.length ? Math.round(hits.reduce((a, r) => a + r.precision, 0) / hits.length) : null,
    },
  };
}

export function minDurationMs(spec, scored) {
  return spec.countdownMs + scored.rounds.reduce((a, r) => a + (r.reactionMs ?? spec.lifetimeMs), 0) + spec.gapMs * (TARGETS - 1) * 0.5;
}

export function botPlay(spec, rng) {
  return {
    targets: spec.targets.map(() => {
      if (rng.bool(0.12)) return { hit: false };
      return { hit: true, reactionMs: Math.round(clamp(gauss(rng, 520, 110), 260, 1150)), offset: clamp(Math.abs(gauss(rng, 0.3, 0.2)), 0, 0.95) };
    }),
  };
}
