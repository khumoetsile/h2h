// Live penalty shootout: the pure rules, then real matches through the HTTP API
// against MySQL (sealed choices, a full shootout, timeouts, forfeits, bots).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rivalis_test';

const rules = await import('../src/games/liveShootout.js');
const { migrate } = await import('../scripts/migrate.js');
const { seed } = await import('../scripts/seed.js');
const { createApp } = await import('../src/app.js');
const { pool, query, queryOne } = await import('../src/db.js');
const { sweepLiveShootouts } = await import('../src/services/liveShootoutService.js');
const request = (await import('supertest')).default;

// ---------------------------------------------------------------------------
// Rules (no database)
// ---------------------------------------------------------------------------

const K = (kickerId, outcome) => ({ kickerId, outcome });
/** Alternate A, B, A, B... with the given outcome strings, e.g. ['G','M','G'...] */
function kicksFrom(a, b, outcomesA, outcomesB) {
  const out = [];
  const L = Math.max(outcomesA.length, outcomesB.length);
  const map = { G: 'GOAL', S: 'SAVED', M: 'MISSED' };
  for (let i = 0; i < L; i++) {
    if (outcomesA[i]) out.push(K(a, map[outcomesA[i]]));
    if (outcomesB[i]) out.push(K(b, map[outcomesB[i]]));
  }
  return out;
}

