import { FootballDataProvider } from './provider.js';

const API_BASE = 'https://api.sportmonks.com/v3/football';
const INCLUDE = 'participants;scores;state;league;events.type;statistics.type;ballCoordinates';
const COMPETITIONS = [
  { providerId: '172', code: 'SM172', name: 'Danish Superliga', country: 'Denmark', emblemUrl: null },
  { providerId: '501', code: 'SM501', name: 'Scottish Premiership', country: 'Scotland', emblemUrl: null },
];
const COMPETITION_BY_ID = new Map(COMPETITIONS.map((competition) => [competition.providerId, competition]));

const STATUS_BY_CODE = new Map([
  ['NS', 'SCHEDULED'], ['TBD', 'SCHEDULED'], ['LIVE', 'LIVE'], ['1H', 'LIVE'], ['2H', 'LIVE'],
  ['HT', 'LIVE'], ['ET', 'LIVE'], ['BT', 'LIVE'], ['P', 'LIVE'], ['INT', 'LIVE'],
  ['FT', 'FINISHED'], ['AET', 'FINISHED'], ['FT_PEN', 'FINISHED'], ['PEN', 'FINISHED'],
  ['POSTP', 'POSTPONED'], ['SUSP', 'POSTPONED'], ['CANC', 'CANCELLED'], ['ABD', 'ABANDONED'],
  ['FIRST_HALF', 'LIVE'], ['SECOND_HALF', 'LIVE'], ['HALF_TIME', 'LIVE'], ['EXTRA_TIME', 'LIVE'],
  ['AFTER_EXTRA_TIME', 'FINISHED'], ['AFTER_PENALTIES', 'FINISHED'], ['FULL_TIME', 'FINISHED'],
  ['NOT_STARTED', 'SCHEDULED'], ['SUSPENDED', 'POSTPONED'], ['CANCELLED', 'CANCELLED'],
  ['ABANDONED', 'ABANDONED'], ['POSTPONED', 'POSTPONED'], ['DELAYED', 'SCHEDULED'],
]);

const text = (value) => (typeof value === 'string' ? value : '');
const normalizeStatName = (value) => text(value).toLowerCase().replace(/[\s_-]+/g, '');
const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function mapStatus(state) {
  const code = text(state?.short_name || state?.developer_name || state?.name).toUpperCase().replaceAll(' ', '_');
  if (STATUS_BY_CODE.has(code)) return STATUS_BY_CODE.get(code);
  if (code.includes('POSTP')) return 'POSTPONED';
  if (code.includes('CANCEL')) return 'CANCELLED';
  if (code.includes('ABANDON')) return 'ABANDONED';
  if (code.includes('FINISH') || code.includes('FULL_TIME')) return 'FINISHED';
  if (code.includes('NOT_STARTED') || code.includes('SCHEDULED')) return 'SCHEDULED';
  if (code.includes('HALF') || code.includes('EXTRA_TIME') || code.includes('PENALT')) return 'LIVE';
  throw new Error(`Sportmonks returned an unsupported fixture state: ${code || 'missing'}.`);
}

function mapEvent(event, participants) {
  const participantId = String(event.participant_id ?? '');
  const homeId = String(participants.home?.providerId ?? '');
  const awayId = String(participants.away?.providerId ?? '');
  if (participantId !== homeId && participantId !== awayId) return null;
  const rawType = text(event.type?.name || event.type?.developer_name).toUpperCase().replaceAll(' ', '_');
  const type = rawType.includes('GOAL')
    ? 'GOAL'
    : rawType.includes('YELLOW') && rawType.includes('RED')
      ? 'RED_CARD'
      : rawType.includes('YELLOW')
        ? 'YELLOW_CARD'
        : rawType.includes('RED')
          ? 'RED_CARD'
          : rawType.includes('SUBSTITUTION')
            ? 'SUBSTITUTION'
            : 'OTHER';
  const playerName = text(event.player_name || event.player?.display_name || event.player?.name) || null;
  const relatedPlayer = text(event.related_player_name || event.relatedplayer?.display_name || event.relatedplayer?.name);
  const info = text(event.info || event.result);
  const detail = [info, relatedPlayer && type === 'SUBSTITUTION' ? `for ${relatedPlayer}` : ''].filter(Boolean).join(' · ') || null;
  const minute = numberOrNull(event.minute);
  const extra = numberOrNull(event.extra_minute);
  return {
    providerEventId: String(event.id),
    minute: minute === null ? null : minute + (extra || 0),
    sortOrder: numberOrNull(event.sort_order) ?? 0,
    type,
    team: participantId === homeId ? 'HOME' : 'AWAY',
    playerName,
    detail,
  };
}

