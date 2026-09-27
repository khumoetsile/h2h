// Open Challenges (Find Opponent must be publicly discoverable), strict
// 1v1 race-condition safety, and the locked-challenge abandonment fee.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rivalis_test';

const { migrate } = await import('../scripts/migrate.js');
const { seed } = await import('../scripts/seed.js');
const { createApp } = await import('../src/app.js');
const { pool, query, queryOne } = await import('../src/db.js');
const { ABANDONMENT_FEE_AMOUNT } = await import('../src/services/walletService.js');
const request = (await import('supertest')).default;

const app = createApp();
const api = () => request(app);
const quiet = () => {};
const auth = (t) => ({ Authorization: `Bearer ${t}` });

let n = 0;
async function newPlayer(prefix = 'oc') {
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

let fixtureSeq = 500;
async function makeFixture({ kickoffMs = 3600000 } = {}) {
  fixtureSeq += 1;
  const res = await query(
    `INSERT INTO football_fixtures (provider, provider_fixture_id, competition_id, season, home_team_id, away_team_id, kickoff_at, status, is_simulated)
     VALUES ('mock', ?, ?, '2026', ?, ?, ?, 'SCHEDULED', 1)`,
    [`test-oc-${fixtureSeq}`, compId, homeId, awayId, new Date(Date.now() + kickoffMs)],
  );
  return res.insertId;
}

describe('Open Challenges: Find Opponent must be publicly discoverable', () => {
  test('a WAITING match created via /football/find appears in another player\'s open-challenges list, but not the creator\'s own', async () => {
    const A = await newPlayer('discA');
    const B = await newPlayer('discB');
    const fixtureId = await makeFixture();
    const find = await api().post('/api/football/find').set(auth(A.token)).send({ fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 20 });
    assert.equal(find.body.match.status, 'WAITING');

    const asB = await api().get('/api/football/open-challenges').set(auth(B.token));
    assert.equal(asB.status, 200);
    const found = asB.body.challenges.find((c) => c.matchId === find.body.match.id);
    assert.ok(found, 'the open challenge must be visible to another player');
    assert.equal(found.creator.username, A.user.username);
    assert.equal(found.creatorPick, 'HOME');
    assert.equal(found.stake, 20);
    assert.ok(found.challengeType.question.includes('win'));

    const asA = await api().get('/api/football/open-challenges').set(auth(A.token));
    assert.ok(!asA.body.challenges.some((c) => c.matchId === find.body.match.id), "a player's own open challenge must not appear in their own discovery list");
  });

  test('joining removes the challenge from Open Challenges and locks it to exactly 2 players', async () => {
    const A = await newPlayer('joinA');
    const B = await newPlayer('joinB');
    const fixtureId = await makeFixture();
    const find = await api().post('/api/football/find').set(auth(A.token)).send({ fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 10 });
    const matchId = find.body.match.id;

    const join = await api().post(`/api/football/open-challenges/${matchId}/join`).set(auth(B.token));
    assert.equal(join.status, 200, JSON.stringify(join.body));
    assert.equal(join.body.match.status, 'READY', 'creator locked in at creation + joiner via Accept & Lock In -> LOCKED');
    assert.equal(join.body.match.players.length, 2);
    assert.equal(join.body.match.football.opponentPick, 'AWAY');

    const stillOpen = await api().get('/api/football/open-challenges').set(auth(B.token));
    assert.ok(!stillOpen.body.challenges.some((c) => c.matchId === matchId), 'a locked challenge must disappear from Open Challenges');

    const players = await query('SELECT * FROM match_players WHERE match_id = ?', [matchId]);
    assert.equal(players.length, 2);
  });

  test('a player cannot join their own open challenge', async () => {
    const A = await newPlayer('selfA');
    const fixtureId = await makeFixture();
    const find = await api().post('/api/football/find').set(auth(A.token)).send({ fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 10 });
    const res = await api().post(`/api/football/open-challenges/${find.body.match.id}/join`).set(auth(A.token));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'CANNOT_JOIN_OWN_MATCH');
  });
});