describe('shootout rules', () => {
  test('timing bar: a perfect high shot is unsavable, a low shot is saved by the exact zone only', () => {
    const p = { periodMs: 2000, phase: 0 }; // marker is at the exact centre at t = 500
    assert.equal(rules.markerAt(2000, 0, 500), 0.5);
    const perfectHigh = rules.resolveKick({ zone: 0, stopMs: 500, keeperZone: 0 }, p); // top-left, keeper dives there
    assert.deepEqual([perfectHigh.outcome, perfectHigh.quality], ['GOAL', 'PERFECT']);
    const lowSaved = rules.resolveKick({ zone: 3, stopMs: 500, keeperZone: 3 }, p);
    assert.deepEqual([lowSaved.outcome, lowSaved.quality], ['SAVED', 'GOOD']);
    const lowGoal = rules.resolveKick({ zone: 3, stopMs: 500, keeperZone: 5 }, p);
    assert.equal(lowGoal.outcome, 'GOAL');
  });

  test('height matters: a keeper in the same column but the wrong row does not save it', () => {
    const p = { periodMs: 2000, phase: 0 };
    assert.equal(rules.resolveKick({ zone: 4, stopMs: 500, keeperZone: 1 }, p).outcome, 'GOAL'); // shot low centre, keeper high centre
    assert.equal(rules.resolveKick({ zone: 1, stopMs: 350, keeperZone: 4 }, p).outcome, 'GOAL'); // shot high centre, keeper low centre
    assert.equal(rules.resolveKick({ zone: 4, stopMs: 500, keeperZone: 4 }, p).outcome, 'SAVED');
  });

  test('timing bar: high shots need a better stop than low shots; a very bad stop (or no shot) is a miss', () => {
    const p = { periodMs: 2000, phase: 0 };
    // t = 350 -> marker .35 (off .15): fine for high (<= .2) but not perfect
    assert.equal(rules.resolveKick({ zone: 1, stopMs: 350, keeperZone: 1 }, p).outcome, 'SAVED');
    // t = 200 -> marker .2 (off .3): too far for a high shot, still OK for a low one
    assert.equal(rules.resolveKick({ zone: 1, stopMs: 200, keeperZone: 0 }, p).outcome, 'MISSED');
    assert.equal(rules.resolveKick({ zone: 4, stopMs: 200, keeperZone: 0 }, p).outcome, 'GOAL');
    // t = 0 -> marker 0 (off .5): misses everything
    assert.equal(rules.resolveKick({ zone: 4, stopMs: 0, keeperZone: 0 }, p).outcome, 'MISSED');
    // kicker never shot
    const none = rules.resolveKick({ zone: null, stopMs: null, keeperZone: 0 }, p);
    assert.deepEqual([none.outcome, none.quality], ['MISSED', 'NONE']);
  });

  test('roles alternate and the first kicker comes from the seed', () => {
    for (const seedValue of [1, 2, 3, 12345, 4000000000]) {
      const first = rules.firstKickerSlot(seedValue);
      assert.ok(first === 1 || first === 2);
      assert.equal(rules.kickerSlotFor(seedValue, 1), first);
      assert.notEqual(rules.kickerSlotFor(seedValue, 2), first);
      assert.equal(rules.kickerSlotFor(seedValue, 3), first);
    }
    const a = rules.roundParams(99, 4);
    assert.deepEqual(a, rules.roundParams(99, 4)); // deterministic
    assert.ok(a.periodMs >= 1900 && a.periodMs <= 2500 && a.phase >= 0 && a.phase <= 1);
  });

  test('standing: ends early once the other side cannot catch up', () => {
    // A: G G G, B: M M M -> 3-0 with two kicks left each: decided
    let s = rules.standing(kicksFrom(1, 2, 'GGG', 'MMM'), 1, 2);
    assert.deepEqual([s.done, s.winnerId], [true, 1]);
    // after A's 3rd kick but before B's 3rd: B still has 3 left, 3-0 is not enough yet
    s = rules.standing(kicksFrom(1, 2, 'GGG', 'MM'), 1, 2);
    assert.equal(s.done, false);
    // B ahead after A has taken all five
    s = rules.standing(kicksFrom(1, 2, 'MMMMM', 'GGGG'), 1, 2);
    assert.deepEqual([s.done, s.winnerId], [true, 2]);
  });

  test('standing: level after five each goes to sudden death, decided on equal kicks only', () => {
    let s = rules.standing(kicksFrom(1, 2, 'GGMGM', 'GMGGM'), 1, 2); // 3-3
    assert.deepEqual([s.done, s.suddenDeath], [false, true]);
    s = rules.standing(kicksFrom(1, 2, 'GGMGMG', 'GMGGM'), 1, 2); // A has taken a 6th kick and scored, B has not replied
    assert.equal(s.done, false);
    s = rules.standing(kicksFrom(1, 2, 'GGMGMG', 'GMGGMM'), 1, 2); // B misses the reply: A wins
    assert.deepEqual([s.done, s.winnerId], [true, 1]);
    s = rules.standing(kicksFrom(1, 2, 'GGMGMG', 'GMGGMG'), 1, 2); // both score: still level
    assert.equal(s.done, false);
  });

  test('standing: a shootout still level at the cap is a draw', () => {
    const all = 'G'.repeat(rules.MAX_KICKS_EACH);
    const s = rules.standing(kicksFrom(1, 2, all, all), 1, 2);
    assert.deepEqual([s.done, s.winnerId], [true, null]);
  });

  test('bots always produce legal choices', () => {
    for (let r = 1; r <= 20; r++) {
      const params = rules.roundParams(777, r);
      const k = rules.botKick(777, r, params);
      assert.ok(Number.isInteger(k.zone) && k.zone >= 0 && k.zone < rules.ZONES);
      assert.ok(k.stopMs >= 600 && k.stopMs < 4000);
      const d = rules.botDive(777, r);
      assert.ok(Number.isInteger(d) && d >= 0 && d < rules.ZONES);
      assert.ok(Number.isInteger(rules.autoKeeperZone(777, r)) && rules.autoKeeperZone(777, r) < rules.ZONES);
    }
  });
});

// ---------------------------------------------------------------------------
// Live matches over the API
// ---------------------------------------------------------------------------

const app = createApp();
const api = () => request(app);
const quiet = () => {};
const auth = (t) => ({ Authorization: `Bearer ${t}` });

