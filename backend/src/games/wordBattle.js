import { clamp, createRng, gauss, isNum } from './rng.js';

// WORD BATTLE — unscramble 8 words. Answers never leave the server; only the
// scrambled letters are sent to the client.
const WORDS = [
  'rocket', 'planet', 'garden', 'silver', 'market', 'bridge', 'castle', 'window', 'forest', 'guitar',
  'number', 'orange', 'winter', 'summer', 'dragon', 'pencil', 'jungle', 'bottle', 'camera', 'tunnel',
  'player', 'stream', 'mirror', 'shadow', 'thunder', 'lantern', 'captain', 'journey', 'victory', 'balance',
  'rhythm', 'puzzle', 'anchor', 'breeze', 'coffee', 'desert', 'engine', 'falcon', 'hammer', 'island',
  'kitten', 'ladder', 'magnet', 'napkin', 'office', 'parrot', 'quartz', 'rabbit', 'saddle', 'ticket',
  'bright', 'strong', 'danger', 'legend', 'battle', 'energy', 'savage', 'lion', 'zebra', 'safari',
];
const ROUNDS = 8;
const LIMIT_MS = 20000;

function scrambleWord(rng, word) {
  const letters = word.split('');
  for (let tries = 0; tries < 20; tries++) {
    const s = rng.shuffle(letters).join('');
    if (s !== word) return s;
  }
  return letters.reverse().join('');
}

/** Server-only: full spec including answers. */
function fullSpec(seed) {
  const rng = createRng(seed);
  const words = rng.shuffle(WORDS).slice(0, ROUNDS);
  return words.map((w) => ({ answer: w, scrambled: scrambleWord(rng, w).toUpperCase() }));
}

export function buildSpec(seed) {
  return { words: fullSpec(seed).map((w) => ({ scrambled: w.scrambled, length: w.scrambled.length })), limitMs: LIMIT_MS, countdownMs: 3000 };
}

export function score(spec, submission, seed) {
  const answers = fullSpec(seed);
  const input = Array.isArray(submission?.words) ? submission.words : [];
  const rounds = answers.map((w, i) => {
    const s = input[i] || {};
    const guess = typeof s.answer === 'string' ? s.answer.trim().toLowerCase().slice(0, 20) : '';
    const timeMs = isNum(s.timeMs) ? Math.round(s.timeMs) : LIMIT_MS;
    const correct = guess === w.answer && timeMs <= LIMIT_MS;
    const plausible = timeMs >= 400;
    const points = correct && plausible ? 500 + clamp(Math.round(500 - timeMs / 30), 0, 500) : 0;
    return { round: i + 1, status: !plausible ? 'TOO_FAST' : correct ? 'CORRECT' : guess ? 'WRONG' : 'SKIPPED', answer: w.answer.toUpperCase(), guess: guess.toUpperCase(), timeMs, points };
  });
  const correct = rounds.filter((r) => r.status === 'CORRECT');
  const totalTime = rounds.reduce((a, r) => a + Math.min(r.timeMs, LIMIT_MS), 0);
  return {
    score: rounds.reduce((a, r) => a + r.points, 0),
    tiebreak: -totalTime,
    valid: true,
    invalidReason: null,
    rounds,
    summary: { wordsSolved: correct.length, totalWords: ROUNDS, averageSolveMs: correct.length ? Math.round(correct.reduce((a, r) => a + r.timeMs, 0) / correct.length) : null },
  };
}

export function minDurationMs(spec, scored) {
  return spec.countdownMs + scored.rounds.reduce((a, r) => a + Math.min(r.timeMs, LIMIT_MS), 0);
}

export function botPlay(spec, rng, seed) {
  const answers = fullSpec(seed);
  return {
    words: answers.map((w) => (rng.bool(0.25)
      ? { answer: '', timeMs: LIMIT_MS }
      : { answer: w.answer, timeMs: Math.round(clamp(gauss(rng, 6500, 2500), 1800, 19000)) })),
  };
}
