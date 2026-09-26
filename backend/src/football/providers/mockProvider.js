import { FootballDataProvider } from './provider.js';
import { createRng, clamp } from '../../games/rng.js';

// ---------------------------------------------------------------------------
// MockFootballProvider — a fully self-contained, clearly-labelled SIMULATED
// data source. It needs no API key and no network access, so the whole
// Football vertical (fixtures, live progress, full-time stats, settlement)
// is testable end-to-end without depending on a paid third-party plan.
//
// Determinism is the whole trick: every fixture id encodes the competition,
// kickoff date and the two team indexes, so calling getFixture() twice with
// the same id — or restarting the server — always derives the exact same
// simulated match. "Live" progress is computed from wall-clock time versus
// kickoff, not from a stored mutable score, so nothing needs a per-second
// timer job.
// ---------------------------------------------------------------------------

const COMPETITIONS = [
  { code: 'PL', name: 'Premier League', country: 'England' },
  { code: 'PD', name: 'La Liga', country: 'Spain' },
  { code: 'SA', name: 'Serie A', country: 'Italy' },
  { code: 'BL1', name: 'Bundesliga', country: 'Germany' },
  { code: 'FL1', name: 'Ligue 1', country: 'France' },
  { code: 'CL', name: 'UEFA Champions League', country: 'Europe' },
];

const TEAM_POOLS = {
  PL: ['Arsenal', 'Chelsea', 'Liverpool', 'Manchester City', 'Manchester United', 'Tottenham Hotspur', 'Newcastle United', 'Aston Villa'],
  PD: ['Real Madrid', 'Barcelona', 'Atletico Madrid', 'Sevilla', 'Real Sociedad', 'Valencia', 'Villarreal', 'Real Betis'],
  SA: ['Juventus', 'Inter Milan', 'AC Milan', 'Napoli', 'Roma', 'Lazio', 'Atalanta', 'Fiorentina'],
  BL1: ['Bayern Munich', 'Borussia Dortmund', 'RB Leipzig', 'Bayer Leverkusen', 'Eintracht Frankfurt', 'Wolfsburg', 'Freiburg', 'Union Berlin'],
  FL1: ['Paris Saint-Germain', 'Marseille', 'Lyon', 'Monaco', 'Lille', 'Rennes', 'Nice', 'Lens'],
  CL: ['Real Madrid', 'Manchester City', 'Bayern Munich', 'Paris Saint-Germain', 'Barcelona', 'Liverpool', 'Inter Milan', 'Borussia Dortmund'],
};

const MATCH_MINUTES = 95; // simulated full time incl. stoppage
const FIXTURES_PER_WEEK = 2;

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function fixtureIdsFor(code, windowDays) {
  const weeks = Math.max(1, Math.ceil(windowDays / 7));
  const teams = TEAM_POOLS[code] || [];
  const ids = [];
  for (let w = 0; w < weeks; w++) {
    const rng = createRng(hashSeed(`${code}:week:${w}`));
    const shuffled = rng.shuffle(teams.map((_, i) => i));
    for (let f = 0; f < FIXTURES_PER_WEEK && f * 2 + 1 < shuffled.length; f++) {
      const homeIdx = shuffled[f * 2];
      const awayIdx = shuffled[f * 2 + 1];
      const dayOffset = w * 7 + 5 + f * 2; // Saturdays/Mondays-ish, 2 days apart
      ids.push(`mock:${code}:${dayOffset}:${homeIdx}-${awayIdx}`);
    }
  }
  return ids;
}

function parseFixtureId(id) {
  const m = /^mock:([A-Z0-9]+):(\d+):(\d+)-(\d+)$/.exec(id);
  if (!m) return null;
  const [, code, dayOffset, homeIdx, awayIdx] = m;
  return { code, dayOffset: Number(dayOffset), homeIdx: Number(homeIdx), awayIdx: Number(awayIdx) };
}

function kickoffFor(dayOffset) {
  // Anchor to the start of today (UTC) so fixtures don't drift as the day goes on.
  const anchor = new Date();
  anchor.setUTCHours(0, 0, 0, 0);
  const d = new Date(anchor.getTime() + dayOffset * 86400000);
  d.setUTCHours(15, 0, 0, 0); // 15:00 UTC kickoff
  return d;
}