let n = 0;
async function newPlayer(prefix = 'ls') {
  n += 1;
  const u = `${prefix}${Date.now().toString(36)}${n}`.slice(0, 20);
  const res = await api().post('/api/auth/register').send({
    firstName: 'Test', lastName: 'Player', username: u, email: `${u}@test.dev`, phone: '+267 71 234 567',
    password: 'Secret123', confirmPassword: 'Secret123',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { token: res.body.token, user: res.body.user };
}
const walletOf = async (t) => (await api().get('/api/wallet').set(auth(t))).body.wallet;
const gameId = async () => (await queryOne("SELECT id FROM games WHERE slug = 'penalty-shootout'")).id;

/** Two new players, a locked-in penalty-shootout match, both still off the pitch. */
async function lockedMatch(stake = 20) {
  const A = await newPlayer('la');
  const B = await newPlayer('lb');
  const created = await api().post('/api/matches').set(auth(A.token)).send({ gameId: await gameId(), stake });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.match.id;
  assert.equal((await api().post(`/api/matches/${id}/join`).set(auth(B.token))).status, 200);
  assert.equal((await api().post(`/api/matches/${id}/ready`).set(auth(A.token))).status, 200);
  const r = await api().post(`/api/matches/${id}/ready`).set(auth(B.token));
  assert.equal(r.body.match.status, 'READY');
  const m = await queryOne('SELECT * FROM matches WHERE id = ?', [id]);
  return { id, code: m.code, seed: m.seed, A, B, byId: { [A.user.id]: A, [B.user.id]: B } };
}

const live = (t, code) => api().get(`/api/matches/${code}/live`).set(auth(t));
const stateOf = async (t, code) => (await live(t, code)).body.state;

/** Take the pitch with both players; returns A's view of round 1. */
async function bothJoin(M) {
  const a = await api().post(`/api/matches/${M.code}/live/join`).set(auth(M.A.token));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.state.phase, 'LOBBY');
  const b = await api().post(`/api/matches/${M.code}/live/join`).set(auth(M.B.token));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.state.phase, 'ROUND');
  return b.body.state;
}

/** Open the current round's window as if it started `agoMs` ago (so tests don't wait for real delays). */
async function openWindow(matchId, agoMs = 100) {
  const start = new Date(Date.now() - agoMs);
  await query('UPDATE shootout_rounds SET starts_at = ?, deadline = ? WHERE match_id = ? AND resolved_at IS NULL', [start, new Date(start.getTime() + rules.DECISION_MS), matchId]);
}

/** A stop time (ms into the round) at which the marker is within `maxOff` of the centre / at least `minOff` away. */
function stopWhere(params, { maxOff = 1, minOff = 0 }) {
  for (let t = 300; t < 6000; t += 5) {
    const off = Math.abs(rules.markerAt(params.periodMs, params.phase, t) - 0.5);
    if (off <= maxOff && off >= minOff) return t;
  }
  throw new Error('no stop time found');
}

/**
 * Play the open round: `scorer` always scores when kicking (low zone, perfect strike,
 * keeper dives elsewhere); the other player always misses when kicking.
 */
async function playScoringRound(M, scorerId) {
  const view = await stateOf(M.A.token, M.code);
  const cur = view.current;
  const kicker = M.byId[cur.kickerId];
  const keeper = M.byId[cur.keeperId];
  const params = rules.roundParams(M.seed, cur.no);
  if (cur.kickerId === scorerId) {
    const t = stopWhere(params, { maxOff: 0.05 });
    await openWindow(M.id, t + 100);
    const zone = 3 + 1; // low centre
    const k = await api().post(`/api/matches/${M.code}/live/kick`).set(auth(kicker.token)).send({ zone, stopMs: t });
    assert.equal(k.status, 200, JSON.stringify(k.body));
    const d = await api().post(`/api/matches/${M.code}/live/dive`).set(auth(keeper.token)).send({ zone: 0 });
    assert.equal(d.status, 200, JSON.stringify(d.body));
  } else {
    const t = stopWhere(params, { minOff: 0.42 });
    await openWindow(M.id, t + 100);
    assert.equal((await api().post(`/api/matches/${M.code}/live/kick`).set(auth(kicker.token)).send({ zone: 3, stopMs: t })).status, 200);
    assert.equal((await api().post(`/api/matches/${M.code}/live/dive`).set(auth(keeper.token)).send({ zone: 1 })).status, 200);
  }
}

