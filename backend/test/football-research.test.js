import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rivalis_test';
process.env.FOOTBALL_PROVIDER = 'mock';
const { migrate } = await import('../scripts/migrate.js');
const { seed } = await import('../scripts/seed.js');
const { createApp } = await import('../src/app.js');
const { pool, query, queryOne } = await import('../src/db.js');
const { getFootballProvider } = await import('../src/football/providerRegistry.js');
const { clearResearchCache, summarizeResearch } = await import('../src/football/footballResearchService.js');
const { FootballDataOrgProvider } = await import('../src/football/providers/footballDataOrgProvider.js');
const request = (await import('supertest')).default;
const api = () => request(createApp());
const provider = getFootballProvider();
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let compId, otherComp, teamA, teamB, firstFixture;
let fixtureNumber = 0;

async function insertTeam(name, shortName, providerId) {
  const result = await query("INSERT INTO football_teams (provider, provider_team_id, name, short_name) VALUES ('mock', ?, ?, ?)", [providerId, name, shortName]);
  return { id: result.insertId, providerId, name, shortName };
}
async function fixture({ home = teamA, away = teamB, days = 1, competitionId = compId, status = 'FINISHED', homeScore = 2, awayScore = 0, eligible = true } = {}) {
  const inserted = await query(`INSERT INTO football_fixtures
    (provider, provider_fixture_id, competition_id, home_team_id, away_team_id, kickoff_at, status, home_score, away_score, is_simulated, research_eligible, last_synced_at, score_duration)
    VALUES ('mock', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), 'REGULAR')`,
  [`research-${++fixtureNumber}`, competitionId, home.id, away.id, new Date(originalNow() - days * 86400000), status, homeScore, awayScore, eligible ? 1 : 0]);
  return inserted.insertId;
}
const compare = (extra = {}) => api().get('/api/football/research').query({ teamA: teamA.id, teamB: teamB.id, competitionId: compId, ...extra });

before(async () => {
  await migrate({ fresh: true, log: () => {} });
  await seed({ log: () => {} });
  compId = (await queryOne("SELECT id FROM football_competitions WHERE code = 'PL'")).id;
  const other = await query("INSERT INTO football_competitions (provider, provider_competition_id, code, name, is_enabled) VALUES ('mock', 'research-other', 'RO', 'Research Other League', 1)");
  otherComp = other.insertId;
  teamA = await insertTeam('Research United', 'R United', 'research-a');
  teamB = await insertTeam('Research City', 'R City', 'research-b');
  firstFixture = await fixture({ days: 20 });
  await fixture({ home: teamB, away: teamA, days: 10, homeScore: 3, awayScore: 1 });
  await fixture({ days: 5, homeScore: 1, awayScore: 1 });
  await fixture({ days: 2, homeScore: null, awayScore: 2 });
  await fixture({ home: teamB, away: teamA, eligible: false, days: 1, homeScore: 3 });
  await fixture({ days: 8, status: 'CANCELLED', homeScore: 7 });
  await fixture({ days: 3, competitionId: otherComp, homeScore: 4 });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  delete provider.getTeamMatches;
  delete provider.getTeamMatchesSnapshot;
  delete provider.getHeadToHead;
  delete provider.getCompetitionStandings;
  clearResearchCache();
});
after(async () => pool.end());

test('research compares completed results without requiring an upcoming fixture', async () => {
  const res = await compare();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.teamA.id, teamA.id);
  assert.equal(res.body.headToHead.summary.played, 3);
  assert.deepEqual([res.body.headToHead.summary.wins, res.body.headToHead.summary.draws, res.body.headToHead.summary.losses], [1, 1, 1]);
  assert.equal(res.body.metadata.providerStatus, 'STORED');
  assert.equal(res.body.metadata.source, 'SYNCED');
  assert.equal(res.body.metadata.isSimulated, true);
  assert.match(res.body.metadata.notice, /not a complete all-time record/);
  assert.equal(res.body.headToHead.matches.length, 3);
  const upcoming = await api().get('/api/football/fixtures').query({ status: 'upcoming', teamId: teamA.id });
  assert.equal(upcoming.body.total, 0);
});