describe('Race condition: only one of two simultaneous joiners can win', () => {
  test('Player B and Player C join the same open challenge at the same time — exactly one succeeds, the other gets CHALLENGE_ALREADY_TAKEN, and exactly 2 players ever exist', async () => {
    const A = await newPlayer('raceA');
    const B = await newPlayer('raceB');
    const C = await newPlayer('raceC');
    const fixtureId = await makeFixture();
    const find = await api().post('/api/football/find').set(auth(A.token)).send({ fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 20 });
    const matchId = find.body.match.id;

    const [resB, resC] = await Promise.all([
      api().post(`/api/football/open-challenges/${matchId}/join`).set(auth(B.token)),
      api().post(`/api/football/open-challenges/${matchId}/join`).set(auth(C.token)),
    ]);

    const statuses = [resB.status, resC.status].sort();
    assert.deepEqual(statuses, [200, 409], `expected exactly one 200 and one 409, got ${JSON.stringify(statuses)}`);
    const loser = resB.status === 409 ? resB : resC;
    assert.equal(loser.body.error.code, 'CHALLENGE_ALREADY_TAKEN');
    assert.ok(loser.body.error.message.toLowerCase().includes('already been taken'));

    const players = await query('SELECT user_id FROM match_players WHERE match_id = ?', [matchId]);
    assert.equal(players.length, 2, 'a football challenge must never end up with more than 2 players');
    const winnerToken = resB.status === 200 ? B.token : C.token;
    const loserId = resB.status === 200 ? C.user.id : B.user.id;
    assert.ok(!players.some((p) => p.user_id === loserId), 'the player who lost the race must not have been added');
    assert.ok(winnerToken); // sanity — one of B/C did get in
  });
});

describe('Leaving before lock is still free (unchanged behaviour)', () => {
  test('cancelling a WAITING (not-yet-matched) football challenge is free — no abandonment fee', async () => {
    const A = await newPlayer('freeA');
    const fixtureId = await makeFixture();
    const find = await api().post('/api/football/find').set(auth(A.token)).send({ fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 20 });
    const matchId = find.body.match.id;
    const cancel = await api().post(`/api/matches/${matchId}/cancel`).set(auth(A.token));
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    assert.equal(cancel.body.match.status, 'CANCELLED');
    const w = await wallet(A.token);
    assert.equal(w.available, 250, 'full stake must be refunded with no fee at all');
    const fee = await query(`SELECT * FROM transactions WHERE user_id = ? AND type = 'ABANDONMENT_FEE'`, [A.user.id]);
    assert.equal(fee.length, 0, 'no abandonment fee should ever be charged before a challenge is locked');
  });
});

describe('Abandonment fee: leaving a LOCKED football challenge', () => {
  test('the leaver is charged exactly P0.50 once, the remaining player is refunded in full and never charged, and the challenge settles idempotently', async () => {
    const A = await newPlayer('abnA');
    const B = await newPlayer('abnB');
    const fixtureId = await makeFixture();
    const find = await api().post('/api/football/find').set(auth(A.token)).send({ fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 20 });
    const matchId = find.body.match.id;
    // B joins with "Accept & Lock In"; A then locks in too -> the challenge is LOCKED (READY).
    await api().post(`/api/football/open-challenges/${matchId}/join`).set(auth(B.token));
    const lock = await api().post(`/api/matches/${matchId}/ready`).set(auth(A.token));
    assert.equal(lock.body.match.status, 'READY', 'both players locked in = LOCKED');

    const beforeA = await wallet(A.token);
    const beforeB = await wallet(B.token);
    assert.equal(beforeA.locked, 20);
    assert.equal(beforeB.locked, 20);

    const leave = await api().post(`/api/matches/${matchId}/cancel`).set(auth(A.token));
    assert.equal(leave.status, 200, JSON.stringify(leave.body));
    assert.equal(leave.body.match.status, 'CANCELLED');

    const afterA = await wallet(A.token);
    const afterB = await wallet(B.token);
    // A: stake refunded (+20) then the fee taken (-0.50) => net +19.50 vs. the pre-challenge baseline of 250.
    assert.equal(afterA.available, 250 - ABANDONMENT_FEE_AMOUNT, `A should have their stake back minus the ${ABANDONMENT_FEE_AMOUNT} fee`);
    assert.equal(afterA.locked, 0);
    // B: untouched by the abandonment — full stake back, no fee, no penalty.
    assert.equal(afterB.available, 250);
    assert.equal(afterB.locked, 0);

    const feeTx = await query(`SELECT * FROM transactions WHERE match_id = ? AND type = 'ABANDONMENT_FEE'`, [matchId]);
    assert.equal(feeTx.length, 1, 'exactly one ABANDONMENT_FEE transaction must exist');
    assert.equal(feeTx[0].user_id, A.user.id);
    assert.equal(Number(feeTx[0].amount), ABANDONMENT_FEE_AMOUNT);
    assert.equal(feeTx[0].direction, 'DEBIT');
    const bFee = await query(`SELECT * FROM transactions WHERE match_id = ? AND type = 'ABANDONMENT_FEE' AND user_id = ?`, [matchId, B.user.id]);
    assert.equal(bFee.length, 0, 'the remaining player must never be charged the abandonment fee');

    const settlement = await queryOne('SELECT * FROM settlements WHERE match_id = ?', [matchId]);
    assert.equal(settlement.outcome, 'CANCELLED');
    assert.equal(Number(settlement.fee_amount), 0, 'the platform fee on the cancellation itself is still zero — the P0.50 is a separate charge, not a platform fee');

    const events = await query('SELECT action, actor_user_id, metadata FROM audit_events WHERE match_id = ? ORDER BY id', [matchId]);
    const abandonEvent = events.find((e) => e.action === 'CHALLENGE_ABANDONED');
    assert.ok(abandonEvent, 'a CHALLENGE_ABANDONED audit event must exist');
    assert.equal(abandonEvent.actor_user_id, A.user.id);
    assert.equal(abandonEvent.metadata.abandonmentFee, ABANDONMENT_FEE_AMOUNT);

    // Idempotency: trying to leave/cancel again must not charge a second fee or re-settle.
    const again = await api().post(`/api/matches/${matchId}/cancel`).set(auth(A.token));
    assert.ok(again.status >= 400, 'cancelling an already-settled match must be rejected, not silently repeated');
    const feeAfterRetry = await query(`SELECT * FROM transactions WHERE match_id = ? AND type = 'ABANDONMENT_FEE'`, [matchId]);
    assert.equal(feeAfterRetry.length, 1, 'the fee must never be charged twice');
  });

  test('a player cannot leave once the real fixture has kicked off (IN_PROGRESS)', async () => {
    const A = await newPlayer('kickA');
    const B = await newPlayer('kickB');
    const fixtureId = await makeFixture({ kickoffMs: 2000 });
    const find = await api().post('/api/football/find').set(auth(A.token)).send({ fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 10 });
    const matchId = find.body.match.id;
    await api().post(`/api/football/open-challenges/${matchId}/join`).set(auth(B.token));
    await query(`UPDATE matches SET status = 'IN_PROGRESS', started_at = NOW() WHERE id = ?`, [matchId]);

    const leave = await api().post(`/api/matches/${matchId}/cancel`).set(auth(A.token));
    assert.equal(leave.status, 409);
    assert.equal(leave.body.error.code, 'MATCH_ALREADY_STARTED');
    assert.equal((await wallet(A.token)).locked, 10, 'stake must remain locked — the match is still live, awaiting the real result');
  });
});