before(async () => {
  await migrate({ fresh: true, log: quiet });
  await seed({ log: quiet });
});
after(async () => { await pool.end(); });

describe('live shootout: choices are sealed and only the right player can act', () => {
  test('the opponent only learns that you have locked in, never what you chose; roles swap after each kick', async () => {
    const M = await lockedMatch();
    const s0 = await bothJoin(M);
    assert.equal(s0.current.no, 1);
    const kickerId = s0.current.kickerId;
    const kicker = M.byId[kickerId];
    const keeper = M.byId[s0.current.keeperId];
    assert.equal(s0.firstKickerId, kickerId);

    // Only the kicker is handed the timing bar.
    assert.ok((await stateOf(kicker.token, M.code)).current.timing);
    assert.equal((await stateOf(keeper.token, M.code)).current.timing, null);

    // The window has not opened yet: choices are refused.
    const early = await api().post(`/api/matches/${M.code}/live/kick`).set(auth(kicker.token)).send({ zone: 4, stopMs: 500 });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'ROUND_NOT_STARTED');

    await openWindow(M.id, 700);
    // The keeper cannot shoot, the kicker cannot keep goal.
    assert.equal((await api().post(`/api/matches/${M.code}/live/kick`).set(auth(keeper.token)).send({ zone: 4, stopMs: 500 })).status, 403);
    assert.equal((await api().post(`/api/matches/${M.code}/live/dive`).set(auth(kicker.token)).send({ zone: 1 })).status, 403);
    // Bad input is rejected.
    assert.equal((await api().post(`/api/matches/${M.code}/live/kick`).set(auth(kicker.token)).send({ zone: 9, stopMs: 500 })).status, 400);

    const shot = await api().post(`/api/matches/${M.code}/live/kick`).set(auth(kicker.token)).send({ zone: 4, stopMs: 650 });
    assert.equal(shot.status, 200, JSON.stringify(shot.body));
    // What the keeper can see now: the kicker has locked in, nothing more.
    const seen = await live(keeper.token, M.code);
    const sv = seen.body.state;
    assert.equal(sv.current.opponentLocked, true);
    assert.equal(sv.current.myLocked, false);
    assert.equal(sv.history.length, 0);
    const raw = JSON.stringify(seen.body);
    assert.ok(!raw.includes('"zone":4'), 'the kicker\'s zone must not reach the keeper');
    // Locking in twice is harmless.
    assert.equal((await api().post(`/api/matches/${M.code}/live/kick`).set(auth(kicker.token)).send({ zone: 1, stopMs: 650 })).status, 200);
    assert.equal((await stateOf(kicker.token, M.code)).myChoice.zone, 4);

    const dive = await api().post(`/api/matches/${M.code}/live/dive`).set(auth(keeper.token)).send({ zone: 2 });
    assert.equal(dive.status, 200, JSON.stringify(dive.body));
    const after = dive.body.state;
    assert.equal(after.history.length, 1);
    assert.equal(after.history[0].zone, 4);
    assert.equal(after.history[0].keeperZone, 2);
    assert.ok(['GOAL', 'SAVED', 'MISSED'].includes(after.history[0].outcome));
    // Next kick: the roles have swapped.
    assert.equal(after.current.no, 2);
    assert.equal(after.current.kickerId, keeper.user.id);
    assert.equal(after.current.keeperId, kickerId);
    // A stranger can't read it.
    const stranger = await newPlayer('xx');
    assert.equal((await live(stranger.token, M.code)).status, 403);
  });
});

