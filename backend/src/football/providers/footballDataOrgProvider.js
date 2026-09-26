import { FootballDataProvider } from './provider.js';

// ---------------------------------------------------------------------------
// FootballDataOrgProvider — real implementation against api.football-data.org
// v4. The free tier covers fixtures, kickoff times and final scores for the
// competitions Head2Head targets, but does NOT include shot/corner/card
// statistics or a goal-by-goal event timeline — so this provider honestly
// reports capabilities().statistics = false / events = false, which is what
// automatically disables the stats-dependent challenge types (more shots,
// more corners, more cards, who scores first) rather than guessing at data
// it doesn't have. Upgrading to a plan with match statistics, or swapping in
// a different FootballDataProvider implementation, re-enables them with no
// other code changes.
//
// Requires FOOTBALL_API_KEY (a free key from https://www.football-data.org).
// Without a key, competitions can still be listed (that endpoint is public)
// but fixtures/results calls will fail — the sync service treats that as a
// transient provider outage, not a settlement decision.
// ---------------------------------------------------------------------------

const STATUS_MAP = {
  SCHEDULED: 'SCHEDULED', TIMED: 'SCHEDULED',
  IN_PLAY: 'LIVE', PAUSED: 'LIVE',
  FINISHED: 'FINISHED',
  POSTPONED: 'POSTPONED',
  SUSPENDED: 'POSTPONED',
  CANCELLED: 'CANCELLED',
  AWARDED: 'FINISHED',
};

export class FootballDataOrgProvider extends FootballDataProvider {
  constructor({ apiKey, baseUrl }) {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  get name() { return 'football-data'; }
  capabilities() { return { statistics: false, events: false }; }

  async #get(path) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.apiKey ? { 'X-Auth-Token': this.apiKey } : {},
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`football-data.org ${path} -> HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  #team(t) {
    if (!t) return null;
    return { providerId: String(t.id), name: t.name, shortName: t.shortName || t.tla || t.name, crestUrl: t.crest || null };
  }

  #fixture(m) {
    return {
      providerId: String(m.id),
      competitionProviderId: m.competition?.code,
      season: m.season?.startDate ? m.season.startDate.slice(0, 4) : null,
      homeTeam: this.#team(m.homeTeam),
      awayTeam: this.#team(m.awayTeam),
      kickoffAt: m.utcDate,
      status: STATUS_MAP[m.status] || 'SCHEDULED',
      minute: m.minute ?? null,
      homeScore: m.score?.fullTime?.home ?? m.score?.halfTime?.home ?? null,
      awayScore: m.score?.fullTime?.away ?? m.score?.halfTime?.away ?? null,
      statsAvailable: false,
      stats: {},
      events: [],
    };
  }

  async listCompetitions() {
    const data = await this.#get('/competitions');
    return (data.competitions || []).map((c) => ({
      providerId: String(c.id), code: c.code, name: c.name, country: c.area?.name || null, emblemUrl: c.emblem || null,
    }));
  }

  async listUpcomingFixtures(competitionCode, fromIso, toIso) {
    const dateFrom = fromIso.slice(0, 10);
    const dateTo = toIso.slice(0, 10);
    const data = await this.#get(`/competitions/${competitionCode}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`);
    return (data.matches || []).map((m) => this.#fixture(m));
  }

  async getFixture(providerFixtureId) {
    const data = await this.#get(`/matches/${providerFixtureId}`);
    if (!data?.id) return null;
    return this.#fixture(data);
  }
}