function mapFixture(fixture) {
  const rawParticipants = fixture.participants || [];
  const homeRaw = rawParticipants.find((participant) => participant.meta?.location === 'home')
    || rawParticipants.find((participant) => participant.location === 'home');
  const awayRaw = rawParticipants.find((participant) => participant.meta?.location === 'away')
    || rawParticipants.find((participant) => participant.location === 'away');
  if (!fixture.id || !homeRaw?.id || !awayRaw?.id || !fixture.starting_at) {
    throw new Error(`Sportmonks fixture ${fixture.id ?? 'unknown'} is missing required match fields.`);
  }

  const team = (participant) => ({
    providerId: String(participant.id),
    name: participant.name,
    shortName: participant.short_code || participant.name,
    crestUrl: participant.image_path || null,
  });
  const homeTeam = team(homeRaw);
  const awayTeam = team(awayRaw);
  const participants = { home: homeTeam, away: awayTeam };
  const score = (location) => {
    const current = (fixture.scores || []).find((item) => item.description === 'CURRENT'
      && item.score?.participant === location);
    return numberOrNull(current?.score?.goals);
  };
  const stats = {};
  const statValues = {
    homeShots: ['total shots', 'shots total', 'shots'],
    awayShots: ['total shots', 'shots total', 'shots'],
    homeShotsOnTarget: ['shots on target', 'shots on goal'],
    awayShotsOnTarget: ['shots on target', 'shots on goal'],
    homePossession: ['ball possession', 'possession'],
    awayPossession: ['ball possession', 'possession'],
    homeCorners: ['corner kicks', 'corners'],
    awayCorners: ['corner kicks', 'corners'],
    homeCards: ['yellow cards', 'red cards'],
    awayCards: ['yellow cards', 'red cards'],
  };
  for (const [field, acceptedNames] of Object.entries(statValues)) {
    const location = field.startsWith('home') ? 'home' : 'away';
    const participantId = location === 'home' ? homeTeam.providerId : awayTeam.providerId;
    const names = new Set(acceptedNames.map(normalizeStatName));
    const rows = (fixture.statistics || []).filter((stat) => names.has(
      normalizeStatName(stat.type?.name || stat.type?.developer_name),
    ) && String(stat.participant_id) === participantId);
    if (field.endsWith('Cards')) {
      const unique = new Map(rows.map((stat) => [
        normalizeStatName(stat.type?.name || stat.type?.developer_name),
        numberOrNull(stat.data?.value ?? stat.value),
      ]));
      if (unique.size) stats[field] = [...unique.values()].reduce((sum, value) => sum + (value ?? 0), 0);
    } else if (rows.length) {
      stats[field] = numberOrNull(rows[0].data?.value ?? rows[0].value);
    }
  }

  const events = (fixture.events || [])
    .map((event) => mapEvent(event, participants))
    .filter(Boolean)
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.minute ?? 0) - (b.minute ?? 0));
  const firstGoal = events.find((event) => event.type === 'GOAL');
  if (firstGoal) stats.firstGoalTeam = firstGoal.team;
  else if (mapStatus(fixture.state) === 'FINISHED'
    && score('home') === 0 && score('away') === 0) stats.firstGoalTeam = 'NONE';
  const coordinates = (fixture.ballcoordinates || fixture.ball_coordinates || [])
    .map((point) => ({
      providerEventId: String(point.id),
      timer: text(point.timer),
      x: numberOrNull(point.x),
      y: numberOrNull(point.y),
    }))
    .filter((point) => point.x !== null && point.y !== null)
    .map((point) => ({
      ...point,
      x: Math.min(1, Math.max(0, point.x)),
      y: Math.min(1, Math.max(0, point.y)),
    }))
    .sort((a, b) => {
      const seconds = (timer) => timer.split(':').reduce((total, part) => total * 60 + Number(part), 0);
      return seconds(a.timer) - seconds(b.timer);
    })
    .slice(-100);
  const state = fixture.state || {};
  const phase = text(state.name || state.short_name || state.developer_name) || null;
  const minute = numberOrNull(fixture.minute ?? fixture.state?.minute);
  const competitionId = String(fixture.league_id || fixture.league?.id || '');
  const competition = COMPETITION_BY_ID.get(competitionId);
  if (!competition) throw new Error(`Sportmonks returned unsupported free-plan league ${competitionId || 'unknown'}.`);

  return {
    providerId: String(fixture.id),
    competitionProviderId: competition.providerId,
    season: fixture.season?.name || null,
    homeTeam,
    awayTeam,
    kickoffAt: new Date(fixture.starting_at.replace(' ', 'T') + (fixture.starting_at.endsWith('Z') ? '' : 'Z')).toISOString(),
    status: mapStatus(state),
    phase,
    minute,
    homeScore: score('home'),
    awayScore: score('away'),
    statsAvailable: Object.keys(stats).some((field) => field !== 'firstGoalTeam'),
    stats,
    events,
    ballCoordinates: coordinates,
  };
}