test('team orientation, venues and metric denominators exclude missing goals and awarded results', async () => {
  const res = (await compare()).body;
  const summary = res.headToHead.summary;
  assert.equal(summary.goalsFor, 4);
  assert.equal(summary.goalsAgainst, 4);
  assert.equal(summary.averageGoals, 2.67);
  assert.equal(summary.bothTeamsScoredPct, 67);
  assert.equal(summary.over25Pct, 33);
  assert.equal(summary.cleanSheetsPct, 33);
  assert.equal(res.headToHead.excludedUnverified, 2);
  assert.equal(res.headToHead.byVenue.home.played, 2);
  assert.equal(res.headToHead.byVenue.away.losses, 1);
  assert.equal(res.headToHead.matches.find(m => m.homeTeam.id === teamB.id).outcome, 'L');
  const reversed = (await compare({ teamA: teamB.id, teamB: teamA.id })).body;
  assert.equal(reversed.headToHead.matches.find(m => m.homeTeam.id === teamB.id).outcome, 'W');
  assert.equal(reversed.headToHead.byVenue.home.wins, 1);
  assert.equal(res.metadata.scoreBasis, 'REGULATION');
});

test('venue, competition and inclusive date filters scope every sample before aggregation', async () => {
  const home = (await compare({ venue: 'home' })).body;
  assert.equal(home.headToHead.summary.played, 2);
  assert.ok(home.headToHead.matches.every(m => m.teamAVenue === 'HOME'));
  assert.ok(home.form.teamB.matches.every(m => m.venue === 'HOME'));
  const other = (await compare({ competitionId: otherComp })).body;
  assert.equal(other.headToHead.summary.played, 1);
  assert.equal(other.headToHead.summary.goalsFor, 4);
  const cutoff = new Date(originalNow() - 7 * 86400000).toISOString().slice(0, 10);
  const recent = (await compare({ dateFrom: cutoff })).body;
  assert.equal(recent.headToHead.summary.played, 1);
  assert.equal(recent.headToHead.summary.draws, 1);
  assert.equal(recent.headToHead.excludedUnverified, 2);
});

test('invalid team pairs, filters and calendar dates get actionable 400 responses', async () => {
  for (const q of [
    { teamB: teamA.id }, { venue: 'stadium' }, { teamA: 'abc' },
    { dateFrom: '2026-02-30' }, { dateFrom: '2026-10-13', dateTo: '2026-01-01' },
    { dateFrom: '2000-01-01', dateTo: '2026-10-13' },
  ]) assert.equal((await compare(q)).status, 400);
  assert.equal((await compare({ teamA: 999999 })).status, 404);
  assert.equal((await compare({ competitionId: 999999 })).status, 404);
});

test('team and fixture searches use literal wildcard characters and stable pagination, without provider calls', async () => {
  let calls = 0;
  provider.getTeamMatches = async () => { calls++; return []; };
  const literal = await insertTeam('100% Club', 'A_B Club', 'percent-club');
  await fixture({ home: literal });
  const teams = await api().get('/api/football/teams').query({ q: 'Research', limit: 1 });
  assert.equal(teams.status, 200);
  assert.equal(teams.body.total, 2);
  assert.equal(teams.body.teams.length, 1);
  assert.equal(teams.body.teams[0].competitions[0].id, compId);
  assert.equal((await api().get('/api/football/teams').query({ q: '%' })).body.total, 1);
  assert.equal((await api().get('/api/football/teams').query({ q: '_' })).body.total, 1);
  const queried = await api().get('/api/football/fixtures').query({ q: 'Research United', status: 'all', pageSize: 2 });
  assert.equal(queried.status, 200, JSON.stringify(queried.body));
  assert.equal(queried.body.total, 7);
  assert.ok(queried.body.fixtures.every(f => [f.homeTeam.id, f.awayTeam.id].includes(teamA.id)));
  const pages = await Promise.all([1, 2].map(page => api().get('/api/football/fixtures').query({ q: 'Research United', status: 'all', pageSize: 2, page })));
  assert.equal(new Set(pages.flatMap(p => p.body.fixtures.map(f => f.id))).size, 4);
  assert.equal((await api().get('/api/football/fixtures').query({ q: '%', status: 'all' })).body.total, 1);
  const natural = await api().get('/api/football/fixtures').query({ q: 'Research United vs Research City', status: 'all' });
  assert.equal(natural.body.total, 7);
  const reversed = await api().get('/api/football/fixtures').query({ q: 'Research City Research United', status: 'all' });
  assert.deepEqual(reversed.body.fixtures.map(f => f.id), natural.body.fixtures.map(f => f.id));
  assert.equal((await api().get('/api/football/fixtures').query({ q: 'Research United Manchester', status: 'all' })).body.total, 0);
  assert.equal(calls, 0);
});

