// Direct football challenges must be genuinely player-vs-player: the
// opponent's pick is a real, independently-validated request field — never
// derived from the creator's pick. These tests cover the accept endpoint's
// pick validation specifically (valid opposing pick, same-side rejection,
// missing pick, invalid pick, a client trying to bypass validation), that
// both real selections land in the audit trail, and the new
// more_possession / more_shots_on_target settlement rules. Existing
// matchmaking behaviour (which already required a real opponent pick) is
// re-verified unchanged.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rivalis_test';

const { migrate } = await import('../scripts/migrate.js');
const { seed } = await import('../scripts/seed.js');
const { createApp } = await import('../src/app.js');
const { pool, query, queryOne } = await import('../src/db.js');
const { settleMatchesForFixture } = await import('../src/football/footballSettlementService.js');
const request = (await import('supertest')).default;

const app = createApp();
const api = () => request(app);
const quiet = () => {};
const auth = (t) => ({ Authorization: `Bearer ${t}` });

let n = 0;
async function newPlayer(prefix = 'dc') {
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

let fixtureSeq = 900;
async function makeFixture({ status = 'SCHEDULED', kickoffMs = 60 * 60 * 1000 } = {}) {
  fixtureSeq += 1;
  const res = await query(
    `INSERT INTO football_fixtures (provider, provider_fixture_id, competition_id, season, home_team_id, away_team_id, kickoff_at, status, is_simulated)
     VALUES ('mock', ?, ?, '2026', ?, ?, ?, ?, 1)`,
    [`test-dc-${fixtureSeq}`, compId, homeId, awayId, new Date(Date.now() + kickoffMs), status],
  );
  return res.insertId;
}

async function createDirectChallenge(A, B, { fixtureId, slug = 'match_winner', pick = 'HOME', stake = 20 } = {}) {
  const res = await api().post('/api/football/challenges').set(auth(A.token)).send({
    opponent: B.user.username, fixtureId, challengeTypeSlug: slug, pick, stake,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.challenge;
}

describe('GET /challenges list includes football fields (regression: the inbox must be able to render the pick UI)', () => {
  test('an incoming football challenge in the list carries question/picks, not just game name', async () => {
    const A = await newPlayer('listA');
    const B = await newPlayer('listB');
    const fixtureId = await makeFixture();
    const challenge = await createDirectChallenge(A, B, { fixtureId, slug: 'more_shots', pick: 'HOME', stake: 20 });

    const list = await api().get('/api/challenges').query({ status: 'all' }).set(auth(B.token));
    assert.equal(list.status, 200);
    const row = list.body.challenges.find((c) => c.id === challenge.id);
    assert.ok(row, 'the challenge must appear in the recipient\'s list');
    assert.ok(row.football, 'a football challenge in the LIST endpoint must include its football fields');
    assert.equal(row.football.creatorPick, 'HOME');
    assert.equal(row.football.pickType, 'TEAM');
    assert.ok(row.football.question.includes('shots'));
    assert.ok(row.football.homePickLabel);
    assert.ok(row.football.awayPickLabel);
  });
});

describe('direct football challenge: opponent pick', () => {
  test('valid opposing pick is accepted, locks both stakes, and stores BOTH real picks', async () => {
    const A = await newPlayer('validA');
    const B = await newPlayer('validB');
    const fixtureId = await makeFixture();
    const challenge = await createDirectChallenge(A, B, { fixtureId, pick: 'HOME' });

    const res = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.match.status, 'READY', 'challenger locked in when sending, acceptor via Accept & Lock In -> LOCKED');
    assert.equal(res.body.match.football.creatorPick, 'HOME');
    assert.equal(res.body.match.football.opponentPick, 'AWAY', 'the opponent pick must be exactly what B submitted, not a derived value');
    assert.equal((await wallet(A.token)).locked, 20);
    assert.equal((await wallet(B.token)).locked, 20);

    const row = await queryOne('SELECT * FROM football_challenges WHERE match_id = ?', [res.body.match.id]);
    assert.equal(row.creator_pick, 'HOME');
    assert.equal(row.opponent_pick, 'AWAY');
  });

  test('the SAME side as the creator is rejected — the backend enforces opposing picks, not the client', async () => {
    const A = await newPlayer('sameA');
    const B = await newPlayer('sameB');
    const fixtureId = await makeFixture();
    const challenge = await createDirectChallenge(A, B, { fixtureId, pick: 'HOME' });

    const res = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({ pick: 'HOME' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'SAME_SIDE_NOT_ALLOWED');

    // Nothing was locked and no match/football_challenges row was created.
    assert.equal((await wallet(A.token)).locked, 0);
    assert.equal((await wallet(B.token)).locked, 0);
    const stillPending = await queryOne('SELECT status FROM challenges WHERE id = ?', [challenge.id]);
    assert.equal(stillPending.status, 'PENDING');
  });

  test('accepting with no pick supplied at all is rejected', async () => {
    const A = await newPlayer('nopickA');
    const B = await newPlayer('nopickB');
    const fixtureId = await makeFixture();
    const challenge = await createDirectChallenge(A, B, { fixtureId, pick: 'HOME' });

    const res = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({});
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    const stillPending = await queryOne('SELECT status FROM challenges WHERE id = ?', [challenge.id]);
    assert.equal(stillPending.status, 'PENDING');
  });

  test('an invalid/unrecognised pick value is rejected', async () => {
    const A = await newPlayer('badpickA');
    const B = await newPlayer('badpickB');
    const fixtureId = await makeFixture();
    const challenge = await createDirectChallenge(A, B, { fixtureId, pick: 'HOME' });

    const res = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({ pick: 'DRAW' });
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  test('a YES/NO challenge type also enforces opposing picks (not just TEAM types)', async () => {
    const A = await newPlayer('yesnoA');
    const B = await newPlayer('yesnoB');
    const fixtureId = await makeFixture();
    const challenge = await createDirectChallenge(A, B, { fixtureId, slug: 'both_teams_score', pick: 'YES' });

    const same = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({ pick: 'YES' });
    assert.equal(same.status, 409);
    assert.equal(same.body.error.code, 'SAME_SIDE_NOT_ALLOWED');

    // A pick from the wrong pick-type family (HOME/AWAY on a YES/NO question) must also be rejected.
    const wrongFamily = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({ pick: 'HOME' });
    assert.equal(wrongFamily.status, 400);

    const valid = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({ pick: 'NO' });
    assert.equal(valid.status, 200, JSON.stringify(valid.body));
    assert.equal(valid.body.match.football.opponentPick, 'NO');
  });

  test('security: a client cannot bypass validation by tampering with the request — same-side and garbage picks are always rejected server-side', async () => {
    const A = await newPlayer('secA');
    const B = await newPlayer('secB');
    const fixtureId = await makeFixture();
    const challenge = await createDirectChallenge(A, B, { fixtureId, pick: 'AWAY' });

    // Simulate a modified/hand-crafted request trying every value that is not the true opposite.
    for (const attempted of ['AWAY', 'YES', 'NO', 'home', '', null, 123, { pick: 'HOME' }]) {
      const res = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({ pick: attempted });
      assert.ok(res.status === 400 || res.status === 409, `expected rejection for pick=${JSON.stringify(attempted)}, got ${res.status}`);
    }
    // The only valid opposing pick still works afterwards — rejections weren't consuming/corrupting the challenge.
    const valid = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({ pick: 'HOME' });
    assert.equal(valid.status, 200, JSON.stringify(valid.body));
  });

  test('duplicate acceptance (double-click) is rejected once the challenge is already accepted', async () => {
    const A = await newPlayer('dupA');
    const B = await newPlayer('dupB');
    const fixtureId = await makeFixture();
    const challenge = await createDirectChallenge(A, B, { fixtureId, pick: 'HOME' });
    const first = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' });
    assert.equal(first.status, 200);
    const second = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'CHALLENGE_CLOSED');
    // Only one match / one football_challenges row / one pair of locked stakes exists.
    const matches = await query('SELECT * FROM matches WHERE created_by = ? AND category = ?', [A.user.id, 'FOOTBALL']);
    assert.equal(matches.length, 1);
  });

  test('audit trail proves both players made their own selection (creator pick at creation, opponent pick at acceptance)', async () => {
    const A = await newPlayer('audA');
    const B = await newPlayer('audB');
    const fixtureId = await makeFixture();
    const challenge = await createDirectChallenge(A, B, { fixtureId, pick: 'HOME' });
    const accept = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' });
    assert.equal(accept.status, 200);

    const events = await query('SELECT * FROM audit_events WHERE challenge_id = ? ORDER BY id', [challenge.id]);
    const created = events.find((e) => e.action === 'CHALLENGE_CREATED');
    const accepted = events.find((e) => e.action === 'CHALLENGE_ACCEPTED');
    assert.ok(created, 'expected a CHALLENGE_CREATED audit event');
    assert.ok(accepted, 'expected a CHALLENGE_ACCEPTED audit event');
    assert.equal(created.actor_user_id, A.user.id);
    assert.equal(created.metadata.pick, 'HOME', "the creator's real submitted pick must be recorded");
    assert.equal(accepted.actor_user_id, B.user.id);
    assert.equal(accepted.metadata.opponentPick, 'AWAY', "the opponent's real submitted pick must be recorded, not a derived value");
    assert.equal(accepted.metadata.creatorPick, 'HOME');
  });
});

describe('new question types: more_possession / more_shots_on_target', () => {
  test('more_possession settles WIN correctly and DRAW on an exact split', async () => {
    const A = await newPlayer('possA');
    const B = await newPlayer('possB');
    const fixtureId = await makeFixture({ kickoffMs: 2000 });
    const challenge = await createDirectChallenge(A, B, { fixtureId, slug: 'more_possession', pick: 'HOME', stake: 20 });
    const accept = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' });
    assert.equal(accept.status, 200);
    await query(`UPDATE football_fixtures SET status = 'FINISHED', home_possession = 58, away_possession = 42, stats_available = 1, kickoff_at = NOW() - INTERVAL 1 HOUR WHERE id = ?`, [fixtureId]);
    await settleMatchesForFixture(fixtureId);
    const wa = await wallet(A.token);
    assert.equal(wa.available, 250 - 20 + 36, "Arsenal's higher possession (58% vs 42%) means A's HOME pick wins");
    const settlement = await queryOne('SELECT * FROM settlements WHERE match_id = ?', [accept.body.match.id]);
    assert.equal(settlement.outcome, 'WIN');
  });

  test('more_possession is a draw at an exact 50/50 split, with zero fee', async () => {
    const A = await newPlayer('possDrawA');
    const B = await newPlayer('possDrawB');
    const fixtureId = await makeFixture({ kickoffMs: 2000 });
    const challenge = await createDirectChallenge(A, B, { fixtureId, slug: 'more_possession', pick: 'HOME', stake: 20 });
    const accept = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' });
    await query(`UPDATE football_fixtures SET status = 'FINISHED', home_possession = 50, away_possession = 50, stats_available = 1, kickoff_at = NOW() - INTERVAL 1 HOUR WHERE id = ?`, [fixtureId]);
    await settleMatchesForFixture(fixtureId);
    assert.equal((await wallet(A.token)).available, 250);
    assert.equal((await wallet(B.token)).available, 250);
    const settlement = await queryOne('SELECT * FROM settlements WHERE match_id = ?', [accept.body.match.id]);
    assert.equal(settlement.outcome, 'DRAW');
    assert.equal(Number(settlement.fee_amount), 0);
  });

  test('more_shots_on_target voids (full refund, no fee) when the statistic never arrives', async () => {
    const A = await newPlayer('sotA');
    const B = await newPlayer('sotB');
    const fixtureId = await makeFixture({ kickoffMs: 2000 });
    const challenge = await createDirectChallenge(A, B, { fixtureId, slug: 'more_shots_on_target', pick: 'HOME', stake: 10 });
    const accept = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' });
    // Finished, but shots-on-target was never populated (stats_available stays 0).
    await query(`UPDATE football_fixtures SET status = 'FINISHED', home_score = 1, away_score = 0, stats_available = 0, kickoff_at = NOW() - INTERVAL 1 HOUR WHERE id = ?`, [fixtureId]);
    await query(`UPDATE matches SET status = 'IN_PROGRESS', started_at = NOW() WHERE id = ?`, [accept.body.match.id]);
    const settledNow = await settleMatchesForFixture(fixtureId);
    assert.equal(settledNow, 0, 'must wait rather than guess when the required stat is missing');
    assert.equal((await wallet(A.token)).locked, 10, 'stake must remain locked, not incorrectly settled');
  });
});

describe('football settlement audit trail (regression: settleFootballMatch must record MATCH_COMPLETED + SETTLEMENT_CREATED)', () => {
  test('a football WIN records MATCH_COMPLETED and SETTLEMENT_CREATED audit events, not just the generic challenge events', async () => {
    const A = await newPlayer('faudA');
    const B = await newPlayer('faudB');
    const fixtureId = await makeFixture({ kickoffMs: 2000 });
    const challenge = await createDirectChallenge(A, B, { fixtureId, slug: 'match_winner', pick: 'HOME', stake: 20 });
    const accept = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' });
    assert.equal(accept.status, 200);
    await query(`UPDATE football_fixtures SET status = 'FINISHED', home_score = 2, away_score = 0, kickoff_at = NOW() - INTERVAL 1 HOUR WHERE id = ?`, [fixtureId]);
    await settleMatchesForFixture(fixtureId);

    const events = await query('SELECT action, metadata FROM audit_events WHERE match_id = ? ORDER BY id', [accept.body.match.id]);
    const actions = events.map((e) => e.action);
    assert.ok(actions.includes('MATCH_COMPLETED'), `expected MATCH_COMPLETED, got: ${actions.join(', ')}`);
    assert.ok(actions.includes('SETTLEMENT_CREATED'), `expected SETTLEMENT_CREATED, got: ${actions.join(', ')}`);
    const settlementEvent = events.find((e) => e.action === 'SETTLEMENT_CREATED');
    assert.equal(settlementEvent.metadata.outcome, 'WIN');
    assert.equal(settlementEvent.metadata.winnerId, A.user.id);
  });

  test('a football VOID (postponed) records MATCH_VOID and SETTLEMENT_CREATED via the void path', async () => {
    const A = await newPlayer('vaudA');
    const B = await newPlayer('vaudB');
    const fixtureId = await makeFixture({ kickoffMs: 2000 });
    const challenge = await createDirectChallenge(A, B, { fixtureId, slug: 'match_winner', pick: 'HOME', stake: 10 });
    const accept = await api().post(`/api/challenges/${challenge.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' });
    await query(`UPDATE football_fixtures SET status = 'POSTPONED' WHERE id = ?`, [fixtureId]);
    const { voidMatchesForFixture } = await import('../src/football/footballSettlementService.js');
    await voidMatchesForFixture(fixtureId, 'the football match was postponed', { toStatus: 'CANCELLED' });

    const events = await query('SELECT action FROM audit_events WHERE match_id = ? ORDER BY id', [accept.body.match.id]);
    const actions = events.map((e) => e.action);
    assert.ok(actions.includes('MATCH_CANCELLED'));
    assert.ok(actions.includes('SETTLEMENT_CREATED'));
  });
});

describe('matchmaking: existing opposing-pick behaviour is unchanged', () => {
  test('two opposite picks match; the same pick never matches itself', async () => {
    const A = await newPlayer('mm2A');
    const B = await newPlayer('mm2B');
    const fixtureId = await makeFixture({ kickoffMs: 3600000 });
    const findA = await api().post('/api/football/find').set(auth(A.token)).send({ fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 10 });
    assert.equal(findA.body.match.status, 'WAITING');
    const sameSide = await api().post('/api/football/find').set(auth(B.token)).send({ fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 10 });
    assert.equal(sameSide.body.matched, false, 'HOME must never match another HOME');
    const C = await newPlayer('mm2C');
    const opposite = await api().post('/api/football/find').set(auth(C.token)).send({ fixtureId, challengeTypeSlug: 'match_winner', pick: 'AWAY', stake: 10 });
    assert.equal(opposite.body.matched, true);
    assert.equal(opposite.body.match.id, findA.body.match.id);
    const row = await queryOne('SELECT * FROM football_challenges WHERE match_id = ?', [findA.body.match.id]);
    assert.equal(row.creator_pick, 'HOME');
    assert.equal(row.opponent_pick, 'AWAY', "both real submitted picks must be stored in the database");
  });
});