describe('Draw and Void are unaffected by the abandonment fee', () => {
  test('a genuine draw still fully refunds both players at zero platform fee, with no abandonment charge', async () => {
    const A = await newPlayer('drawA');
    const B = await newPlayer('drawB');
    const fixtureId = await makeFixture({ kickoffMs: 2000 });
    const find = await api().post('/api/football/find').set(auth(A.token)).send({ fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 20 });
    const matchId = find.body.match.id;
    await api().post(`/api/football/open-challenges/${matchId}/join`).set(auth(B.token));
    await query(`UPDATE football_fixtures SET status = 'FINISHED', home_score = 1, away_score = 1, kickoff_at = NOW() - INTERVAL 1 HOUR WHERE id = ?`, [fixtureId]);
    const { settleMatchesForFixture } = await import('../src/football/footballSettlementService.js');
    await settleMatchesForFixture(fixtureId);

    assert.equal((await wallet(A.token)).available, 250);
    assert.equal((await wallet(B.token)).available, 250);
    const settlement = await queryOne('SELECT * FROM settlements WHERE match_id = ?', [matchId]);
    assert.equal(settlement.outcome, 'DRAW');
    assert.equal(Number(settlement.fee_amount), 0);
    const fee = await query(`SELECT * FROM transactions WHERE match_id = ? AND type = 'ABANDONMENT_FEE'`, [matchId]);
    assert.equal(fee.length, 0);
  });

  test('a void (postponed) fixture still fully refunds both players at zero fee, with no abandonment charge', async () => {
    const A = await newPlayer('voidA');
    const B = await newPlayer('voidB');
    const fixtureId = await makeFixture({ kickoffMs: 2000 });
    const find = await api().post('/api/football/find').set(auth(A.token)).send({ fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 20 });
    const matchId = find.body.match.id;
    await api().post(`/api/football/open-challenges/${matchId}/join`).set(auth(B.token));
    await query(`UPDATE football_fixtures SET status = 'POSTPONED' WHERE id = ?`, [fixtureId]);
    const { voidMatchesForFixture } = await import('../src/football/footballSettlementService.js');
    await voidMatchesForFixture(fixtureId, 'the football match was postponed', { toStatus: 'CANCELLED' });

    assert.equal((await wallet(A.token)).available, 250);
    assert.equal((await wallet(B.token)).available, 250);
    const settlement = await queryOne('SELECT * FROM settlements WHERE match_id = ?', [matchId]);
    assert.equal(settlement.outcome, 'CANCELLED');
    assert.equal(Number(settlement.fee_amount), 0);
    const fee = await query(`SELECT * FROM transactions WHERE match_id = ? AND type = 'ABANDONMENT_FEE'`, [matchId]);
    assert.equal(fee.length, 0, 'a system-initiated void must never charge the player abandonment fee');
  });
});