test('concurrent and reversed research reads only stored scores despite an available network provider', async () => {
  let calls = 0;
  provider.getTeamMatches = async () => { calls++; throw new Error('Page requests must not fetch external history'); };
  const responses = await Promise.all([compare(), compare(), compare({teamA:teamB.id,teamB:teamA.id}),compare({venue:'home'})]);
  assert.ok(responses.every(r=>r.status===200)); assert.equal(calls,0);
  assert.equal(responses[0].body.headToHead.summary.played,3);
  assert.deepEqual(responses[0].body.headToHead.matches.map(m=>m.id),responses[1].body.headToHead.matches.map(m=>m.id));
});

test('network outages cannot change stored research and sample controls are validated', async () => {
  provider.getTeamMatches=async()=>{throw new Error('Source unavailable');};
  globalThis.fetch=async()=>{throw new Error('No network allowed');};
  const result=await compare({form:5,meetings:'5'});assert.equal(result.status,200);
  assert.equal(result.body.filters.form,5);assert.equal(result.body.metadata.providerStatus,'STORED');
  assert.equal(result.body.headToHead.summary.played,3);
  for(const q of [{form:7},{meetings:'100'},{page:0},{season:'bad'}])assert.equal((await compare(q)).status,400);
});
test('a lite fixture reads scores and challenge rules without triggering any history or standings calls', async () => {
  let calls = 0;
  const never = async () => { calls++; throw new Error('Should not load insights'); };
  provider.getTeamMatches = never; provider.getHeadToHead = never; provider.getCompetitionStandings = never;
  const res = await api().get(`/api/football/fixtures/${firstFixture}`).query({ insights: 'none' });
  assert.equal(res.status, 200);
  assert.equal(res.body.fixture.homeScore, 2);
  assert.equal(res.body.fixture.headToHead, null);
  assert.ok(res.body.fixture.challengeTypes.length);
  assert.equal(calls, 0);
});

test('aggregate helper never converts unknown or invalid scores into scoreless draws', () => {
  const summary = summarizeResearch([{ teamScore: null, opponentScore: null }, { teamScore: '0', opponentScore: 0 }, { teamScore: -1, opponentScore: 2 }, { teamScore: 0, opponentScore: 0 }]);
  assert.equal(summary.played, 1);
  assert.equal(summary.draws, 1);
  assert.equal(summary.cleanSheetsPct, 100);
  assert.equal(summarizeResearch([]).bothTeamsScoredPct, null);
});

test('football-data research snapshots retain fetched time, awarded flags and explicitly supplied regulation scores', async () => {
  let calls = 0;
  let requestedUrl;
  const raw = {
    id: 1234, status: 'FINISHED', utcDate: '2026-01-01T12:00:00Z', competition: { code: 'PL', name: 'Premier League' },
    homeTeam: { id: 1, name: 'Home' }, awayTeam: { id: 2, name: 'Away' },
    score: { duration: 'EXTRA_TIME', regularTime: { home: 1, away: 1 }, fullTime: { home: 2, away: 1 } },
  };
  globalThis.fetch = async url => { requestedUrl = new URL(url); calls++; return { ok: true, json: async () => ({ matches: [raw, { ...raw, id: 1235, status: 'AWARDED' }, { ...raw, id: 1236, score: { duration: 'REGULAR', fullTime: { home: null, away: null }, halfTime: { home: 0, away: 0 } } }] }) }; };
  const realProvider = new FootballDataOrgProvider({ apiKey: 'test', baseUrl: 'https://provider.example' });
  const [a, b] = await Promise.all([realProvider.getTeamMatchesSnapshot('1'), realProvider.getTeamMatchesSnapshot('1')]);
  assert.equal(calls, 1);
  assert.equal(requestedUrl.searchParams.get('limit'), '500');
  assert.equal((new Date(requestedUrl.searchParams.get('dateTo')) - new Date(requestedUrl.searchParams.get('dateFrom'))) / 86400000, 749, 'History crosses seasons within the provider date-range limit');
  assert.equal(a.fetchedAt, b.fetchedAt);
  assert.ok(a.fetchedAt);
  assert.equal(a.matches[0].homeScore, 1);
  assert.equal(a.matches[0].scoreBasis, 'REGULATION');
  assert.equal(a.matches[0].scoreDuration, 'EXTRA_TIME');
  assert.equal(a.matches[1].researchEligible, false);
  assert.equal(a.matches[2].researchEligible, false);
  assert.equal(a.matches[2].homeScore, null, 'Half-time fallback is never research evidence for a completed match');
});
