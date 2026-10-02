/**
 * Games that are finished and shown to players. The others stay in the system but out of sight until they reach
 * the same quality, one at a time. Add a slug here to bring a game back.
 */
export const LIVE_GAMES = ['penalty-shootout', 'reaction-rush', 'aim-challenge', 'memory-battle', 'word-battle'];

export const isLiveGame = (slug: string) => LIVE_GAMES.includes(slug);
