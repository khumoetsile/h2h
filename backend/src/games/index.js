import * as reactionRush from './reactionRush.js';
import * as aimChallenge from './aimChallenge.js';
import * as memoryBattle from './memoryBattle.js';
import * as wordBattle from './wordBattle.js';
import * as penaltyShootout from './penaltyShootout.js';

// Registry of server-side game engines keyed by game slug.
export const engines = {
  'reaction-rush': reactionRush,
  'aim-challenge': aimChallenge,
  'memory-battle': memoryBattle,
  'word-battle': wordBattle,
  'penalty-shootout': penaltyShootout,
};

export function getEngine(slug) {
  const e = engines[slug];
  if (!e) throw new Error(`No engine for game ${slug}`);
  return e;
}