describe('live shootout: a full match', () => {
  test('one side always scores, the other always misses: decided early, winner paid, loser charged, results recorded', async () => {
    const M = await lockedMatch(20);
    await bothJoin(M);
    const scorer = M.A; // A is the player who always scores
    const before = [await walletOf(M.A.token), await walletOf(M.B.token)];

    let state = await stateOf(M.A.token, M.code);
    let rounds = 0;
    while (!state.done && rounds < 20) {
      await playScoringRound(M, scorer.user.id);
      rounds += 1;
      state = await stateOf(M.A.token, M.code);
    }
    assert.equal(state.done, true);
    assert.equal(state.winnerId, scorer.user.id);
    assert.equal(rounds, 6, 'A 3-0 up after three kicks each cannot be caught');
    assert.equal(state.goals[M.A.user.id], 3);
    assert.equal(state.goals[M.B.user.id], 0);

    const m = await queryOne('SELECT * FROM matches WHERE id = ?', [M.id]);
    assert.equal(m.status, 'COMPLETED');
    assert.equal(m.winner_id, scorer.user.id);
    assert.match(m.result_reason, /Won the shootout 3-0/);
    const results = await query('SELECT user_id, score, is_valid FROM game_results WHERE match_id = ? ORDER BY user_id', [M.id]);
    assert.equal(results.length, 2);
    assert.deepEqual(Object.fromEntries(results.map((r) => [r.user_id, r.score])), { [M.A.user.id]: 3, [M.B.user.id]: 0 });

    // 20 stake each: pool 40, 10% fee, prize 36. The winner is credited the prize and their stake is
    // released from the lock; the loser's locked stake is forfeited and nothing else moves.
    const afterA = await walletOf(M.A.token);
    const afterB = await walletOf(M.B.token);
    assert.equal(afterA.available - before[0].available, Number(m.prize));
    assert.equal(afterA.locked, before[0].locked - 20);
    assert.equal(afterB.available, before[1].available);
    assert.equal(afterB.locked, before[1].locked - 20);

    // Everything now refuses further moves.
    const late = await api().post(`/api/matches/${M.code}/live/dive`).set(auth(M.B.token)).send({ zone: 1 });
    assert.equal(late.status, 409);
    // The finished match view carries the shootout as normal rounds for the result screen.
    const view = await api().get(`/api/matches/${M.code}`).set(auth(M.A.token));
    const meA = view.body.match.players.find((p) => p.userId === M.A.user.id);
    assert.equal(meA.result.score, 3);
    assert.equal(meA.result.summary.goals, 3);
    assert.ok(Array.isArray(meA.result.rounds) && meA.result.rounds.every((r) => ['GOAL', 'SAVED', 'WIDE'].includes(r.status)));
  });
});

