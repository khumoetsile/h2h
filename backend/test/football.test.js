// Football category: fixtures, direct/matchmaking challenges, and every
// settlement outcome (win / draw / cancelled / void / unresolved-timeout),
// exercised the same way as the skill-game suite — real MySQL, real HTTP.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rivalis_test';

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
    assert.equal(accept.body.match.status, 'MATCHED');
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
    const fixtureId = await makeFixture({ status: 'SCHEDULED', kickoffMs: 1000 });
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
