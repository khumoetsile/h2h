// Server-authoritative PvP timers: acceptance, lock-in, player-action, game
// completion, reconnection and football result deadlines — plus the
// two-player end-to-end flows and the timer edge cases (late accepts,
// simultaneous accepts, reconnects, duplicate sweeps/settlements, a server
// restart mid-timer, a client lying about time).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rivalis_test';

const { migrate } = await import('../scripts/migrate.js');
const { seed } = await import('../scripts/seed.js');
const { createApp } = await import('../src/app.js');
const { pool, query, queryOne } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { sweepMatches, markPresence, compensateDowntime, heartbeat } = await import('../src/services/matchService.js');
const { expireChallenges } = await import('../src/services/challengeService.js');
const { settleMatchesForFixture } = await import('../src/football/footballSettlementService.js');
const { transitionAndExpireAtKickoff } = await import('../src/football/footballSyncService.js');
const request = (await import('supertest')).default;

const app = createApp();
const api = () => request(app);
const quiet = () => {};
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const T = config.timers;
const FEE = config.abandonmentFee;
const past = (ms = 1000) => new Date(Date.now() - ms);
const secondsFromNow = (iso) => (new Date(iso).getTime() - Date.now()) / 1000;

let n = 0;
async function newPlayer(prefix = 'pt') {
  n += 1;
  const u = `${prefix}${Date.now().toString(36)}${n}`.slice(0, 20);
  const res = await api().post('/api/auth/register').send({
    firstName: 'Test', lastName: 'Player', username: u, email: `${u}@test.dev`, phone: '+267 71 234 567',
    password: 'Secret123', confirmPassword: 'Secret123',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { token: res.body.token, user: res.body.user };
}
const wallet = async (token) => (await api().get('/api/wallet').set(auth(token))).body.wallet;
const view = async (token, id) => (await api().get(`/api/matches/${id}`).set(auth(token))).body.match;
const txs = (matchId, type) => query('SELECT * FROM transactions WHERE match_id = ? AND type = ?', [matchId, type]);
const gameId = async (slug) => (await queryOne('SELECT id FROM games WHERE slug = ?', [slug])).id;
const backdateStart = (matchId, userId, ms = 5 * 60000) => query('UPDATE match_players SET started_at = ? WHERE match_id = ? AND user_id = ?', [new Date(Date.now() - ms), matchId, userId]);
const FAST = { rounds: Array.from({ length: 10 }, () => ({ hit: true, reactionMs: 250 })) };
const SLOW = { rounds: Array.from({ length: 10 }, (_, i) => (i < 8 ? { hit: true, reactionMs: 420 } : { hit: false })) };

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
async function makeFixture({ kickoffMs = 3 * 3600000 } = {}) {
  fixtureSeq += 1;
  const res = await query(
    `INSERT INTO football_fixtures (provider, provider_fixture_id, competition_id, season, home_team_id, away_team_id, kickoff_at, status, is_simulated)
     VALUES ('mock', ?, ?, '2026', ?, ?, ?, 'SCHEDULED', 1)`,
    [`test-timer-${fixtureSeq}`, compId, homeId, awayId, new Date(Date.now() + kickoffMs)],
  );
  return res.insertId;
}
async function openChallenge(A, { fixtureId, stake = 20, slug = 'more_shots', pick = 'HOME' } = {}) {
  const fx = fixtureId ?? await makeFixture();
  const res = await api().post('/api/football/find').set(auth(A.token)).send({ fixtureId: fx, challengeTypeSlug: slug, pick, stake });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { fixtureId: fx, match: res.body.match };
}
async function skillPair(A, B, stake = 20) {
  const g = await gameId('reaction-rush');
  await api().post('/api/matches/find').set(auth(A.token)).send({ gameId: g, stake });
  return (await api().post('/api/matches/find').set(auth(B.token)).send({ gameId: g, stake })).body.match;
}

describe('Timer configuration is central and public', () => {
  test('/api/config exposes every timer duration and the fee; /api/time exposes the server clock', async () => {
    const cfg = (await api().get('/api/config')).body;
    assert.deepEqual(Object.keys(cfg.timers).sort(), [
      'challengeAcceptanceSeconds', 'footballResultTimeoutMinutes', 'lockInSeconds', 'lockedGameSeconds', 'playerActionSeconds', 'reconnectionSeconds',
    ]);
    assert.equal(cfg.timers.challengeAcceptanceSeconds, T.challengeAcceptanceSeconds);
    assert.equal(cfg.abandonmentFee, FEE);
    const t = (await api().get('/api/time')).body;
    assert.ok(Math.abs(new Date(t.serverNow).getTime() - Date.now()) < 5000);
  });
});

describe('Find Opponent: acceptance timer', () => {
  test('a new open challenge gets an acceptance deadline from config, and is listed with it for other players', async () => {
    const A = await newPlayer('accA');
    const B = await newPlayer('accB');
    const { match } = await openChallenge(A);
    assert.equal(match.status, 'WAITING');
    const s = secondsFromNow(match.timers.acceptanceDeadline);
    assert.ok(s > T.challengeAcceptanceSeconds - 5 && s <= T.challengeAcceptanceSeconds + 1, `deadline ~${T.challengeAcceptanceSeconds}s away, got ${s}`);
    assert.ok(match.timers.serverNow, 'views carry the server clock');
    const list = (await api().get('/api/football/open-challenges').set(auth(B.token))).body;
    const row = list.challenges.find((c) => c.matchId === match.id);
    assert.ok(row);
    assert.equal(new Date(row.acceptanceDeadline).getTime(), new Date(match.timers.acceptanceDeadline).getTime());
    assert.ok(list.serverNow);
  });

  test('the acceptance deadline never outlives kickoff', async () => {
    const A = await newPlayer('capA');
    const fixtureId = await makeFixture({ kickoffMs: 60000 });
    const { match } = await openChallenge(A, { fixtureId });
    assert.ok(secondsFromNow(match.timers.acceptanceDeadline) <= 61);
  });

  test('refreshing does not reset the timer: the same deadline comes back on every read', async () => {
    const A = await newPlayer('refA');
    const { match } = await openChallenge(A);
    await new Promise((r) => setTimeout(r, 1100));
    const again = await view(A.token, match.id);
    assert.equal(new Date(again.timers.acceptanceDeadline).getTime(), new Date(match.timers.acceptanceDeadline).getTime());
  });

  test('joining with 1 second left succeeds', async () => {
    const A = await newPlayer('oneA');
    const B = await newPlayer('oneB');
    const { match } = await openChallenge(A);
    await query('UPDATE matches SET acceptance_deadline = ? WHERE id = ?', [new Date(Date.now() + 1000), match.id]);
    const join = await api().post(`/api/football/open-challenges/${match.id}/join`).set(auth(B.token));
    assert.equal(join.status, 200, JSON.stringify(join.body));
    assert.equal(join.body.match.status, 'READY');
  });

  test('joining after expiry is refused server-side even before the sweeper runs; it vanishes from Open Challenges; the sweep refunds the creator with no fee', async () => {
    const A = await newPlayer('expA');
    const B = await newPlayer('expB');
    const { match } = await openChallenge(A);
    await query('UPDATE matches SET acceptance_deadline = ? WHERE id = ?', [past(), match.id]);

    const join = await api().post(`/api/football/open-challenges/${match.id}/join`).set(auth(B.token));
    assert.equal(join.status, 409);
    assert.equal(join.body.error.code, 'CHALLENGE_EXPIRED');
    assert.equal((await wallet(B.token)).locked, 0, 'a refused join must not touch the joiner');
    const list = (await api().get('/api/football/open-challenges').set(auth(B.token))).body.challenges;
    assert.ok(!list.some((c) => c.matchId === match.id));

    // Two sweeps at once (duplicate timeout processing) -> exactly one outcome.
    await Promise.all([sweepMatches(), sweepMatches()]);
    const v = await view(A.token, match.id);
    assert.equal(v.status, 'CANCELLED');
    assert.equal(v.endReason, 'NO_OPPONENT');
    const w = await wallet(A.token);
    assert.deepEqual([w.available, w.locked], [250, 0]);
    assert.equal((await txs(match.id, 'REFUND')).length, 1);
    assert.equal((await txs(match.id, 'ABANDONMENT_FEE')).length, 0, 'an expired challenge was never abandoned');
    const s = await queryOne('SELECT * FROM settlements WHERE match_id = ?', [match.id]);
    assert.equal(Number(s.fee_amount), 0);
    const hist = (await api().get('/api/matches').query({ category: 'FOOTBALL' }).set(auth(A.token))).body.items;
    assert.equal(hist.find((h) => h.id === match.id).displayState, 'EXPIRED');
  });

  test('instant matchmaking never pairs with a challenge whose timer ran out', async () => {
    const A = await newPlayer('mmA');
    const B = await newPlayer('mmB');
    const { match, fixtureId } = await openChallenge(A, { pick: 'HOME' });
    await query('UPDATE matches SET acceptance_deadline = ? WHERE id = ?', [past(), match.id]);
    const r = await api().post('/api/football/find').set(auth(B.token)).send({ fixtureId, challengeTypeSlug: 'more_shots', pick: 'AWAY', stake: 20 });
    assert.equal(r.body.matched, false);
    assert.notEqual(r.body.match.id, match.id);
  });

  test('strict 1v1: two simultaneous joiners -> one wins, the other is refused, and a third can never join afterwards', async () => {
    const A = await newPlayer('simA');
    const B = await newPlayer('simB');
    const C = await newPlayer('simC');
    const D = await newPlayer('simD');
    const { match } = await openChallenge(A);
    const [rb, rc] = await Promise.all([
      api().post(`/api/football/open-challenges/${match.id}/join`).set(auth(B.token)),
      api().post(`/api/football/open-challenges/${match.id}/join`).set(auth(C.token)),
    ]);
    assert.deepEqual([rb.status, rc.status].sort(), [200, 409]);
    const rd = await api().post(`/api/football/open-challenges/${match.id}/join`).set(auth(D.token));
    assert.equal(rd.status, 409);
    assert.equal((await query('SELECT * FROM match_players WHERE match_id = ?', [match.id])).length, 2);
  });
});

describe('Direct challenge: acceptance timer', () => {
  test('the invitee gets a deadline from config (capped at kickoff); accepting after it is refused even before the sweeper runs', async () => {
    const A = await newPlayer('dcA');
    const B = await newPlayer('dcB');
    const fixtureId = await makeFixture();
    const c = (await api().post('/api/football/challenges').set(auth(A.token)).send({ opponent: B.user.username, fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 20 })).body.challenge;
    const s = secondsFromNow(c.expiresAt);
    assert.ok(s > T.challengeAcceptanceSeconds - 5 && s <= T.challengeAcceptanceSeconds + 1);
    await query('UPDATE challenges SET expires_at = ? WHERE id = ?', [past(), c.id]);
    const acc = await api().post(`/api/challenges/${c.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' });
    assert.equal(acc.status, 409);
    assert.equal(acc.body.error.code, 'CHALLENGE_EXPIRED');
    await expireChallenges();
    const after = (await api().get(`/api/challenges/${c.id}`).set(auth(A.token))).body.challenge;
    assert.equal(after.status, 'EXPIRED');
    assert.equal((await wallet(A.token)).locked, 0, 'no stake is ever reserved for a pending direct challenge');
    assert.equal((await wallet(B.token)).locked, 0);
  });

  test('football: the challenger locked in when sending; Accept & Lock In makes the challenge LOCKED immediately', async () => {
    const A = await newPlayer('alA');
    const B = await newPlayer('alB');
    const fixtureId = await makeFixture();
    const c = (await api().post('/api/football/challenges').set(auth(A.token)).send({ opponent: B.user.username, fixtureId, challengeTypeSlug: 'match_winner', pick: 'HOME', stake: 20 })).body.challenge;
    const m = (await api().post(`/api/challenges/${c.id}/accept`).set(auth(B.token)).send({ pick: 'AWAY' })).body.match;
    assert.equal(m.status, 'READY');
    assert.ok(m.lockedAt);
    assert.ok(m.players.every((p) => p.lockedIn));
    assert.ok(m.timers.completionDeadline, 'the result deadline is stamped the moment it is locked');
  });

  test('skill game: the acceptor is locked in by accepting; the challenger now owes Lock In on a player-action timer', async () => {
    const A = await newPlayer('asA');
    const B = await newPlayer('asB');
    const c = (await api().post('/api/challenges').set(auth(A.token)).send({ opponent: B.user.username, gameId: await gameId('reaction-rush'), stake: 10 })).body.challenge;
    const m = (await api().post(`/api/challenges/${c.id}/accept`).set(auth(B.token))).body.match;
    assert.equal(m.status, 'MATCHED');
    const va = await view(A.token, m.id);
    const meA = va.players.find((p) => p.userId === A.user.id);
    assert.equal(va.players.find((p) => p.userId === B.user.id).lockedIn, true);
    assert.equal(meA.lockedIn, false);
    assert.equal(meA.owesAction, true);
    assert.ok(va.timers.playerActionDeadline && va.timers.lockInDeadline);
    assert.ok(secondsFromNow(va.timers.myDeadline) <= Math.min(T.playerActionSeconds, T.lockInSeconds) + 1);
  });
});

describe('Lock-in timer (skill games: both players must press Lock In after matching)', () => {
  test('if a player never locks in: cancelled as LOCK_IN_TIMEOUT, both refunded in full, nobody charged the fee; a late Lock In is refused', async () => {
    const A = await newPlayer('liA');
    const B = await newPlayer('liB');
    const m = await skillPair(A, B, 20);
    assert.ok(m.timers.lockInDeadline);
    await api().post(`/api/matches/${m.id}/ready`).set(auth(B.token));
    await query('UPDATE matches SET player_action_deadline = ?, lock_in_deadline = ? WHERE id = ?', [past(5000), past(5000), m.id]);
    const late = await api().post(`/api/matches/${m.id}/ready`).set(auth(A.token));
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'LOCK_IN_EXPIRED');
    await sweepMatches();
    const v = await view(B.token, m.id);
    assert.equal(v.status, 'CANCELLED');
    assert.equal(v.endReason, 'LOCK_IN_TIMEOUT');
    assert.match(v.cancelReason, /did not lock in/);
    for (const P of [A, B]) assert.deepEqual([(await wallet(P.token)).available, (await wallet(P.token)).locked], [250, 0]);
    assert.equal((await txs(m.id, 'ABANDONMENT_FEE')).length, 0);
    const row = (await api().get('/api/matches').set(auth(B.token))).body.items.find((h) => h.id === m.id);
    assert.equal(row.displayState, 'TIMED_OUT');
  });

  test('leaving before both players locked in is free for everyone', async () => {
    const A = await newPlayer('lfA');
    const B = await newPlayer('lfB');
    const m = await skillPair(A, B, 20);
    await api().post(`/api/matches/${m.id}/ready`).set(auth(B.token));
    const leave = await api().post(`/api/matches/${m.id}/cancel`).set(auth(A.token));
    assert.equal(leave.body.match.status, 'CANCELLED');
    assert.equal((await wallet(A.token)).available, 250);
    assert.equal((await wallet(B.token)).available, 250);
    assert.equal((await txs(m.id, 'ABANDONMENT_FEE')).length, 0);
  });

  test('leaving a LOCKED skill game before anyone starts costs the leaver the fee (both stakes refunded)', async () => {
    const A = await newPlayer('lsA');
    const B = await newPlayer('lsB');
    const m = await skillPair(A, B, 20);
    await api().post(`/api/matches/${m.id}/ready`).set(auth(A.token));
    await api().post(`/api/matches/${m.id}/ready`).set(auth(B.token));
    const leave = await api().post(`/api/matches/${m.id}/cancel`).set(auth(B.token));
    assert.equal(leave.body.match.status, 'CANCELLED');
    assert.equal((await wallet(B.token)).available, 250 - FEE);
    assert.equal((await wallet(A.token)).available, 250);
  });

  test('a WAITING football challenge still open at kickoff is closed with a full refund (never goes live)', async () => {
    const A = await newPlayer('koA');
    const fixtureId = await makeFixture({ kickoffMs: 60000 });
    const { match } = await openChallenge(A, { fixtureId });
    await query('UPDATE football_fixtures SET kickoff_at = ? WHERE id = ?', [past(), fixtureId]);
    await transitionAndExpireAtKickoff();
    const v = await view(A.token, match.id);
    assert.equal(v.status, 'CANCELLED');
    assert.equal(v.endReason, 'NO_OPPONENT');
    assert.equal((await wallet(A.token)).available, 250);
  });
});

describe('Leaving a LOCKED challenge', () => {
  test('two simultaneous Leave requests charge the fee exactly once, only to the leaver', async () => {
    const A = await newPlayer('l2A');
    const B = await newPlayer('l2B');
    const { match } = await openChallenge(A);
    await api().post(`/api/football/open-challenges/${match.id}/join`).set(auth(B.token));
    const [r1, r2] = await Promise.all([
      api().post(`/api/matches/${match.id}/cancel`).set(auth(A.token)),
      api().post(`/api/matches/${match.id}/cancel`).set(auth(A.token)),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    const fee = await txs(match.id, 'ABANDONMENT_FEE');
    assert.equal(fee.length, 1);
    assert.equal(fee[0].user_id, A.user.id);
    assert.equal(Number(fee[0].amount), FEE);
    assert.equal((await wallet(A.token)).available, 250 - FEE);
    assert.equal((await wallet(B.token)).available, 250);
    const v = await view(B.token, match.id);
    assert.equal(v.endReason, 'ABANDONED');
    assert.equal(v.abandonedBy, A.user.id);
    const rowA = (await api().get('/api/matches').set(auth(A.token))).body.items.find((h) => h.id === match.id);
    const rowB = (await api().get('/api/matches').set(auth(B.token))).body.items.find((h) => h.id === match.id);
    assert.equal(rowA.displayState, 'LEFT');
    assert.equal(rowB.displayState, 'OPPONENT_LEFT');
  });
});

describe('Reconnection window', () => {
  test('dropping before the lock-in deadline defers the timeout; reconnecting inside the window still lets the player lock in', async () => {
    const A = await newPlayer('rcA');
    const B = await newPlayer('rcB');
    const m = await skillPair(A, B, 10);
    await api().post(`/api/matches/${m.id}/ready`).set(auth(B.token));
    // A's connection dropped 5s ago while they owed Lock In; their deadline passed 1s ago.
    await markPresence(A.user.id, false, past(5000));
    await query('UPDATE matches SET player_action_deadline = ?, lock_in_deadline = ? WHERE id = ?', [past(), past(), m.id]);
    await sweepMatches();
    const v = await view(B.token, m.id);
    assert.equal(v.status, 'MATCHED', 'a player inside their reconnection window must not be timed out');
    const a = v.players.find((p) => p.userId === A.user.id);
    assert.ok(a.reconnectDeadline, 'the opponent can see the reconnection countdown');
    assert.ok(secondsFromNow(a.deadline) > T.reconnectionSeconds - 10, 'their deadline is the end of the window');
    await markPresence(A.user.id, true);
    const lock = await api().post(`/api/matches/${m.id}/ready`).set(auth(A.token));
    assert.equal(lock.status, 200, JSON.stringify(lock.body));
    assert.equal(lock.body.match.status, 'READY');
    assert.equal((await txs(m.id, 'ABANDONMENT_FEE')).length, 0, 'a disconnect never costs the fee');
  });

  test('never coming back: once the window closes the normal timeout outcome applies (no fee)', async () => {
    const A = await newPlayer('ncA');
    const B = await newPlayer('ncB');
    const m = await skillPair(A, B, 10);
    await api().post(`/api/matches/${m.id}/ready`).set(auth(B.token));
    await markPresence(A.user.id, false, past(15000));
    await query('UPDATE matches SET player_action_deadline = ?, lock_in_deadline = ? WHERE id = ?', [past(10000), past(10000), m.id]);
    await query('UPDATE match_players SET reconnect_deadline = ? WHERE match_id = ? AND user_id = ?', [past(), m.id, A.user.id]);
    await sweepMatches();
    const v = await view(B.token, m.id);
    assert.equal(v.status, 'CANCELLED');
    assert.equal(v.endReason, 'LOCK_IN_TIMEOUT');
    assert.equal((await txs(m.id, 'ABANDONMENT_FEE')).length, 0);
  });

  test('repeated drops cannot stack extensions', async () => {
    const A = await newPlayer('stA');
    const B = await newPlayer('stB');
    const match = await skillPair(A, B, 10);
    await markPresence(A.user.id, false);
    const first = (await queryOne('SELECT reconnect_deadline FROM match_players WHERE match_id = ? AND user_id = ?', [match.id, A.user.id])).reconnect_deadline;
    await markPresence(A.user.id, true);
    await new Promise((r) => setTimeout(r, 1100));
    await markPresence(A.user.id, false);
    const second = (await queryOne('SELECT reconnect_deadline FROM match_players WHERE match_id = ? AND user_id = ?', [match.id, A.user.id])).reconnect_deadline;
    assert.equal(new Date(second).getTime(), new Date(first).getTime());
  });
});

describe('Two-player end-to-end: skill game with game + player-action timers', () => {
  test('lock in -> both locked -> game timer -> A finishes -> B sees an action timer -> B finishes -> settles, wallets + history update, rematch is a brand-new challenge', async () => {
    const A = await newPlayer('e2A');
    const B = await newPlayer('e2B');
    const m = await skillPair(A, B, 20);
    assert.equal(m.status, 'MATCHED');
    assert.ok(m.timers.lockInDeadline);

    const la = (await api().post(`/api/matches/${m.id}/ready`).set(auth(A.token))).body.match;
    assert.equal(la.status, 'MATCHED');
    const vb = await view(B.token, m.id);
    assert.ok(vb.timers.playerActionDeadline, 'B is now on the player-action timer to lock in');
    assert.equal(vb.players.find((p) => p.userId === B.user.id).owesAction, true);

    const locked = (await api().post(`/api/matches/${m.id}/ready`).set(auth(B.token))).body.match;
    assert.equal(locked.status, 'READY');
    assert.ok(locked.lockedAt);
    const gs = secondsFromNow(locked.timers.completionDeadline);
    assert.ok(gs > T.lockedGameSeconds - 5 && gs <= T.lockedGameSeconds + 1, 'the game timer starts when both are locked in');
    assert.equal(locked.timers.playerActionDeadline, null);

    const sa = (await api().post(`/api/matches/${m.id}/start`).set(auth(A.token))).body;
    assert.equal(new Date(sa.deadline).getTime(), new Date(locked.timers.completionDeadline).getTime());
    await backdateStart(m.id, A.user.id);
    const ra = await api().post(`/api/matches/${m.id}/result`).set(auth(A.token)).send({ actions: FAST });
    assert.equal(ra.body.match.status, 'IN_PROGRESS');

    const waitB = await view(B.token, m.id);
    const as = secondsFromNow(waitB.timers.playerActionDeadline);
    assert.ok(as > T.playerActionSeconds - 5 && as <= Math.min(T.playerActionSeconds, T.lockedGameSeconds) + 1);
    assert.equal(new Date(waitB.timers.myDeadline).getTime(), new Date(waitB.timers.playerActionDeadline).getTime(), "B's own deadline is the action deadline");
    const waitA = await view(A.token, m.id);
    assert.equal(waitA.players.find((p) => p.userId === A.user.id).owesAction, false);

    await api().post(`/api/matches/${m.id}/start`).set(auth(B.token));
    await backdateStart(m.id, B.user.id);
    const rb = await api().post(`/api/matches/${m.id}/result`).set(auth(B.token)).send({ actions: SLOW });
    assert.equal(rb.body.match.status, 'COMPLETED');
    assert.equal(rb.body.match.winnerId, A.user.id);

    assert.equal((await wallet(A.token)).available, 250 - 20 + 36);
    assert.equal((await wallet(B.token)).available, 230);
    const histA = (await api().get('/api/matches').set(auth(A.token))).body.items.find((h) => h.id === m.id);
    const histB = (await api().get('/api/matches').set(auth(B.token))).body.items.find((h) => h.id === m.id);
    assert.equal(histA.displayState, 'WON');
    assert.equal(histB.displayState, 'LOST');

    // Rematch = a completely new challenge -> new match, new transactions, new settlement.
    const re = await api().post('/api/challenges').set(auth(A.token)).send({ opponent: B.user.username, gameId: await gameId('reaction-rush'), stake: 10 });
    assert.equal(re.status, 201);
    const acc = (await api().post(`/api/challenges/${re.body.challenge.id}/accept`).set(auth(B.token))).body.match;
    assert.notEqual(acc.id, m.id);
    assert.notEqual(acc.code, m.code);
    assert.equal(acc.stake, 10);
    assert.equal((await query('SELECT * FROM transactions WHERE match_id = ?', [acc.id])).length, 2, 'only the two new entries so far');
    assert.equal(await queryOne('SELECT id FROM settlements WHERE match_id = ?', [acc.id]), null);
  });

  test('Player B never finishes: when the action timer runs out B forfeits (no fee) and A is paid', async () => {
    const A = await newPlayer('nfA');
    const B = await newPlayer('nfB');
    const m = await skillPair(A, B, 10);
    await api().post(`/api/matches/${m.id}/ready`).set(auth(A.token));
    await api().post(`/api/matches/${m.id}/ready`).set(auth(B.token));
    await api().post(`/api/matches/${m.id}/start`).set(auth(A.token));
    await backdateStart(m.id, A.user.id);
    await api().post(`/api/matches/${m.id}/result`).set(auth(A.token)).send({ actions: FAST });
    await api().post(`/api/matches/${m.id}/start`).set(auth(B.token));
    await query('UPDATE matches SET player_action_deadline = ? WHERE id = ?', [past(10000), m.id]);

    // Submitting after the deadline is refused even if the client says it's still in time.
    const lateSubmit = await api().post(`/api/matches/${m.id}/result`).set(auth(B.token)).send({ actions: FAST, clientElapsedMs: 1000, remainingMs: 60000, deadline: new Date(Date.now() + 60000) });
    assert.equal(lateSubmit.status, 409);
    assert.equal(lateSubmit.body.error.code, 'MATCH_TIMED_OUT');

    await Promise.all([sweepMatches(), sweepMatches()]);
    const v = await view(A.token, m.id);
    assert.equal(v.status, 'COMPLETED');
    assert.equal(v.winnerId, A.user.id);
    assert.equal(v.endReason, 'ACTION_TIMEOUT');
    assert.equal((await txs(m.id, 'GAME_WIN')).length, 1, 'paid exactly once despite duplicate sweeps');
    assert.equal((await txs(m.id, 'ABANDONMENT_FEE')).length, 0);
    assert.equal((await wallet(A.token)).available, 250 - 10 + 18);
    assert.equal((await wallet(B.token)).available, 240);
  });

  test('neither player finishes before the game timer: cancelled, both refunded, no fee; late API calls are refused', async () => {
    const A = await newPlayer('gtA');
    const B = await newPlayer('gtB');
    const m = await skillPair(A, B, 10);
    await api().post(`/api/matches/${m.id}/ready`).set(auth(A.token));
    await api().post(`/api/matches/${m.id}/ready`).set(auth(B.token));
    await query('UPDATE matches SET completion_deadline = ? WHERE id = ?', [past(), m.id]);
    const start = await api().post(`/api/matches/${m.id}/start`).set(auth(A.token));
    assert.equal(start.status, 409);
    assert.equal(start.body.error.code, 'MATCH_TIMED_OUT');
    await sweepMatches();
    const v = await view(A.token, m.id);
    assert.equal(v.status, 'CANCELLED');
    assert.equal(v.endReason, 'GAME_TIMEOUT');
    for (const P of [A, B]) assert.equal((await wallet(P.token)).available, 250);
    const afterward = await api().post(`/api/matches/${m.id}/ready`).set(auth(A.token));
    assert.equal(afterward.status, 409);
  });

  test('a disconnected player inside their reconnection window is not forfeited; the forfeit applies once it closes', async () => {
    const A = await newPlayer('dgA');
    const B = await newPlayer('dgB');
    const m = await skillPair(A, B, 10);
    await api().post(`/api/matches/${m.id}/ready`).set(auth(A.token));
    await api().post(`/api/matches/${m.id}/ready`).set(auth(B.token));
    await api().post(`/api/matches/${m.id}/start`).set(auth(A.token));
    await backdateStart(m.id, A.user.id);
    await api().post(`/api/matches/${m.id}/result`).set(auth(A.token)).send({ actions: FAST });
    await markPresence(B.user.id, false, past(5000)); // dropped before the deadline
    await query('UPDATE matches SET player_action_deadline = ? WHERE id = ?', [past(), m.id]);
    await sweepMatches();
    assert.equal((await view(A.token, m.id)).status, 'IN_PROGRESS');
    await query('UPDATE match_players SET reconnect_deadline = ? WHERE match_id = ? AND user_id = ?', [past(), m.id, B.user.id]);
    await sweepMatches();
    const v = await view(A.token, m.id);
    assert.equal(v.status, 'COMPLETED');
    assert.equal(v.winnerId, A.user.id);
  });
});

describe('Two-player end-to-end: football', () => {
  test('Find Opponent (creator locks in) -> Open Challenges -> Join (Accept & Lock In) -> LOCKED -> kickoff -> live -> full time -> settled, wallets/history/profile/rivalry updated', async () => {
    const A = await newPlayer('fbA');
    const B = await newPlayer('fbB');
    const fixtureId = await makeFixture({ kickoffMs: 90 * 60000 });
    const { match } = await openChallenge(A, { fixtureId, slug: 'more_shots', pick: 'HOME', stake: 20 });

    const open = (await api().get('/api/football/open-challenges').set(auth(B.token))).body.challenges.find((c) => c.matchId === match.id);
    assert.match(open.challengeType.question, /more shots/);
    assert.equal(open.creator.username, A.user.username);

    assert.equal((await view(A.token, match.id)).players[0].lockedIn, true, 'the creator locked in when creating it');

    const joined = (await api().post(`/api/football/open-challenges/${match.id}/join`).set(auth(B.token))).body.match;
    assert.equal(joined.status, 'READY', 'both locked in -> LOCKED');
    assert.ok(!(await api().get('/api/football/open-challenges').set(auth(A.token))).body.challenges.some((c) => c.matchId === match.id));
    assert.ok(!(await api().get('/api/football/open-challenges').set(auth(B.token))).body.challenges.some((c) => c.matchId === match.id));

    const locked = await view(A.token, match.id);
    assert.equal(locked.status, 'READY');
    assert.ok(locked.players.every((p) => p.lockedIn));
    assert.equal(new Date(locked.timers.kickoffAt).getTime() > Date.now(), true);
    const expectedDeadline = new Date(locked.timers.kickoffAt).getTime() + T.footballResultTimeoutMinutes * 60000;
    assert.equal(new Date(locked.timers.completionDeadline).getTime(), expectedDeadline);

    // Kickoff: the locked challenge goes live.
    await query('UPDATE football_fixtures SET kickoff_at = ?, status = ? WHERE id = ?', [past(60000), 'LIVE', fixtureId]);
    await transitionAndExpireAtKickoff();
    const live = await view(B.token, match.id);
    assert.equal(live.status, 'IN_PROGRESS');
    const leave = await api().post(`/api/matches/${match.id}/cancel`).set(auth(B.token));
    assert.equal(leave.status, 409, 'nobody can leave once the real match has kicked off');

    // Full time: Arsenal (A's pick) had more shots.
    await query(`UPDATE football_fixtures SET status = 'FINISHED', home_score = 1, away_score = 1, home_shots = 14, away_shots = 9, stats_available = 1 WHERE id = ?`, [fixtureId]);
    await Promise.all([settleMatchesForFixture(fixtureId), settleMatchesForFixture(fixtureId)]);
    const done = await view(A.token, match.id);
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.winnerId, A.user.id);
    assert.equal(done.football.stats.shots.home, 14);
    assert.equal((await query('SELECT * FROM settlements WHERE match_id = ?', [match.id])).length, 1, 'duplicate settlement requests settle once');
    assert.equal((await wallet(A.token)).available, 250 - 20 + 36);
    assert.equal((await wallet(B.token)).available, 230);

    const rowA = (await api().get('/api/matches').query({ category: 'FOOTBALL' }).set(auth(A.token))).body.items.find((h) => h.id === match.id);
    assert.equal(rowA.displayState, 'WON');
    assert.equal(rowA.football.myPickLabel, 'Arsenal');
    assert.equal(rowA.football.opponentPickLabel, 'Chelsea');

    const prof = (await api().get(`/api/users/${B.user.username}`).set(auth(A.token))).body;
    assert.equal(prof.stats.losses, 1);
    assert.equal(prof.stats.h2hScore, 1000 - 15);
    assert.equal(prof.rivalry.played, 1);
    assert.equal(prof.rivalry.myWins, 1);
    assert.equal(prof.rivalry.theirWins, 0);
  });

  test('a locked challenge whose result never becomes verifiable is voided at its deadline — full refunds, zero fee', async () => {
    const A = await newPlayer('rtA');
    const B = await newPlayer('rtB');
    const { match, fixtureId } = await openChallenge(A);
    await api().post(`/api/football/open-challenges/${match.id}/join`).set(auth(B.token));
    await api().post(`/api/matches/${match.id}/ready`).set(auth(A.token));
    await query('UPDATE football_fixtures SET kickoff_at = ? WHERE id = ?', [past(T.footballResultTimeoutMinutes * 60000 + 5000), fixtureId]);
    await sweepMatches();
    const v = await view(A.token, match.id);
    assert.equal(v.status, 'VOID');
    assert.equal(v.endReason, 'RESULT_TIMEOUT');
    for (const P of [A, B]) assert.equal((await wallet(P.token)).available, 250);
    const s = await queryOne('SELECT * FROM settlements WHERE match_id = ?', [match.id]);
    assert.equal(Number(s.fee_amount), 0);
  });
});

describe('Server restart during an active timer', () => {
  test('running timers are extended by the outage; ones that had already expired before it are not', async () => {
    const A = await newPlayer('srA');
    const B = await newPlayer('srB');
    const { match: running } = await openChallenge(A);
    const { match: expired } = await openChallenge(B);
    const beforeRunning = new Date(running.timers.acceptanceDeadline).getTime();
    const lastBeat = new Date(Date.now() - 10 * 60000); // server "died" 10 minutes ago
    await query('UPDATE matches SET acceptance_deadline = ? WHERE id = ?', [new Date(lastBeat.getTime() - 1000), expired.id]);
    await heartbeat(lastBeat);
    const gap = await compensateDowntime({ now: new Date() });
    assert.ok(gap >= 599 && gap <= 601, `gap ~600s, got ${gap}`);
    const after = await view(A.token, running.id);
    assert.ok(new Date(after.timers.acceptanceDeadline).getTime() - beforeRunning >= 599000);
    await sweepMatches();
    assert.equal((await view(A.token, running.id)).status, 'WAITING');
    assert.equal((await view(B.token, expired.id)).status, 'CANCELLED', 'expired before the outage -> still expires');
    // A normal restart (fresh heartbeat) changes nothing.
    await heartbeat();
    assert.equal(await compensateDowntime(), 0);
  });
});