describe('live shootout: timeouts and forfeits', () => {
  test('a kick nobody takes is decided by the server: the kicker has missed, the keeper dives at random', async () => {
    const M = await lockedMatch();
    const s0 = await bothJoin(M);
    const keeper = M.byId[s0.current.keeperId];
    await openWindow(M.id, 500);
    // Keeper chooses, kicker freezes.
    assert.equal((await api().post(`/api/matches/${M.code}/live/dive`).set(auth(keeper.token)).send({ zone: 1 })).status, 200);
    // Not due yet.
    assert.equal(await sweepLiveShootouts(new Date()), 0);
    // Past the deadline (plus grace).
    await query('UPDATE shootout_rounds SET deadline = ? WHERE match_id = ? AND resolved_at IS NULL', [new Date(Date.now() - 10000), M.id]);
    assert.ok((await sweepLiveShootouts(new Date())) >= 1);
    const st = await stateOf(keeper.token, M.code);
    assert.equal(st.history.length, 1);
    assert.equal(st.history[0].outcome, 'MISSED');
    assert.equal(st.history[0].quality, 'NONE');
    assert.equal(st.history[0].kickerAuto, true);
    assert.equal(st.current.no, 2, 'the shootout carries on');
  });

  test('a player who lets two kicks in a row be decided for them forfeits; the other is paid, nobody is charged the abandonment fee', async () => {
    const M = await lockedMatch(20);
    const s0 = await bothJoin(M);
    const active = M.byId[s0.current.kickerId]; // acts in both rounds
    const idle = M.byId[s0.current.keeperId];
    const idleBefore = await walletOf(idle.token);
    const fees = async () => (await query("SELECT COUNT(*) AS n FROM transactions WHERE type = 'ABANDONMENT_FEE'"))[0].n;
    const feesBefore = await fees();

    for (let round = 1; round <= 2; round++) {
      const cur = (await stateOf(active.token, M.code)).current;
      await openWindow(M.id, 500);
      const path = cur.kickerId === active.user.id ? 'kick' : 'dive';
      const body = path === 'kick' ? { zone: 4, stopMs: 450 } : { zone: 0 };
      assert.equal((await api().post(`/api/matches/${M.code}/live/${path}`).set(auth(active.token)).send(body)).status, 200);
      await query('UPDATE shootout_rounds SET deadline = ? WHERE match_id = ? AND resolved_at IS NULL', [new Date(Date.now() - 10000), M.id]);
      await sweepLiveShootouts(new Date());
    }
    const m = await queryOne('SELECT * FROM matches WHERE id = ?', [M.id]);
    assert.equal(m.status, 'COMPLETED');
    assert.equal(m.winner_id, active.user.id);
    assert.equal(m.end_reason, 'ACTION_TIMEOUT');
    assert.match(m.result_reason, /stopped playing/);
    assert.equal(await fees(), feesBefore, 'a timeout never charges the abandonment fee');
    const idleAfter = await walletOf(idle.token);
    assert.equal(idleAfter.locked, idleBefore.locked - 20, "the idle player's stake is forfeited");
    assert.equal(idleAfter.available, idleBefore.available, 'and nothing else is taken from them');
    assert.equal((await walletOf(active.token)).locked, 0);
  });

  test('if the opponent never takes the pitch they forfeit', async () => {
    const M = await lockedMatch(20);
    const joined = await api().post(`/api/matches/${M.code}/live/join`).set(auth(M.A.token));
    assert.equal(joined.status, 200);
    assert.equal(joined.body.state.phase, 'LOBBY');
    assert.ok(joined.body.state.lobbyDeadline, 'the waiting player sees when the other runs out of time');
    const m0 = await queryOne('SELECT status, player_action_deadline FROM matches WHERE id = ?', [M.id]);
    assert.equal(m0.status, 'IN_PROGRESS');
    assert.ok(m0.player_action_deadline, 'the other player is on a clock');
    // Not yet due.
    await sweepLiveShootouts(new Date());
    assert.equal((await queryOne('SELECT status FROM matches WHERE id = ?', [M.id])).status, 'IN_PROGRESS');
    await query('UPDATE matches SET player_action_deadline = ? WHERE id = ?', [new Date(Date.now() - 1000), M.id]);
    assert.ok((await sweepLiveShootouts(new Date())) >= 1);
    const m = await queryOne('SELECT * FROM matches WHERE id = ?', [M.id]);
    assert.equal(m.status, 'COMPLETED');
    assert.equal(m.winner_id, M.A.user.id);
    assert.equal(m.end_reason, 'ACTION_TIMEOUT');
  });

  test('if nobody ever takes the pitch the match is cancelled and both are refunded in full', async () => {
    const M = await lockedMatch(20);
    const before = [await walletOf(M.A.token), await walletOf(M.B.token)];
    await query('UPDATE matches SET completion_deadline = ? WHERE id = ?', [new Date(Date.now() - 1000), M.id]);
    assert.ok((await sweepLiveShootouts(new Date())) >= 1);
    const m = await queryOne('SELECT * FROM matches WHERE id = ?', [M.id]);
    assert.equal(m.status, 'CANCELLED');
    assert.equal(m.end_reason, 'GAME_TIMEOUT');
    const after = [await walletOf(M.A.token), await walletOf(M.B.token)];
    assert.equal(after[0].available, before[0].available + 20);
    assert.equal(after[1].available, before[1].available + 20);
    assert.equal(after[0].locked + after[1].locked, 0);
  });

  test('the old solo start/submit endpoints refuse a live game', async () => {
    const M = await lockedMatch();
    const start = await api().post(`/api/matches/${M.code}/start`).set(auth(M.A.token));
    assert.equal(start.status, 409);
    assert.equal(start.body.error.code, 'LIVE_GAME');
  });
});

