import { clamp, createRng, gauss, isNum } from './rng.js';

// MEMORY BATTLE — watch a sequence light up on a 4x4 grid, then repeat it.
// Sequences grow from 3 to 9. Correctness is verified entirely server-side.
const LENGTHS = [3, 4, 5, 5, 6, 7, 8, 9];
const CELLS = 16;

export function buildSpec(seed) {
  const rng = createRng(seed);
  const rounds = LENGTHS.map((len) => {
    const seq = [];
    while (seq.length < len) {
      const c = rng.int(0, CELLS - 1);
      if (seq[seq.length - 1] !== c) seq.push(c);
    }
    return { sequence: seq };
  });
  return { grid: 4, rounds, flashMs: 480, gapMs: 170, inputLimitMs: 15000, countdownMs: 3000 };
}

export function score(spec, submission) {
  const input = Array.isArray(submission?.rounds) ? submission.rounds : [];
  const rounds = spec.rounds.map((r, i) => {
    const s = input[i] || {};
    const entered = Array.isArray(s.input) ? s.input.filter((n) => Number.isInteger(n)).slice(0, 20) : [];
    const timeMs = isNum(s.timeMs) ? Math.round(s.timeMs) : spec.inputLimitMs;
    const len = r.sequence.length;
    const correct = entered.length === len && entered.every((c, j) => c === r.sequence[j]);
    const plausible = timeMs >= len * 110;
    if (!correct || !plausible || timeMs > spec.inputLimitMs) {
      // Partial credit for the correct prefix.
      let prefix = 0;
      while (prefix < entered.length && entered[prefix] === r.sequence[prefix]) prefix++;
      return { round: i + 1, status: plausible ? 'WRONG' : 'TOO_FAST', length: len, correctPrefix: prefix, timeMs, points: plausible ? prefix * 20 : 0 };
    }
    const bonus = clamp(Math.round(300 - timeMs / len / 8), 0, 300);
    return { round: i + 1, status: 'CORRECT', length: len, correctPrefix: len, timeMs, points: len * 100 + bonus };
  });
  const correct = rounds.filter((r) => r.status === 'CORRECT');
  const totalTime = rounds.reduce((a, r) => a + r.timeMs, 0);
  return {
    score: rounds.reduce((a, r) => a + r.points, 0),
    tiebreak: -totalTime,
    valid: true,
    invalidReason: null,
    rounds,
    summary: {
      sequencesCorrect: correct.length,
      totalRounds: rounds.length,
      longestSequence: correct.length ? Math.max(...correct.map((r) => r.length)) : 0,
      totalInputMs: totalTime,
    },
  };
}

export function minDurationMs(spec, scored) {
  const show = spec.rounds.reduce((a, r) => a + r.sequence.length * (spec.flashMs + spec.gapMs), 0);
  return spec.countdownMs + show + scored.rounds.reduce((a, r) => a + Math.min(r.timeMs, spec.inputLimitMs), 0);
}

export function botPlay(spec, rng) {
  return {
    rounds: spec.rounds.map((r) => {
      const len = r.sequence.length;
      const failP = clamp((len - 4) * 0.09, 0, 0.6);
      const input = [...r.sequence];
      if (rng.bool(failP)) input[rng.int(0, len - 1)] = (input[0] + 1) % 16;
      return { input, timeMs: Math.round(len * clamp(gauss(rng, 520, 120), 250, 1200)) };
    }),
  };
}
