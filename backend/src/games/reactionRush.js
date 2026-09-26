import { clamp, createRng, gauss, isNum } from './rng.js';

// REACTION RUSH — 10 rounds. After a random delay a target appears at a
// seeded position; tap it as fast as possible. Same sequence for both players.
export const MIN_HUMAN_REACTION_MS = 100;
const ROUNDS = 10;
const WINDOW_MS = 1500;
const COUNTDOWN_MS = 3000;
const INTER_ROUND_MS = 700;

export function buildSpec(seed) {
  const rng = createRng(seed);
  const rounds = [];
  for (let i = 0; i < ROUNDS; i++) {
    rounds.push({
      delayMs: rng.int(700, 2400),
      x: Math.round(rng.float(10, 90) * 10) / 10,
      y: Math.round(rng.float(12, 88) * 10) / 10,
      size: rng.int(56, 76),
    });
  }
  return { rounds, windowMs: WINDOW_MS, countdownMs: COUNTDOWN_MS, interRoundMs: INTER_ROUND_MS };
}

export const pointsFor = (rt) => clamp(Math.round(1100 - rt * 0.8), 100, 1000);

export function score(spec, submission) {
  const input = Array.isArray(submission?.rounds) ? submission.rounds : [];
  const rounds = spec.rounds.map((r, i) => {
    const s = input[i] || {};
    const rt = isNum(s.reactionMs) ? Math.round(s.reactionMs) : null;
    let status = 'MISS';
    let points = 0;
    if (s.hit === true && rt !== null) {
      if (rt < MIN_HUMAN_REACTION_MS) status = 'TOO_FAST';
      else if (rt > spec.windowMs) status = 'MISS';
      else { status = 'HIT'; points = pointsFor(rt); }
    } else if (s.falseStart === true) status = 'FALSE_START';
    return { round: i + 1, status, reactionMs: status === 'HIT' ? rt : null, points };
  });
  const hits = rounds.filter((r) => r.status === 'HIT');
  const totalRt = hits.reduce((a, r) => a + r.reactionMs, 0);
  const total = rounds.reduce((a, r) => a + r.points, 0);
  const tooFast = rounds.filter((r) => r.status === 'TOO_FAST').length;
  return {
    score: total,
    // Higher is better; fewer total ms (with misses penalised at full window) wins ties.
    tiebreak: -(totalRt + (ROUNDS - hits.length) * spec.windowMs),
    valid: tooFast < 4,
    invalidReason: tooFast >= 4 ? 'Too many impossible (<100ms) reactions' : null,
    rounds,
    summary: {
      hits: hits.length,
      misses: ROUNDS - hits.length,
      averageReactionMs: hits.length ? Math.round(totalRt / hits.length) : null,
      bestReactionMs: hits.length ? Math.min(...hits.map((r) => r.reactionMs)) : null,
      totalReactionMs: totalRt,
    },
  };
}

/** Minimum wall-clock time a genuine run of this submission could take. */
export function minDurationMs(spec, scored) {
  const delays = spec.rounds.reduce((a, r) => a + r.delayMs, 0);
  const reacts = scored.rounds.reduce((a, r) => a + (r.reactionMs ?? 0), 0);
  return spec.countdownMs + delays + reacts;
}

export function botPlay(spec, rng) {
  const skill = rng.float(0.85, 1.2);
  return {
    rounds: spec.rounds.map(() => {
      if (rng.bool(0.08)) return { hit: false, reactionMs: null };
      return { hit: true, reactionMs: Math.round(clamp(gauss(rng, 330 * skill, 70), 180, 1400)) };
    }),
  };
}