describe('live shootout: against a house bot', () => {
  test('the bot is always on the pitch, its choices stay sealed, and a whole shootout settles', async () => {
    const A = await newPlayer('hb');
    const created = await api().post('/api/matches').set(auth(A.token)).send({ gameId: await gameId(), stake: 10 });
    const id = created.body.match.id;
    const code = created.body.match.code;
    const bot = await api().post(`/api/matches/${id}/demo-opponent`).set(auth(A.token));
    assert.equal(bot.status, 200, JSON.stringify(bot.body));
    const ready = await api().post(`/api/matches/${id}/ready`).set(auth(A.token));
    assert.equal(ready.body.match.status, 'READY');

    const joined = await api().post(`/api/matches/${code}/live/join`).set(auth(A.token));
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal(joined.body.state.phase, 'ROUND');
    const m = await queryOne('SELECT seed FROM matches WHERE id = ?', [id]);

    let state = joined.body.state;
    for (let guard = 0; guard < 30 && !state.done; guard++) {
      const cur = state.current;
      const params = rules.roundParams(m.seed, cur.no);
      const t = stopWhere(params, { maxOff: 0.05 });
      await openWindow(id, t + 100);
      // The bot may already have locked in; that must not reveal anything.
      const body = cur.role === 'KICKER' ? { zone: 3 + (guard % 3), stopMs: t } : { zone: guard % 6 };
      const path = cur.role === 'KICKER' ? 'kick' : 'dive';
      const r = await api().post(`/api/matches/${code}/live/${path}`).set(auth(A.token)).send(body);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      state = r.body.state;
    }
    assert.equal(state.done, true, 'the shootout reaches a result');
    const done = await queryOne('SELECT * FROM matches WHERE id = ?', [id]);
    assert.equal(done.status, 'COMPLETED');
    const results = await query('SELECT COUNT(*) AS n FROM game_results WHERE match_id = ?', [id]);
    assert.equal(results[0].n, 2);
  });
});

describe('one-tap practice', () => {
  test('creates a locked-in match against a bot in a single call, ready to play', async () => {
    const A = await newPlayer('pr');
    const before = await walletOf(A.token);
    const r = await api().post('/api/matches/practice').set(auth(A.token)).send({ gameId: await gameId(), stake: 10 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const m = r.body.match;
    assert.equal(m.status, 'READY');
    assert.equal(m.players.length, 2);
    assert.ok(m.players.some((p) => p.isBot));
    assert.ok(m.players.every((p) => p.lockedIn), 'both sides are locked in');
    assert.equal((await walletOf(A.token)).locked, before.locked + 10);
    // And it plays straight away.
    const joined = await api().post(`/api/matches/${m.code}/live/join`).set(auth(A.token));
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal(joined.body.state.phase, 'ROUND');
  });

  test('failing part-way leaves nothing behind (no match, no stake locked)', async () => {
    const A = await newPlayer('pf');
    await query('UPDATE wallets w JOIN users u ON u.id = w.user_id SET w.available_balance = 0 WHERE u.username = ?', [A.user.username]);
    const r = await api().post('/api/matches/practice').set(auth(A.token)).send({ gameId: await gameId(), stake: 10 });
    assert.ok(r.status >= 400 && r.status < 500, `expected a client error, got ${r.status}`);
    const rows = await query('SELECT COUNT(*) AS n FROM matches WHERE created_by = ?', [A.user.id]);
    assert.equal(rows[0].n, 0);
  });
});

describe('bot and auto dives use every zone, low and high', () => {
  test('across many rounds both rows and all columns appear', () => {
    const bot = new Set(); const auto = new Set();
    for (let r = 1; r <= 300; r++) { bot.add(rules.botDive(4242, r)); auto.add(rules.autoKeeperZone(4242, r)); }
    assert.deepEqual([...bot].sort(), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual([...auto].sort(), [0, 1, 2, 3, 4, 5]);
  });
});