export class SportmonksProvider extends FootballDataProvider {
  constructor({ apiKey }) {
    super();
    if (!apiKey) throw new Error('SPORTMONKS_API_KEY is required when FOOTBALL_PROVIDER=sportmonks.');
    this.apiKey = apiKey;
    this.cache = new Map();
  }

  get name() { return 'sportmonks'; }
  capabilities() { return { statistics: true, events: true }; }

  async #get(path, { cacheSeconds = 0 } = {}) {
    const cacheKey = path;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.data;
    if (cached) this.cache.delete(cacheKey);

    const url = new URL(`${API_BASE}${path}`);
    const response = await fetch(url, {
      headers: { Authorization: this.apiKey },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Sportmonks ${path} -> HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    const payload = await response.json();
    const hasErrors = Array.isArray(payload.errors)
      ? payload.errors.length > 0
      : payload.errors && Object.keys(payload.errors).length > 0;
    if (hasErrors) throw new Error(`Sportmonks ${path} returned API errors: ${JSON.stringify(payload.errors).slice(0, 200)}`);
    const data = payload.data;
    if (cacheSeconds > 0) this.cache.set(cacheKey, { data, expiresAt: Date.now() + cacheSeconds * 1000 });
    return data;
  }

  async listCompetitions() {
    return COMPETITIONS.map((competition) => ({ ...competition }));
  }

  async listUpcomingFixtures(competitionCode, fromIso, toIso) {
    const competition = COMPETITIONS.find((item) => item.code === competitionCode);
    if (!competition) return [];
    const start = fromIso.slice(0, 10);
    const end = toIso.slice(0, 10);
    const fixtures = await this.#get(
      `/fixtures/between/${start}/${end}?filters=fixtureLeagues:${competition.providerId}&include=participants;scores;state;league`,
      { cacheSeconds: 45 },
    );
    if (!Array.isArray(fixtures)) throw new Error('Sportmonks fixture range response did not contain a fixture list.');
    return fixtures.map(mapFixture);
  }

  async getLiveFixtures() {
    let fixtures;
    try {
      fixtures = await this.#get(
        `/livescores/inplay?filters=fixtureLeagues:172,501&include=${INCLUDE}`,
        { cacheSeconds: 20 },
      );
    } catch (err) {
      if (!String(err.message).includes('HTTP 400') && !String(err.message).includes('HTTP 403')) throw err;
      fixtures = await this.#get(
        `/livescores/inplay?filters=fixtureLeagues:172,501&include=participants;scores;state;league;events.type;statistics.type`,
        { cacheSeconds: 20 },
      );
    }
    if (!Array.isArray(fixtures)) throw new Error('Sportmonks in-play response did not contain a fixture list.');
    return fixtures.map(mapFixture);
  }

  async getFixture(providerFixtureId) {
    let fixture;
    try {
      fixture = await this.#get(`/fixtures/${encodeURIComponent(providerFixtureId)}?include=${INCLUDE}`);
    } catch (err) {
      if (!String(err.message).includes('HTTP 400') && !String(err.message).includes('HTTP 403')) throw err;
      fixture = await this.#get(`/fixtures/${encodeURIComponent(providerFixtureId)}?include=participants;scores;state;league;events.type;statistics.type`);
    }
    if (!fixture) return null;
    return mapFixture(fixture);
  }
}
