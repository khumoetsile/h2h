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
    this.headToHeadCache = new Map();
    this.teamMatchesCache = new Map();
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

  async #getTeamMatches(teamProviderId) {
    const key = String(teamProviderId);
    const cached = this.teamMatchesCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    if (cached) this.teamMatchesCache.delete(key);

    const entry = { expiresAt: Date.now() + 15 * 60 * 1000, promise: null };
    entry.promise = this.#get(`/teams/${encodeURIComponent(key)}/matches?status=FINISHED&limit=500`)
      .then((data) => {
        if (!Array.isArray(data.matches)) throw new Error(`football-data.org team history for ${key} did not include a matches array.`);
        return data.matches.map((match) => ({
          ...this.#fixture(match),
          homeScore: match.score?.fullTime?.home ?? null,
          awayScore: match.score?.fullTime?.away ?? null,
          competitionName: match.competition?.name || match.competition?.code || null,
        }));
      })
      .catch((err) => {
        if (this.teamMatchesCache.get(key) === entry) this.teamMatchesCache.delete(key);
        throw err;
      });
    this.teamMatchesCache.set(key, entry);
    if (this.teamMatchesCache.size > 100) this.teamMatchesCache.delete(this.teamMatchesCache.keys().next().value);
    return entry.promise;
  }

  async getTeamMatches(teamProviderId) {
    return this.#getTeamMatches(teamProviderId);
  }

  async getHeadToHead(providerFixtureId, homeTeamProviderId, awayTeamProviderId) {
    const key = String(providerFixtureId);
    const cached = this.headToHeadCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    if (cached) this.headToHeadCache.delete(key);

    const entry = {
      expiresAt: Date.now() + 15 * 60 * 1000,
      promise: null,
    };
    entry.promise = (async () => {
      let headToHeadError = null;
      let matches = [];
      try {
        const data = await this.#get(`/matches/${encodeURIComponent(key)}/head2head?limit=50`);
        if (!Array.isArray(data.matches)) throw new Error('football-data.org head2head response did not include a matches array.');
        matches = data.matches.map((match) => ({
          ...this.#fixture(match),
          homeScore: match.score?.fullTime?.home ?? null,
          awayScore: match.score?.fullTime?.away ?? null,
          competitionName: match.competition?.name || match.competition?.code || null,
        }));
      } catch (err) {
        headToHeadError = err;
      }
      if (matches.length) return matches;
      if (!homeTeamProviderId || !awayTeamProviderId) {
        if (headToHeadError) throw headToHeadError;
        return matches;
      }
      try {
        return await this.#intersectTeamMatches(homeTeamProviderId, awayTeamProviderId);
      } catch (fallbackError) {
        if (!headToHeadError) throw fallbackError;
        throw new Error(
          `football-data.org head2head request failed (${headToHeadError.message}); team-history fallback failed (${fallbackError.message}).`,
          { cause: fallbackError },
        );
      }
    })().catch((err) => {
      if (this.headToHeadCache.get(key) === entry) this.headToHeadCache.delete(key);
      throw err;
    });
    this.headToHeadCache.set(key, entry);
    if (this.headToHeadCache.size > 100) this.headToHeadCache.delete(this.headToHeadCache.keys().next().value);
    return entry.promise;
  }

  async #intersectTeamMatches(homeTeamProviderId, awayTeamProviderId) {
    const [homeMatches, awayMatches] = await Promise.all([
      this.#getTeamMatches(homeTeamProviderId),
      this.#getTeamMatches(awayTeamProviderId),
    ]);
    const awayMatchIds = new Set(awayMatches.map((match) => match.providerId));
    return homeMatches
      .filter((match) => awayMatchIds.has(match.providerId)
        && [String(match.homeTeam?.providerId), String(match.awayTeam?.providerId)].includes(String(homeTeamProviderId))
        && [String(match.homeTeam?.providerId), String(match.awayTeam?.providerId)].includes(String(awayTeamProviderId)))
      .sort((a, b) => new Date(b.kickoffAt) - new Date(a.kickoffAt))
      .slice(0, 10);
  }
}
