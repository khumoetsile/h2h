// Football category: fixtures, direct/matchmaking challenges, and every
// settlement outcome (win / draw / cancelled / void / unresolved-timeout),
// exercised the same way as the skill-game suite — real MySQL, real HTTP.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rivalis_test';
process.env.PUBLIC_BASE_URL = 'https://football.example.test';

const { migrate } = await import('../scripts/migrate.js');
const { seed } = await import('../scripts/seed.js');
const { createApp } = await import('../src/app.js');
const { pool, query, queryOne } = await import('../src/db.js');
const { settleMatchesForFixture, voidMatchesForFixture, settleFootballMatch } = await import('../src/football/footballSettlementService.js');
const { voidUnresolvedFixtures } = await import('../src/football/footballSyncService.js');
const { MockFootballProvider } = await import('../src/football/providers/mockProvider.js');
const { FootballDataOrgProvider } = await import('../src/football/providers/footballDataOrgProvider.js');
const request = (await import('supertest')).default;

const app = createApp();
const api = () => request(app);
const quiet = () => {};

async function login(identifier, password = 'Player123!') {
  const res = await api().post('/api/auth/login').send({ identifier, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

let n = 0;
async function newPlayer(prefix = 'fx') {
  n += 1;
  const u = `${prefix}${Date.now().toString(36)}${n}`.slice(0, 20);
  const res = await api().post('/api/auth/register').send({
    firstName: 'Test', lastName: 'Player', username: u, email: `${u}@test.dev`, phone: '+267 71 234 567',
    password: 'Secret123', confirmPassword: 'Secret123',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { token: res.body.token, user: res.body.user };
}
async function wallet(token) {
  return (await api().get('/api/wallet').set(auth(token))).body.wallet;
}
let compId, homeId, awayId;
before(async () => {
  await migrate({ fresh: true, log: quiet });
  await seed({ log: quiet });
  compId = (await queryOne("SELECT id FROM football_competitions WHERE code = 'PL'")).id;
  homeId = (await queryOne("SELECT id FROM football_teams WHERE name = 'Arsenal'")).id;
  awayId = (await queryOne("SELECT id FROM football_teams WHERE name = 'Chelsea'")).id;
});
after(async () => { await pool.end(); });

let fixtureSeq = 100;
/** Insert a fixture directly (bypassing the provider) so tests control the exact result/timing. */
async function makeFixture({ status = 'SCHEDULED', kickoffMs = 60 * 60 * 1000, homeScore = null, awayScore = null, homeShots = null, awayShots = null, homeCorners = null, awayCorners = null, homeCards = null, awayCards = null, firstGoalTeam = null, statsAvailable = 0 } = {}) {
  fixtureSeq += 1;
  const res = await query(
    `INSERT INTO football_fixtures
       (provider, provider_fixture_id, competition_id, season, home_team_id, away_team_id, kickoff_at, status,
        home_score, away_score, home_shots, away_shots, home_corners, away_corners, home_cards, away_cards, first_goal_team, stats_available, is_simulated)
     VALUES ('mock', ?, ?, '2026', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [`test-fx-${fixtureSeq}`, compId, homeId, awayId, new Date(Date.now() + kickoffMs), status, homeScore, awayScore, homeShots, awayShots, homeCorners, awayCorners, homeCards, awayCards, firstGoalTeam, statsAvailable],
  );
  return res.insertId;
}

describe('football: browsing', () => {
  test('competitions, challenge types and fixtures are listed', async () => {
    const t = await login('player');
    const comps = await api().get('/api/football/competitions').set(auth(t));
    assert.ok(comps.body.competitions.some((c) => c.code === 'PL'));
    const types = await api().get('/api/football/challenge-types').set(auth(t));
    assert.ok(types.body.challengeTypes.some((x) => x.slug === 'match_winner'));
    const fixtures = await api().get('/api/football/fixtures?status=upcoming').set(auth(t));
    assert.ok(fixtures.body.fixtures.length > 0);
    const detail = await api().get(`/api/football/fixtures/${fixtures.body.fixtures[0].id}`).set(auth(t));
    assert.ok(detail.body.fixture.challengeTypes.some((x) => x.question.includes(' or ') || x.question.includes('Will')));
  });

  test('provider capabilities gate stats-dependent challenge types honestly', () => {
    const mock = new MockFootballProvider();
    assert.deepEqual(mock.capabilities(), { statistics: true, events: true });
    const real = new FootballDataOrgProvider({ apiKey: '', baseUrl: 'https://api.football-data.org/v4' });
    assert.deepEqual(real.capabilities(), { statistics: false, events: false });
  });

  test('football-data provider maps and briefly caches historical head-to-head matches', async () => {
    const provider = new FootballDataOrgProvider({ apiKey: '', baseUrl: 'https://football.example.test/v4' });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls += 1;
      assert.equal(url, 'https://football.example.test/v4/matches/123/head2head?limit=10');
      return {
        ok: true,
        json: async () => ({
          matches: [{
            id: 456,
            status: 'FINISHED',
            utcDate: '2025-02-01T15:00:00Z',
            competition: { code: 'PL', name: 'Premier League' },
            homeTeam: { id: 10, name: 'Liverpool', tla: 'LIV' },
            awayTeam: { id: 20, name: 'Chelsea', tla: 'CHE' },
            venue: 'Anfield',
            score: { fullTime: { home: 2, away: 1 }, halfTime: { home: 1, away: 1 } },
          }],
        }),
      };
    };
    try {
      const [first, second] = await Promise.all([
        provider.getHeadToHead('123'),
        provider.getHeadToHead('123'),
      ]);
      assert.equal(calls, 1, 'simultaneous match-centre loads share the provider request');
      assert.deepEqual(first, second);
      assert.equal(first[0].providerId, '456');
      assert.equal(first[0].competitionName, 'Premier League');
      assert.equal(first[0].homeTeam.name, 'Liverpool');
      assert.equal(first[0].awayTeam.name, 'Chelsea');
      assert.equal(first[0].homeScore, 2);
      assert.equal(first[0].awayScore, 1);
      assert.equal(first[0].venue, 'Anfield');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('football-data provider maps and caches competition standings', async () => {
    const provider = new FootballDataOrgProvider({ apiKey: '', baseUrl: 'https://football.example.test/v4' });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls += 1;
      assert.equal(url, 'https://football.example.test/v4/competitions/PL/standings');
      return {
        ok: true,
        json: async () => ({
          standings: [{
            type: 'TOTAL',
            table: [{
              position: 1,
              playedGames: 30,
              won: 22,
              draw: 5,
              lost: 3,
              goalsFor: 70,
              goalsAgainst: 25,
              goalDifference: 45,
              points: 71,
              team: { id: 64, name: 'Liverpool FC', shortName: 'Liverpool' },
            }],
          }],
        }),
      };
    };
    try {
      const [first, second] = await Promise.all([
        provider.getCompetitionStandings('PL'),
        provider.getCompetitionStandings('PL'),
      ]);
      assert.equal(calls, 1, 'simultaneous match-centre loads share the standings request');
      assert.deepEqual(first, second);
      assert.deepEqual(first[0], {
        teamProviderId: '64',
        teamName: 'Liverpool',
        position: 1,
        played: 30,
        won: 22,
        drawn: 5,
        lost: 3,
        goalsFor: 70,
        goalsAgainst: 25,
        goalDifference: 45,
        points: 71,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('football-data historical results require a full-time score', async () => {
    const provider = new FootballDataOrgProvider({ apiKey: '', baseUrl: 'https://football.example.test/v4' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        matches: [{
          id: 456,
          status: 'FINISHED',
          utcDate: '2025-02-01T15:00:00Z',
          competition: { code: 'PL', name: 'Premier League' },
          homeTeam: { id: 10, name: 'Liverpool' },
          awayTeam: { id: 20, name: 'Chelsea' },
          score: { halfTime: { home: 1, away: 0 }, fullTime: { home: null, away: null } },
        }],
      }),
    });
    try {
      const [match] = await provider.getHeadToHead('123', '10', '20');
      assert.equal(match.status, 'FINISHED');
      assert.equal(match.homeScore, null);
      assert.equal(match.awayScore, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('football-data provider finds past meetings from team histories when head-to-head is unavailable', async () => {
    const provider = new FootballDataOrgProvider({ apiKey: '', baseUrl: 'https://football.example.test/v4' });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const meeting = {
      id: 456,
      status: 'FINISHED',
      utcDate: '2025-02-01T15:00:00Z',
      competition: { code: 'SA', name: 'Serie A' },
      homeTeam: { id: 10, name: 'Como 1907', tla: 'COM' },
      awayTeam: { id: 20, name: 'AS Roma', tla: 'ROM' },
      venue: 'Stadio Olimpico',
      score: { fullTime: { home: 2, away: 1 } },
    };
    globalThis.fetch = async (url) => {
      calls += 1;
      if (url.endsWith('/matches/123/head2head?limit=10')) {
        return { ok: false, status: 403, text: async () => 'head2head unavailable on plan' };
      }
      if (url.endsWith('/teams/10/matches?status=FINISHED&limit=500')) {
        return { ok: true, json: async () => ({ matches: [meeting] }) };
      }
      if (url.endsWith('/teams/20/matches?status=FINISHED&limit=500')) {
        return { ok: true, json: async () => ({ matches: [meeting] }) };
      }
      throw new Error(`Unexpected football-data URL: ${url}`);
    };
    try {
      const [first, second] = await Promise.all([
        provider.getHeadToHead('123', '10', '20'),
        provider.getHeadToHead('123', '10', '20'),
      ]);
      assert.equal(calls, 3, 'failed H2H request and both team histories are shared by concurrent calls');
      assert.deepEqual(first, second);
      assert.equal(first.length, 1);
      assert.equal(first[0].providerId, '456');
      assert.equal(first[0].homeTeam.name, 'Como 1907');
      assert.equal(first[0].awayTeam.name, 'AS Roma');
      assert.equal(first[0].homeScore, 2);
      assert.equal(first[0].awayScore, 1);
      assert.equal(first[0].venue, 'Stadio Olimpico');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('football-data provider broadens head-to-head results with team histories', async () => {
    const provider = new FootballDataOrgProvider({ apiKey: '', baseUrl: 'https://football.example.test/v4' });
    const originalFetch = globalThis.fetch;
    const recentMeeting = {
      id: 789,
      status: 'FINISHED',
      utcDate: '2025-02-01T14:00:00Z',
      competition: { code: 'SA', name: 'Serie A' },
      homeTeam: { id: 10, name: 'Como 1907' },
      awayTeam: { id: 20, name: 'AS Roma' },
      score: { fullTime: { home: 1, away: 1 } },
    };
    const olderMeeting = {
      id: 788,
      status: 'FINISHED',
      utcDate: '2024-11-24T14:00:00Z',
      competition: { code: 'SA', name: 'Serie A' },
      homeTeam: { id: 20, name: 'AS Roma' },
      awayTeam: { id: 10, name: 'Como 1907' },
      score: { fullTime: { home: 2, away: 0 } },
    };
    globalThis.fetch = async (url) => {
      if (url.endsWith('/matches/123/head2head?limit=10')) {
        return { ok: true, json: async () => ({ matches: [recentMeeting] }) };
      }
      if (url.includes('/teams/10/matches?') || url.includes('/teams/20/matches?')) {
        return { ok: true, json: async () => ({ matches: [recentMeeting, olderMeeting] }) };
      }
      throw new Error(`Unexpected football-data URL: ${url}`);
    };
    try {
      const matches = await provider.getHeadToHead('123', '10', '20');
      assert.equal(matches.length, 2);
      assert.equal(matches[0].providerId, '789');
      assert.equal(matches[0].competitionName, 'Serie A');
      assert.equal(matches[1].providerId, '788');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('public visitors can browse fixtures, completed results and fixture details', async () => {
    const finishedId = await makeFixture({
      status: 'FINISHED', kickoffMs: -30 * 60 * 1000, homeScore: 2, awayScore: 1,
      homeShots: 8, awayShots: 4, statsAvailable: 1,
    });
    const comps = await api().get('/api/football/competitions');
    assert.equal(comps.status, 200);
    const fixtures = await api().get('/api/football/fixtures?status=upcoming&page=1&pageSize=10');
    assert.equal(fixtures.status, 200);
    assert.ok(Array.isArray(fixtures.body.fixtures));
    assert.equal(fixtures.body.page, 1);
    const results = await api().get('/api/football/fixtures?status=completed');
    assert.ok(results.body.fixtures.some((fx) => fx.id === finishedId));
    const detail = await api().get(`/api/football/fixtures/${finishedId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.fixture.stats.shots.home, 8);
    assert.equal(detail.body.fixture.stats.corners.home, null, 'unknown statistics stay unknown');
    assert.deepEqual(detail.body.openChallenges, []);
    assert.deepEqual(detail.body.fixture.reactions, {
      counts: { FIRE: 0, SHOCK: 0, GOAL: 0 },
      mine: null,
    });
    assert.equal(detail.body.fixture.headToHead.status, 'AVAILABLE');
    assert.equal(detail.body.fixture.headToHead.source, 'SYNCED');
    assert.ok(detail.body.fixture.headToHead.matches.some((meeting) => meeting.homeTeam === 'Arsenal' && meeting.awayTeam === 'Chelsea'));
    assert.deepEqual({
      homeWins: detail.body.fixture.headToHead.summary.homeWins,
      draws: detail.body.fixture.headToHead.summary.draws,
      awayWins: detail.body.fixture.headToHead.summary.awayWins,
    }, { homeWins: 1, draws: 0, awayWins: 0 });
    assert.equal(detail.body.fixture.headToHead.summary.averageGoals, 3);
    assert.equal(detail.body.fixture.headToHead.summary.goalsFor, 2);
    assert.equal(detail.body.fixture.headToHead.summary.goalsAgainst, 1);
    assert.equal(detail.body.fixture.headToHead.summary.bothTeamsScoredPct, 100);
    assert.equal(detail.body.fixture.headToHead.summary.over15, 1);
    assert.equal(detail.body.fixture.headToHead.summary.over15Pct, 100);
    assert.equal(detail.body.fixture.headToHead.summary.over25Pct, 100);
    assert.equal(detail.body.fixture.headToHead.summary.homeAtHome.played, 1);
    assert.ok(detail.body.fixture.headToHead.matches.every((meeting) => meeting.fixtureId));
    assert.equal(detail.body.fixture.headToHead.standings.status, 'UNSUPPORTED');
    assert.ok(detail.body.fixture.headToHead.summary.firstMeetingAt);
    assert.ok(detail.body.fixture.headToHead.summary.latestMeetingAt);
    assert.equal(detail.body.fixture.headToHead.summary.latestMeeting.homeScore, 2);
    assert.equal(detail.body.fixture.headToHead.summary.latestMeeting.awayScore, 1);
    assert.ok(detail.body.fixture.headToHead.recentForm.home.matches.some((match) => match.outcome === 'W'));
    assert.ok(detail.body.fixture.headToHead.recentForm.away.matches.some((match) => match.outcome === 'L'));
    assert.ok(detail.body.fixture.headToHead.recentForm.home.matches.every((match) => match.competition));
    const team = await api().get(`/api/football/teams/${homeId}`);
    assert.equal(team.status, 200);
    assert.equal(team.body.team.id, homeId);
    assert.ok(Array.isArray(team.body.recentResults));
  });

  test('head-to-head summaries include goal thresholds, team totals and latest meeting', async () => {
    const earlier = await makeFixture({
      status: 'FINISHED', kickoffMs: 86400000, homeScore: 0, awayScore: 0,
    });
    const latest = await makeFixture({
      status: 'FINISHED', kickoffMs: 2 * 86400000, homeScore: 1, awayScore: 1,
    });
    const upcoming = await makeFixture({ status: 'SCHEDULED', kickoffMs: 3 * 86400000 });
    const detail = await api().get(`/api/football/fixtures/${upcoming}`);
    assert.equal(detail.status, 200);
    const { headToHead } = detail.body.fixture;
    const totalGoals = headToHead.matches.map((match) => match.homeScore + match.awayScore);
    assert.equal(headToHead.summary.played, headToHead.matches.length);
    assert.equal(headToHead.summary.over15, totalGoals.filter((goals) => goals > 1).length);
    assert.equal(headToHead.summary.over25, totalGoals.filter((goals) => goals > 2).length);
    assert.equal(headToHead.summary.bothTeamsScored, headToHead.matches.filter((match) => match.homeScore > 0 && match.awayScore > 0).length);
    assert.equal(headToHead.summary.cleanSheets, headToHead.matches.filter((match) => match.homeTeam === 'Arsenal' ? match.awayScore === 0 : match.homeScore === 0).length);
    assert.equal(headToHead.summary.opponentCleanSheets, headToHead.matches.filter((match) => match.homeTeam === 'Arsenal' ? match.homeScore === 0 : match.awayScore === 0).length);
    assert.equal(headToHead.summary.averageGoals, Number((totalGoals.reduce((sum, goals) => sum + goals, 0) / totalGoals.length).toFixed(1)));
    assert.equal(headToHead.summary.latestMeeting.fixtureId, latest);
    assert.notEqual(headToHead.summary.latestMeeting.fixtureId, earlier);
    assert.deepEqual(headToHead.matches.slice(0, 2).map((match) => match.fixtureId), [latest, earlier]);
  });

  test('players can follow live fixtures and remove them from followed matches', async () => {
    const fixtureId = await makeFixture({ status: 'LIVE', kickoffMs: -10 * 60 * 1000 });
    const path = `/api/football/fixtures/${fixtureId}/follow`;
    assert.equal((await api().put(path).send({})).status, 401);
    const player = await newPlayer('follow');
    assert.equal((await api().put(path).set(auth(player.token)).send({})).status, 200);
    const followed = await api().get('/api/football/followed-fixtures').set(auth(player.token));
    assert.equal(followed.status, 200);
    assert.ok(followed.body.fixtures.some((fixture) => fixture.id === fixtureId && fixture.followed));
    const detail = await api().get(`/api/football/fixtures/${fixtureId}`).set(auth(player.token));
    assert.equal(detail.body.fixture.followed, true);
    assert.equal((await api().delete(path).set(auth(player.token))).status, 200);
    const afterUnfollow = await api().get('/api/football/followed-fixtures').set(auth(player.token));
    assert.equal(afterUnfollow.body.fixtures.some((fixture) => fixture.id === fixtureId), false);
  });

  test('fixture reactions are public to read, authenticated to set, and unique per player', async () => {
    const fixtureId = await makeFixture({ status: 'LIVE', kickoffMs: -10 * 60 * 1000 });
    const path = `/api/football/fixtures/${fixtureId}/reaction`;
    assert.equal((await api().put(path).send({ reaction: 'FIRE' })).status, 401);

    const player = await newPlayer('react');
    let res = await api().put(path).set(auth(player.token)).send({ reaction: 'FIRE' });
    assert.equal(res.status, 200);
    assert.equal(res.body.reactions.mine, 'FIRE');
    assert.equal(res.body.reactions.counts.FIRE, 1);

    res = await api().put(path).set(auth(player.token)).send({ reaction: 'GOAL' });
    assert.equal(res.status, 200);
    assert.equal(res.body.reactions.mine, 'GOAL');
    assert.equal(res.body.reactions.counts.FIRE, 0);
    assert.equal(res.body.reactions.counts.GOAL, 1);

    const publicDetail = await api().get(`/api/football/fixtures/${fixtureId}`);
    assert.equal(publicDetail.status, 200);
    assert.equal(publicDetail.body.fixture.reactions.counts.GOAL, 1);
    assert.equal(publicDetail.body.fixture.reactions.mine, null);
    const ownDetail = await api().get(`/api/football/fixtures/${fixtureId}`).set(auth(player.token));
    assert.equal(ownDetail.body.fixture.reactions.mine, 'GOAL');

    res = await api().put(path).set(auth(player.token)).send({ reaction: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.reactions.mine, null);
    assert.equal(res.body.reactions.counts.GOAL, 0);
    assert.equal((await api().put(path).set(auth(player.token)).send({ reaction: 'CLAP' })).status, 400);
  });

  test('public fixture filters validate date ranges and support team/competition filtering', async () => {
    const from = new Date().toISOString().slice(0, 10);
    const fixtures = await api().get(`/api/football/fixtures?dateFrom=${from}&dateTo=${from}&pageSize=5`);
    assert.equal(fixtures.status, 200);
    assert.ok(fixtures.body.fixtures.every((fx) => fx.kickoffAt.slice(0, 10) === from));
    const byCompetition = await api().get(`/api/football/fixtures?competitionId=${compId}`);
    assert.ok(byCompetition.body.fixtures.every((fx) => fx.competition.id === compId));
    const byTeam = await api().get(`/api/football/fixtures?teamId=${homeId}`);
    assert.ok(byTeam.body.fixtures.every((fx) => fx.homeTeam.id === homeId || fx.awayTeam.id === homeId));
    const badRange = await api().get('/api/football/fixtures?dateFrom=2026-10-10&dateTo=2026-09-01');
    assert.equal(badRange.status, 400);
    assert.equal((await api().get('/api/football/fixtures?dateFrom=2026-99-99')).status, 400);
    const badPage = await api().get('/api/football/fixtures?pageSize=101');
    assert.equal(badPage.status, 400);
  });

  test('football challenge mutations still require a player session', async () => {
    assert.equal((await api().post('/api/football/find').send({})).status, 401);
    assert.equal((await api().post('/api/football/challenges').send({})).status, 401);
    assert.equal((await api().get('/api/football/open-challenges')).status, 401);
  });

  test('robots and sitemap do not publish simulated fixture URLs', async () => {
    const robots = await api().get('/robots.txt');
    assert.equal(robots.status, 200);
    const sitemap = await api().get('/sitemap.xml');
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.text, /https:\/\/football\.example\.test\/football/);
    assert.doesNotMatch(sitemap.text, /\/football\/\d+/);
  });
});

describe('football: direct challenge -> settlement (WIN)', () => {
  test('correct pick wins the pool minus the platform fee; wrong pick loses the stake', async () => {
    const A = await newPlayer('winA');
    const B = await newPlayer('winB');
    const fixtureId = await makeFixture({ status: 'SCHEDULED', kickoffMs: 2000 });

    const create = await api().post('/api/football/challenges').set(auth(A.token)).send({
      opponent: B.user.username, fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 20,
    });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    assert.equal((await wallet(A.token)).locked, 0, 'no lock until accepted');

    const accept = await api().post(`/api/challenges/${create.body.challenge.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' });
    assert.equal(accept.status, 200, JSON.stringify(accept.body));
    assert.equal(accept.body.match.status, 'READY');
    assert.equal(accept.body.match.category, 'FOOTBALL');
    assert.equal(accept.body.match.football.creatorPick, 'HOME');
    assert.equal(accept.body.match.football.opponentPick, 'AWAY');
    assert.equal((await wallet(A.token)).locked, 20);
    assert.equal((await wallet(B.token)).locked, 20);

    // Kickoff passes -> the sweep-equivalent transition moves it to IN_PROGRESS.
    await query('UPDATE football_fixtures SET kickoff_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [fixtureId]);
    await query(`UPDATE matches m JOIN football_challenges fc ON fc.match_id = m.id SET m.status = 'IN_PROGRESS', m.started_at = NOW() WHERE fc.fixture_id = ? AND m.status = 'MATCHED'`, [fixtureId]);

    // Full time: Arsenal (HOME) win 2-1 — A picked HOME, so A wins.
    await query(`UPDATE football_fixtures SET status = 'FINISHED', home_score = 2, away_score = 1 WHERE id = ?`, [fixtureId]);
    const settled = await settleMatchesForFixture(fixtureId);
    assert.equal(settled, 1);

    const wa = await wallet(A.token);
    const wb = await wallet(B.token);
    assert.deepEqual([wa.available, wa.locked], [266, 0]); // 250 - 20 stake + 36 prize
    assert.deepEqual([wb.available, wb.locked], [230, 0]); // 250 - 20 stake

    const matchRow = await queryOne('SELECT * FROM matches WHERE id = ?', [accept.body.match.id]);
    assert.equal(matchRow.status, 'COMPLETED');
    assert.equal(matchRow.winner_id, A.user.id);
    const settlement = await queryOne('SELECT * FROM settlements WHERE match_id = ?', [accept.body.match.id]);
    assert.equal(settlement.outcome, 'WIN');
    assert.equal(Number(settlement.fee_amount), 4);
    assert.equal(Number(settlement.prize), 36);

    // Idempotent: settling again must not pay out twice.
    const again = await settleMatchesForFixture(fixtureId);
    assert.equal(again, 0);
    assert.equal((await wallet(A.token)).available, 266);
    assert.equal((await query('SELECT COUNT(*) AS c FROM settlements WHERE match_id = ?', [accept.body.match.id]))[0].c, 1);
  });

  test('cannot create or accept a challenge once the fixture has kicked off', async () => {
    const A = await newPlayer('lateA');
    const B = await newPlayer('lateB');
    const liveFixture = await makeFixture({ status: 'LIVE', kickoffMs: -600000 });
    const res = await api().post('/api/football/challenges').set(auth(A.token)).send({
      opponent: B.user.username, fixtureId: liveFixture, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 10,
    });
    assert.equal(res.body.error.code, 'CHALLENGE_CLOSED');

    // A challenge sent while still SCHEDULED, then kickoff arrives before the opponent responds.
    const soon = await makeFixture({ status: 'SCHEDULED', kickoffMs: 1500 });
    const created = await api().post('/api/football/challenges').set(auth(A.token)).send({
      opponent: B.user.username, fixtureId: soon, challengeTypeSlug: 'match_winner', pick: 'AWAY', stake: 10,
    });
    assert.equal(created.status, 201);
    await query('UPDATE football_fixtures SET kickoff_at = NOW() - INTERVAL 1 MINUTE, status = ? WHERE id = ?', ['LIVE', soon]);
    const lateAccept = await api().post(`/api/challenges/${created.body.challenge.id}/accept`).set(auth(B.token)).send({ pick: 'HOME' });
    assert.equal(lateAccept.body.error.code, 'CHALLENGE_CLOSED');
    assert.equal((await wallet(A.token)).locked, 0, 'rejected accept must not lock anything');
  });
});

describe('football: matchmaking with opposite picks', () => {
  test('two opposite picks on the same fixture/type/stake are matched instantly', async () => {
    const A = await newPlayer('mmA');
    const B = await newPlayer('mmB');
    const fixtureId = await makeFixture({ status: 'SCHEDULED', kickoffMs: 3600000 });
    const findA = await api().post('/api/football/find').set(auth(A.token)).send({ fixtureId, challengeTypeSlug: 'both_teams_score', pick: 'YES', stake: 10 });
    assert.equal(findA.status, 201);
    assert.equal(findA.body.match.status, 'WAITING');
    // Same pick does not match itself.
    const sameAgain = await api().post('/api/football/find').set(auth(A.token)).send({ fixtureId, challengeTypeSlug: 'both_teams_score', pick: 'YES', stake: 10 });
    assert.equal(sameAgain.body.alreadyQueued, true);
    const findB = await api().post('/api/football/find').set(auth(B.token)).send({ fixtureId, challengeTypeSlug: 'both_teams_score', pick: 'NO', stake: 10 });
    assert.equal(findB.status, 200);
    assert.equal(findB.body.matched, true);
    assert.equal(findB.body.match.id, findA.body.match.id);
    assert.equal((await wallet(A.token)).locked, 10);
    assert.equal((await wallet(B.token)).locked, 10);
  });
});

describe('football: draw (no winner => full refund, zero fee)', () => {
  test('match_winner: the real match itself ends level -> Head2Head draw', async () => {
    const A = await newPlayer('drawA');
    const B = await newPlayer('drawB');
    // Start the fixture SCHEDULED (so the challenge can be created/accepted), then reveal the level result at full time.
    const fixtureId = await makeFixture({ status: 'SCHEDULED', kickoffMs: 2000 });
    const created = await api().post('/api/football/challenges').set(auth(A.token)).send({ opponent: B.user.username, fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 20 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const accept = await api().post(`/api/challenges/${created.body.challenge.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' });
    assert.equal(accept.status, 200, JSON.stringify(accept.body));
    await query(`UPDATE football_fixtures SET status = 'FINISHED', home_score = 1, away_score = 1, kickoff_at = NOW() - INTERVAL 2 HOUR WHERE id = ?`, [fixtureId]);
    await settleMatchesForFixture(fixtureId);

    const wa = await wallet(A.token);
    const wb = await wallet(B.token);
    assert.deepEqual([wa.available, wa.locked], [250, 0]);
    assert.deepEqual([wb.available, wb.locked], [250, 0]);
    const settlement = await queryOne('SELECT * FROM settlements WHERE match_id = ?', [accept.body.match.id]);
    assert.equal(settlement.outcome, 'DRAW');
    assert.equal(Number(settlement.fee_amount), 0, 'a draw must never charge a platform fee');
    const m = await queryOne('SELECT * FROM matches WHERE id = ?', [accept.body.match.id]);
    assert.equal(m.is_draw, 1);
  });

  test('more_corners: equal corner counts is a draw', async () => {
    const A = await newPlayer('cornA');
    const B = await newPlayer('cornB');
    const fixtureId = await makeFixture({ status: 'SCHEDULED', kickoffMs: 1000 });
    const created = await api().post('/api/football/challenges').set(auth(A.token)).send({ opponent: B.user.username, fixtureId, challengeTypeSlug: 'more_corners', pick: 'HOME', stake: 5 });
    const match = await api().post(`/api/challenges/${created.body.challenge.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' });
    await query(`UPDATE football_fixtures SET status='FINISHED', home_score=1, away_score=0, home_corners=6, away_corners=6, stats_available=1, kickoff_at = NOW() - INTERVAL 1 HOUR WHERE id = ?`, [fixtureId]);
    await settleMatchesForFixture(fixtureId);
    assert.equal((await wallet(A.token)).available, 250);
    assert.equal((await wallet(B.token)).available, 250);
    const settlement = await queryOne('SELECT * FROM settlements WHERE match_id = ?', [match.body.match.id]);
    assert.equal(settlement.outcome, 'DRAW');
    assert.equal(Number(settlement.fee_amount), 0);
  });
});

describe('football: cancellation and void (no fee, full refund)', () => {
  test('fixture postponed before kickoff -> CANCELLED, full refund, no fee', async () => {
    const A = await newPlayer('pstA');
    const B = await newPlayer('pstB');
    const fixtureId = await makeFixture({ status: 'SCHEDULED', kickoffMs: 1000 });
    const created = await api().post('/api/football/challenges').set(auth(A.token)).send({ opponent: B.user.username, fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 20 });
    const match = await api().post(`/api/challenges/${created.body.challenge.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' });
    assert.equal((await wallet(A.token)).locked, 20);
    await query(`UPDATE football_fixtures SET status = 'POSTPONED' WHERE id = ?`, [fixtureId]);
    const count = await voidMatchesForFixture(fixtureId, 'the football match was postponed', { toStatus: 'CANCELLED' });
    assert.equal(count, 1);
    assert.deepEqual([(await wallet(A.token)).available, (await wallet(A.token)).locked], [250, 0]);
    assert.deepEqual([(await wallet(B.token)).available, (await wallet(B.token)).locked], [250, 0]);
    const m = await queryOne('SELECT * FROM matches WHERE id = ?', [match.body.match.id]);
    assert.equal(m.status, 'CANCELLED');
    const settlement = await queryOne('SELECT * FROM settlements WHERE match_id = ?', [match.body.match.id]);
    assert.equal(settlement.outcome, 'CANCELLED');
    assert.equal(Number(settlement.fee_amount), 0);
  });

  test('fixture abandoned mid-match -> VOID, full refund, no fee', async () => {
    const A = await newPlayer('abnA');
    const B = await newPlayer('abnB');
    const fixtureId = await makeFixture({ status: 'SCHEDULED', kickoffMs: 10000 });
    const created = await api().post('/api/football/challenges').set(auth(A.token)).send({ opponent: B.user.username, fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 50 });
    const match = await api().post(`/api/challenges/${created.body.challenge.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' });
    await query(`UPDATE matches SET status = 'IN_PROGRESS', started_at = NOW() WHERE id = ?`, [match.body.match.id]);
    await query(`UPDATE football_fixtures SET status = 'ABANDONED' WHERE id = ?`, [fixtureId]);
    await voidMatchesForFixture(fixtureId, 'the football match was abandoned before full time', { toStatus: 'VOID' });
    assert.deepEqual([(await wallet(A.token)).available, (await wallet(A.token)).locked], [250, 0]);
    assert.deepEqual([(await wallet(B.token)).available, (await wallet(B.token)).locked], [250, 0]);
    const m = await queryOne('SELECT * FROM matches WHERE id = ?', [match.body.match.id]);
    assert.equal(m.status, 'VOID');
    const detail = await api().get(`/api/matches/${m.code}`).set(auth(A.token));
    assert.equal(detail.body.error?.code ?? detail.status, 200);
  });

  test('a required-stats type on a fixture that never gets stats is voided rather than guessed', async () => {
    const A = await newPlayer('noStA');
    const B = await newPlayer('noStB');
    const fixtureId = await makeFixture({ status: 'SCHEDULED', kickoffMs: 1000 });
    const created = await api().post('/api/football/challenges').set(auth(A.token)).send({ opponent: B.user.username, fixtureId, challengeTypeSlug: 'more_shots', pick: 'HOME', stake: 10 });
    const match = await api().post(`/api/challenges/${created.body.challenge.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' });
    // Finished, but this provider run never populated shot statistics.
    await query(`UPDATE football_fixtures SET status = 'FINISHED', home_score = 1, away_score = 0, stats_available = 0, kickoff_at = NOW() - INTERVAL 1 HOUR WHERE id = ?`, [fixtureId]);
    // Kickoff has passed, so in the real pipeline the sync tick would already
    // have moved this from MATCHED to IN_PROGRESS — simulate that here.
    await query(`UPDATE matches SET status = 'IN_PROGRESS', started_at = NOW() WHERE id = ?`, [match.body.match.id]);
    const settledNow = await settleFootballMatch(match.body.match.id);
    assert.equal(settledNow, false, 'must wait rather than guess without the required stats');
    assert.equal((await wallet(A.token)).locked, 10, 'stake stays locked while genuinely pending');
    // ...but if the provider never supplies it, the unresolved-timeout sweep eventually voids it.
    await query(`UPDATE matches SET started_at = NOW() - INTERVAL 5 HOUR WHERE id = ?`, [match.body.match.id]);
    await query(`UPDATE football_fixtures SET kickoff_at = NOW() - INTERVAL 5 HOUR WHERE id = ?`, [fixtureId]);
    await voidUnresolvedFixtures();
    assert.deepEqual([(await wallet(A.token)).available, (await wallet(A.token)).locked], [250, 0]);
    const m = await queryOne('SELECT * FROM matches WHERE id = ?', [match.body.match.id]);
    assert.equal(m.status, 'VOID');
  });
});

describe('football: duplicate protection', () => {
  test('a second pending challenge for the same fixture/type/pair is rejected', async () => {
    const A = await newPlayer('dupA');
    const B = await newPlayer('dupB');
    const fixtureId = await makeFixture({ status: 'SCHEDULED', kickoffMs: 3600000 });
    const first = await api().post('/api/football/challenges').set(auth(A.token)).send({ opponent: B.user.username, fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 10 });
    assert.equal(first.status, 201);
    const dup = await api().post('/api/football/challenges').set(auth(A.token)).send({ opponent: B.user.username, fixtureId, challengeTypeSlug: 'match_winner', pick: 'AWAY', stake: 10 });
    assert.equal(dup.body.error.code, 'DUPLICATE_CHALLENGE');
  });

  test('invalid pick and invalid stake are rejected server-side', async () => {
    const A = await newPlayer('badA');
    const B = await newPlayer('badB');
    const fixtureId = await makeFixture({ status: 'SCHEDULED', kickoffMs: 3600000 });
    const badPick = await api().post('/api/football/challenges').set(auth(A.token)).send({ opponent: B.user.username, fixtureId, challengeTypeSlug: 'match_winner', pick: 'YES', stake: 10 });
    assert.equal(badPick.status, 400);
    const badStake = await api().post('/api/football/challenges').set(auth(A.token)).send({ opponent: B.user.username, fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 7 });
    assert.equal(badStake.body.error.code, 'INVALID_STAKE');
  });
});