/** Simulate a plausible full match from a seed: score, shots, corners, cards, goal timeline. */
function simulateFinal(seed) {
  const rng = createRng(seed);
  const goals = [];
  const goalCount = rng.int(0, 4);
  for (let i = 0; i < goalCount; i++) {
    goals.push({ minute: rng.int(1, MATCH_MINUTES), team: rng.bool(0.5) ? 'HOME' : 'AWAY' });
  }
  goals.sort((a, b) => a.minute - b.minute);
  const homeScore = goals.filter((g) => g.team === 'HOME').length;
  const awayScore = goals.filter((g) => g.team === 'AWAY').length;
  const cards = [];
  const cardCount = rng.int(0, 6);
  for (let i = 0; i < cardCount; i++) {
    cards.push({ minute: rng.int(1, MATCH_MINUTES), team: rng.bool(0.5) ? 'HOME' : 'AWAY', type: rng.bool(0.88) ? 'YELLOW_CARD' : 'RED_CARD' });
  }
  return {
    homeScore, awayScore,
    homeShots: rng.int(4, 18), awayShots: rng.int(4, 18),
    homeCorners: rng.int(1, 12), awayCorners: rng.int(1, 12),
    homeCards: cards.filter((c) => c.team === 'HOME').length,
    awayCards: cards.filter((c) => c.team === 'AWAY').length,
    firstGoalTeam: goals.length ? goals[0].team : 'NONE',
    events: [
      ...goals.map((g) => ({ minute: g.minute, type: 'GOAL', team: g.team, playerName: null, detail: null })),
      ...cards.map((c) => ({ minute: c.minute, type: c.type, team: c.team, playerName: null, detail: null })),
    ].sort((a, b) => a.minute - b.minute),
  };
}

export class MockFootballProvider extends FootballDataProvider {
  get name() { return 'mock'; }
  capabilities() { return { statistics: true, events: true }; }

  async listCompetitions() {
    return COMPETITIONS.map((c) => ({ providerId: c.code, code: c.code, name: c.name, country: c.country, emblemUrl: null }));
  }

  async listUpcomingFixtures(competitionCode, fromIso, toIso) {
    const from = new Date(fromIso).getTime();
    const to = new Date(toIso).getTime();
    const windowDays = Math.max(1, Math.ceil((to - from) / 86400000) + 14);
    const ids = fixtureIdsFor(competitionCode, windowDays);
    const fixtures = [];
    for (const id of ids) {
      const fx = await this.getFixture(id);
      if (fx && new Date(fx.kickoffAt).getTime() >= from - 86400000 * 3 && new Date(fx.kickoffAt).getTime() <= to) fixtures.push(fx);
    }
    return fixtures;
  }

  async getFixture(providerFixtureId) {
    const parsed = parseFixtureId(providerFixtureId);
    if (!parsed) return null;
    const { code, dayOffset, homeIdx, awayIdx } = parsed;
    const teams = TEAM_POOLS[code];
    if (!teams || !teams[homeIdx] || !teams[awayIdx]) return null;
    const kickoff = kickoffFor(dayOffset);
    const now = Date.now();
    const elapsedMs = now - kickoff.getTime();
    const seed = hashSeed(providerFixtureId);

    const team = (n) => ({ providerId: `${code}:${n.replace(/\s+/g, '_').toLowerCase()}`, name: n, shortName: n.split(' ')[0], crestUrl: null });
    const base = {
      providerId: providerFixtureId,
      competitionProviderId: code,
      season: `${new Date().getUTCFullYear()}`,
      homeTeam: team(teams[homeIdx]),
      awayTeam: team(teams[awayIdx]),
      kickoffAt: kickoff.toISOString(),
      statsAvailable: true,
    };

    if (elapsedMs < 0) {
      return { ...base, status: 'SCHEDULED', minute: null, homeScore: null, awayScore: null, stats: {}, events: [] };
    }
    const final = simulateFinal(seed);
    const elapsedMin = elapsedMs / 60000;
    if (elapsedMin >= MATCH_MINUTES + 5) {
      return {
        ...base, status: 'FINISHED', minute: 90, homeScore: final.homeScore, awayScore: final.awayScore,
        stats: { homeShots: final.homeShots, awayShots: final.awayShots, homeCorners: final.homeCorners, awayCorners: final.awayCorners, homeCards: final.homeCards, awayCards: final.awayCards, firstGoalTeam: final.firstGoalTeam },
        events: final.events,
      };
    }
    // LIVE: interpolate score/stats proportionally to elapsed minutes so a
    // mid-match poll sees a plausible partial state, converging on `final`.
    const minute = clamp(Math.round(elapsedMin), 1, 90);
    const progress = minute / MATCH_MINUTES;
    const eventsSoFar = final.events.filter((e) => e.minute <= minute);
    const homeScoreSoFar = eventsSoFar.filter((e) => e.type === 'GOAL' && e.team === 'HOME').length;
    const awayScoreSoFar = eventsSoFar.filter((e) => e.type === 'GOAL' && e.team === 'AWAY').length;
    return {
      ...base, status: 'LIVE', minute,
      homeScore: homeScoreSoFar, awayScore: awayScoreSoFar,
      stats: {
        homeShots: Math.round(final.homeShots * progress), awayShots: Math.round(final.awayShots * progress),
        homeCorners: Math.round(final.homeCorners * progress), awayCorners: Math.round(final.awayCorners * progress),
        homeCards: eventsSoFar.filter((e) => e.team === 'HOME' && e.type.endsWith('CARD')).length,
        awayCards: eventsSoFar.filter((e) => e.team === 'AWAY' && e.type.endsWith('CARD')).length,
        firstGoalTeam: eventsSoFar.find((e) => e.type === 'GOAL')?.team ?? 'NONE',
      },
      events: eventsSoFar,
    };
  }
}
