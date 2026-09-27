// End-to-end API tests against a real MySQL test database (DB_NAME_TEST,
// default "rivalis_test"). The database is rebuilt and seeded on each run.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rivalis_test';

const { migrate } = await import('../scripts/migrate.js');
const { seed } = await import('../scripts/seed.js');
const { createApp } = await import('../src/app.js');
const { pool, query, queryOne } = await import('../src/db.js');
const { sweepMatches } = await import('../src/services/matchService.js');
const { expireChallenges } = await import('../src/services/challengeService.js');
const { invalidateSettings } = await import('../src/services/settingsService.js');
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
async function newPlayer(prefix = 'tp') {
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
  const res = await api().get('/api/wallet').set(auth(token));
  return res.body.wallet;
}

/** Pretend the player started `ms` ago so the server-side timing check passes. */
async function backdateStart(matchId, userId, ms = 5 * 60000) {
  await query('UPDATE match_players SET started_at = ? WHERE match_id = ? AND user_id = ?', [new Date(Date.now() - ms), matchId, userId]);
}

const gameId = async (slug) => (await queryOne('SELECT id FROM games WHERE slug = ?', [slug])).id;

before(async () => {
  await migrate({ fresh: true, log: quiet });
  await seed({ log: quiet });
});

after(async () => {
  await pool.end();
});

describe('auth', () => {
  test('registration validates every field', async () => {
    const res = await api().post('/api/auth/register').send({
      firstName: '', lastName: 'X1', username: 'a', email: 'nope', phone: 'abc', password: 'short', confirmPassword: 'other',
    });
    assert.equal(res.status, 400);
    const f = res.body.error.details.fields;
    for (const k of ['firstName', 'lastName', 'username', 'email', 'phone', 'password']) assert.ok(f[k], `expected error for ${k}`);
  });

  test('password confirmation must match', async () => {
    const res = await api().post('/api/auth/register').send({
      firstName: 'A', lastName: 'B', username: 'mismatch1', email: 'mm@test.dev', phone: '+26771234567', password: 'Secret123', confirmPassword: 'Secret124',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details.fields.confirmPassword, 'Passwords do not match.');
  });

  test('register logs in, hashes password, credits demo signup bonus', async () => {
    const { token, user } = await newPlayer();
    assert.ok(token);
    const row = await queryOne('SELECT password_hash FROM users WHERE id = ?', [user.id]);
    assert.match(row.password_hash, /^\$2[ab]\$/);
    const w = await wallet(token);
    assert.equal(w.available, 250);
    const tx = await api().get('/api/wallet/transactions').set(auth(token));
    assert.equal(tx.body.items[0].type, 'DEPOSIT');
  });

  test('duplicate username and email are rejected', async () => {
    const base = { firstName: 'A', lastName: 'B', phone: '+26771234567', password: 'Secret123', confirmPassword: 'Secret123' };
    let res = await api().post('/api/auth/register').send({ ...base, username: 'player', email: 'fresh@test.dev' });
    assert.equal(res.status, 409);
    assert.ok(res.body.error.details.fields.username);
    res = await api().post('/api/auth/register').send({ ...base, username: 'fresh_name', email: 'PLAYER@example.com' });
    assert.equal(res.status, 409);
    assert.ok(res.body.error.details.fields.email);
  });

  test('login by email or username, wrong password rejected, logout revokes session', async () => {
    const bad = await api().post('/api/auth/login').send({ identifier: 'player', password: 'nope' });
    assert.equal(bad.status, 401);
    const t1 = await login('player');
    const t2 = await login('player@example.com');
    assert.equal((await api().get('/api/me').set(auth(t1))).status, 200);
    assert.equal((await api().post('/api/auth/logout').set(auth(t1))).status, 200);
    assert.equal((await api().get('/api/me').set(auth(t1))).status, 401);
    assert.equal((await api().get('/api/me').set(auth(t2))).status, 200);
  });

  test('disabled users and bots cannot log in', async () => {
    assert.equal((await api().post('/api/auth/login').send({ identifier: 'B_Tau', password: 'Player123!' })).status, 403);
    assert.equal((await api().post('/api/auth/login').send({ identifier: 'RivalBot', password: 'x' })).status, 401);
  });

  test('protected routes require a token', async () => {
    assert.equal((await api().get('/api/wallet')).status, 401);
    assert.equal((await api().get('/api/dashboard').set(auth('garbage'))).status, 401);
  });
});

describe('dashboard, games, profile', () => {
  test('dashboard contains the key widgets', async () => {
    const t = await login('player');
    const res = await api().get('/api/dashboard').set(auth(t));
    assert.equal(res.status, 200);
    for (const k of ['wallet', 'stats', 'leaderboard', 'activeMatches', 'recentMatches', 'activeChallenges', 'games']) assert.ok(k in res.body, k);
    assert.ok(res.body.stats.played > 0);
    assert.ok(res.body.stats.streak.label);
    assert.ok(res.body.leaderboard.rank >= 1);
  });

  test('game catalogue lists 5 games with entry/prize/waiting', async () => {
    const t = await login('player');
    const res = await api().get('/api/games').set(auth(t));
    assert.equal(res.body.games.length, 5);
    const rr = res.body.games.find((g) => g.slug === 'reaction-rush');
    assert.equal(rr.mode, '1v1');
    const s20 = rr.stakes.find((s) => s.stake === 20);
    assert.deepEqual([s20.pool, s20.fee, s20.prize], [40, 4, 36]);
    assert.equal(typeof rr.waiting, 'number');
  });

  test('profile update and stats', async () => {
    const { token } = await newPlayer();
    const res = await api().patch('/api/me').set(auth(token)).send({ firstName: 'Changed', bio: 'Hello' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.firstName, 'Changed');
    const bad = await api().patch('/api/me').set(auth(token)).send({ phone: 'xx' });
    assert.equal(bad.status, 400);
    const stats = await api().get('/api/me/stats').set(auth(token));
    assert.equal(stats.body.stats.played, 0);
    const pub = await api().get('/api/users/Kabelo').set(auth(token));
    assert.equal(pub.body.user.username, 'Kabelo');
    assert.equal(pub.body.user.email, undefined);
  });
});

describe('wallet (demo)', () => {
  test('demo deposit persists balance + transaction + notification', async () => {
    const { token } = await newPlayer();
    const res = await api().post('/api/wallet/demo-deposit').set(auth(token)).send({ amount: 100 });
    assert.equal(res.status, 201);
    assert.equal(res.body.wallet.available, 350);
    assert.equal(res.body.status, 'DEMO_COMPLETED');
    const tx = await api().get('/api/wallet/transactions?type=DEPOSIT').set(auth(token));
    assert.equal(tx.body.items.length, 2);
    assert.equal(tx.body.items[0].amount, 100);
    assert.equal(tx.body.items[0].balanceAfter, 350);
    const notes = await api().get('/api/notifications').set(auth(token));
    assert.ok(notes.body.notifications.some((x) => x.type === 'DEPOSIT'));
  });

  test('invalid deposit amounts are rejected', async () => {
    const { token } = await newPlayer();
    for (const amount of [0, -5, 'abc', 1.234, 999999]) {
      const res = await api().post('/api/wallet/demo-deposit').set(auth(token)).send({ amount });
      assert.equal(res.status, 400, `amount ${amount}`);
    }
    assert.equal((await wallet(token)).available, 250);
  });

  test('demo withdrawal: insufficient funds rejected, valid one DEMO_COMPLETED', async () => {
    const { token } = await newPlayer();
    const over = await api().post('/api/wallet/demo-withdrawal').set(auth(token)).send({ amount: 1000 });
    assert.equal(over.status, 400);
    assert.equal(over.body.error.code, 'INSUFFICIENT_BALANCE');
    const ok = await api().post('/api/wallet/demo-withdrawal').set(auth(token)).send({ amount: 50 });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.wallet.available, 200);
    const tx = await api().get('/api/wallet/transactions?type=WITHDRAWAL').set(auth(token));
    assert.equal(tx.body.items[0].status, 'DEMO_COMPLETED');
    assert.equal(tx.body.items[0].signedAmount, -50);
  });

  test('concurrent withdrawals cannot overdraw (no double spend)', async () => {
    const { token } = await newPlayer();
    const results = await Promise.all(Array.from({ length: 6 }, () => api().post('/api/wallet/demo-withdrawal').set(auth(token)).send({ amount: 100 })));
    assert.equal(results.filter((r) => r.status === 201).length, 2);
    const w = await wallet(token);
    assert.equal(w.available, 50);
  });

  test('admins cannot use player wallet actions; users only see their own transactions', async () => {
    const a = await login('admin@example.com', 'Admin123!');
    assert.equal((await api().post('/api/wallet/demo-deposit').set(auth(a)).send({ amount: 10 })).status, 403);
    const p1 = await newPlayer();
    const p2 = await newPlayer();
    await api().post('/api/wallet/demo-deposit').set(auth(p2.token)).send({ amount: 77 });
    const list = await api().get('/api/wallet/transactions').set(auth(p1.token));
    assert.ok(list.body.items.every((t) => t.amount !== 77));
  });
});

describe('match lifecycle', () => {
  test('matchmaking pairs same game + stake, locks, plays, settles once', async () => {
    const rr = await gameId('reaction-rush');
    const A = await newPlayer('mA');
    const B = await newPlayer('mB');

    const a1 = await api().post('/api/matches/find').set(auth(A.token)).send({ gameId: rr, stake: 20 });
    assert.equal(a1.status, 201);
    assert.equal(a1.body.match.status, 'WAITING');
    let wa = await wallet(A.token);
    assert.deepEqual([wa.available, wa.locked, wa.total], [230, 20, 250]);

    // Invalid stake
    const bad = await api().post('/api/matches/find').set(auth(B.token)).send({ gameId: rr, stake: 7 });
    assert.equal(bad.body.error.code, 'INVALID_STAKE');

    const b1 = await api().post('/api/matches/find').set(auth(B.token)).send({ gameId: rr, stake: 20 });
    assert.equal(b1.status, 200);
    assert.equal(b1.body.matched, true);
    const match = b1.body.match;
    assert.equal(match.id, a1.body.match.id);
    assert.equal(match.status, 'MATCHED');
    assert.equal(match.prize, 36);

    // Cannot start before both are ready
    assert.equal((await api().post(`/api/matches/${match.id}/start`).set(auth(A.token))).body.error.code, 'MATCH_NOT_READY');
    await api().post(`/api/matches/${match.id}/ready`).set(auth(A.token));
    const r2 = await api().post(`/api/matches/${match.code}/ready`).set(auth(B.token));
    assert.equal(r2.body.match.status, 'READY');

    const sa = await api().post(`/api/matches/${match.id}/start`).set(auth(A.token));
    const sb = await api().post(`/api/matches/${match.id}/start`).set(auth(B.token));
    assert.equal(sa.status, 200);
    assert.deepEqual(sa.body.spec, sb.body.spec, 'both players get the identical sequence');
    assert.equal(sa.body.spec.rounds.length, 10);

    // Outsiders can't see or submit
    const C = await newPlayer('mC');
    assert.equal((await api().get(`/api/matches/${match.id}`).set(auth(C.token))).status, 403);
    assert.equal((await api().post(`/api/matches/${match.id}/result`).set(auth(C.token)).send({ actions: {} })).status, 403);

    // A submits fast reactions, B slow ones. Client cannot claim a win.
    await backdateStart(match.id, A.user.id);
    await backdateStart(match.id, B.user.id);
    const fast = { rounds: Array.from({ length: 10 }, () => ({ hit: true, reactionMs: 250 })) };
    const slow = { rounds: Array.from({ length: 10 }, (_, i) => (i < 8 ? { hit: true, reactionMs: 420 } : { hit: false })) };
    const ra = await api().post(`/api/matches/${match.id}/result`).set(auth(A.token)).send({ actions: { ...fast, winner: 'me', score: 99999 } });
    assert.equal(ra.status, 200);
    assert.equal(ra.body.result.score, 9000);
    assert.equal(ra.body.match.status, 'IN_PROGRESS');
    // Duplicate submission rejected
    assert.equal((await api().post(`/api/matches/${match.id}/result`).set(auth(A.token)).send({ actions: fast })).status, 409);

    const rb = await api().post(`/api/matches/${match.id}/result`).set(auth(B.token)).send({ actions: slow });
    const done = rb.body.match;
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.winnerId, A.user.id);
    const pa = done.players.find((p) => p.userId === A.user.id);
    assert.equal(pa.outcome, 'WIN');
    assert.equal(pa.result.summary.averageReactionMs, 250);

    wa = await wallet(A.token);
    const wb = await wallet(B.token);
    assert.deepEqual([wa.available, wa.locked], [266, 0]); // 250 - 20 + 36
    assert.deepEqual([wb.available, wb.locked], [230, 0]);

    // Settlement cannot run twice
    const { finalizeMatch } = await import('../src/services/matchService.js');
    const { withTransaction } = await import('../src/db.js');
    assert.equal(await withTransaction((tx) => finalizeMatch(tx, match.id)), false);
    const wins = await query(`SELECT COUNT(*) AS c FROM transactions WHERE match_id = ? AND type = 'GAME_WIN'`, [match.id]);
    assert.equal(wins[0].c, 1);
    assert.equal((await wallet(A.token)).available, 266);

    // History, stats, notifications
    const hist = await api().get('/api/matches?filter=wins').set(auth(A.token));
    assert.equal(hist.body.items[0].code, match.code);
    assert.equal(hist.body.items[0].opponent.userId, B.user.id);
    const losses = await api().get('/api/matches?filter=losses').set(auth(B.token));
    assert.equal(losses.body.items.length, 1);
    const stats = await api().get('/api/me/stats').set(auth(A.token));
    assert.equal(stats.body.stats.wins, 1);
    assert.equal(stats.body.stats.streak.label, 'W1');
    assert.equal(stats.body.stats.totalWinnings, 36);
    const notes = await api().get('/api/notifications').set(auth(A.token));
    assert.ok(notes.body.notifications.some((x) => x.type === 'MATCH_WON' && x.message.includes('P36.00')));

    // Can't cancel a completed match
    assert.equal((await api().post(`/api/matches/${match.id}/cancel`).set(auth(A.token))).body.error.code, 'MATCH_COMPLETED');
  });

  test('submitting faster than the game allows is flagged invalid', async () => {
    const rr = await gameId('reaction-rush');
    const A = await newPlayer('tA');
    const B = await newPlayer('tB');
    await api().post('/api/matches/find').set(auth(A.token)).send({ gameId: rr, stake: 5 });
    const { body } = await api().post('/api/matches/find').set(auth(B.token)).send({ gameId: rr, stake: 5 });
    const id = body.match.id;
    await api().post(`/api/matches/${id}/ready`).set(auth(A.token));
    await api().post(`/api/matches/${id}/ready`).set(auth(B.token));
    await api().post(`/api/matches/${id}/start`).set(auth(A.token));
    const res = await api().post(`/api/matches/${id}/result`).set(auth(A.token))
      .send({ actions: { rounds: Array.from({ length: 10 }, () => ({ hit: true, reactionMs: 150 })) } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.result.valid, false);
    assert.equal(res.body.result.score, 0);
  });

  test('cancel before start refunds the locked stake', async () => {
    const ps = await gameId('penalty-shootout');
    const A = await newPlayer('cA');
    const r = await api().post('/api/matches').set(auth(A.token)).send({ gameId: ps, stake: 50 });
    assert.equal(r.status, 201);
    assert.deepEqual([(await wallet(A.token)).available, (await wallet(A.token)).locked], [200, 50]);
    const c = await api().post(`/api/matches/${r.body.match.id}/cancel`).set(auth(A.token));
    assert.equal(c.body.match.status, 'CANCELLED');
    const w = await wallet(A.token);
    assert.deepEqual([w.available, w.locked], [250, 0]);
    const tx = await api().get('/api/wallet/transactions?type=REFUND').set(auth(A.token));
    assert.equal(tx.body.items.length, 1);
    // Cancelled match can't be joined
    const B = await newPlayer('cB');
    assert.equal((await api().post(`/api/matches/${r.body.match.id}/join`).set(auth(B.token))).body.error.code, 'MATCH_CANCELLED');
    const hist = await api().get('/api/matches?filter=cancelled').set(auth(A.token));
    assert.equal(hist.body.items.length, 1);
  });

  test('matched players can leave before starting (both refunded); started matches cannot be cancelled', async () => {
    const g = await gameId('word-battle');
    const A = await newPlayer('lA');
    const B = await newPlayer('lB');
    await api().post('/api/matches/find').set(auth(A.token)).send({ gameId: g, stake: 10 });
    const m = (await api().post('/api/matches/find').set(auth(B.token)).send({ gameId: g, stake: 10 })).body.match;
    const c = await api().post(`/api/matches/${m.id}/cancel`).set(auth(B.token));
    assert.equal(c.body.match.status, 'CANCELLED');
    assert.equal((await wallet(A.token)).available, 250);
    assert.equal((await wallet(B.token)).available, 250);

    await api().post('/api/matches/find').set(auth(A.token)).send({ gameId: g, stake: 10 });
    const m2 = (await api().post('/api/matches/find').set(auth(B.token)).send({ gameId: g, stake: 10 })).body.match;
    await api().post(`/api/matches/${m2.id}/ready`).set(auth(A.token));
    await api().post(`/api/matches/${m2.id}/ready`).set(auth(B.token));
    await api().post(`/api/matches/${m2.id}/start`).set(auth(A.token));
    assert.equal((await api().post(`/api/matches/${m2.id}/cancel`).set(auth(B.token))).body.error.code, 'MATCH_ALREADY_STARTED');
    // Joining a full match fails
    const C = await newPlayer('lC');
    assert.equal((await api().post(`/api/matches/${m2.id}/join`).set(auth(C.token))).body.error.code, 'MATCH_ALREADY_STARTED');
  });

  test('insufficient balance and parallel entries cannot overspend', async () => {
    const A = await newPlayer('dA');
    await api().post('/api/wallet/demo-withdrawal').set(auth(A.token)).send({ amount: 220 }); // 30 left
    const ids = await Promise.all(['reaction-rush', 'aim-challenge', 'memory-battle', 'word-battle', 'penalty-shootout'].map(gameId));
    const results = await Promise.all(ids.map((gid) => api().post('/api/matches/find').set(auth(A.token)).send({ gameId: gid, stake: 20 })));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.ok(results.some((r) => r.body.error?.code === 'INSUFFICIENT_BALANCE'));
    const w = await wallet(A.token);
    assert.deepEqual([w.available, w.locked], [10, 20]);
  });

  test('demo opponent (house bot) can join and the match settles', async () => {
    const mb = await gameId('memory-battle');
    const A = await newPlayer('bA');
    const m = (await api().post('/api/matches/find').set(auth(A.token)).send({ gameId: mb, stake: 10 })).body.match;
    const j = await api().post(`/api/matches/${m.id}/demo-opponent`).set(auth(A.token));
    assert.equal(j.status, 200);
    assert.equal(j.body.match.status, 'MATCHED');
    assert.ok(j.body.match.players[1].isBot);
    const r = await api().post(`/api/matches/${m.id}/ready`).set(auth(A.token));
    assert.equal(r.body.match.status, 'READY');
    const s = await api().post(`/api/matches/${m.id}/start`).set(auth(A.token));
    await backdateStart(m.id, A.user.id);
    const actions = { rounds: s.body.spec.rounds.map((rd) => ({ input: rd.sequence, timeMs: rd.sequence.length * 400 })) };
    const res = await api().post(`/api/matches/${m.id}/result`).set(auth(A.token)).send({ actions });
    assert.equal(res.body.match.status, 'COMPLETED');
    const w = await wallet(A.token);
    assert.equal(w.locked, 0);
    assert.ok([240, 258, 250].includes(w.available));
  });

  test('timeouts: waiting matches refund, a no-show forfeits', async () => {
    const aim = await gameId('aim-challenge');
    const A = await newPlayer('xA');
    const m = (await api().post('/api/matches/find').set(auth(A.token)).send({ gameId: aim, stake: 50 })).body.match;
    // Deadlines are stamped on the row; expiring means the stored acceptance deadline has passed.
    await query('UPDATE matches SET acceptance_deadline = ? WHERE id = ?', [new Date(Date.now() - 1000), m.id]);
    await sweepMatches();
    assert.equal((await wallet(A.token)).available, 250);

    const B = await newPlayer('xB');
    const C = await newPlayer('xC');
    await api().post('/api/matches/find').set(auth(B.token)).send({ gameId: aim, stake: 5 });
    const m2 = (await api().post('/api/matches/find').set(auth(C.token)).send({ gameId: aim, stake: 5 })).body.match;
    await api().post(`/api/matches/${m2.id}/ready`).set(auth(B.token));
    await api().post(`/api/matches/${m2.id}/ready`).set(auth(C.token));
    await api().post(`/api/matches/${m2.id}/start`).set(auth(B.token));
    await backdateStart(m2.id, B.user.id);
    await api().post(`/api/matches/${m2.id}/result`).set(auth(B.token)).send({ actions: { targets: [] } });
    // B finished, so C is on the player-action timer; let it run out.
    await query('UPDATE matches SET player_action_deadline = ? WHERE id = ?', [new Date(Date.now() - 1000), m2.id]);
    await sweepMatches();
    const v = (await api().get(`/api/matches/${m2.id}`).set(auth(B.token))).body.match;
    assert.equal(v.status, 'COMPLETED');
    assert.equal(v.winnerId, B.user.id);
    assert.equal((await wallet(B.token)).available, 254); // 250 - 5 + 9
  });
});

describe('challenges', () => {
  test('challenge -> accept creates a real match and locks both stakes only then', async () => {
    const rr = await gameId('reaction-rush');
    const A = await newPlayer('chA');
    const B = await newPlayer('chB');
    const s = await api().get(`/api/users/search?q=${B.user.username.slice(0, 5)}`).set(auth(A.token));
    assert.ok(s.body.users.some((u) => u.username === B.user.username));

    const c = await api().post('/api/challenges').set(auth(A.token)).send({ opponent: `@${B.user.username}`, gameId: rr, stake: 20 });
    assert.equal(c.status, 201);
    assert.equal((await wallet(A.token)).locked, 0, 'no lock at challenge time');
    const dup = await api().post('/api/challenges').set(auth(A.token)).send({ opponent: B.user.username, gameId: rr, stake: 10 });
    assert.equal(dup.body.error.code, 'DUPLICATE_CHALLENGE');
    assert.equal((await api().post('/api/challenges').set(auth(A.token)).send({ opponent: A.user.username, gameId: rr, stake: 10 })).body.error.code, 'CANNOT_CHALLENGE_SELF');
    assert.equal((await api().post('/api/challenges').set(auth(A.token)).send({ opponent: 'nobody_here_xyz', gameId: rr, stake: 10 })).status, 404);

    const inbox = await api().get('/api/challenges?box=incoming&status=active').set(auth(B.token));
    assert.equal(inbox.body.challenges[0].challenger.username, A.user.username);
    const notes = await api().get('/api/notifications').set(auth(B.token));
    assert.ok(notes.body.notifications.some((x) => x.title === `${A.user.username} challenged you`));

    // Only the opponent may accept
    assert.equal((await api().post(`/api/challenges/${c.body.challenge.id}/accept`).set(auth(A.token))).status, 403);
    const acc = await api().post(`/api/challenges/${c.body.challenge.id}/accept`).set(auth(B.token));
    assert.equal(acc.status, 200);
    assert.equal(acc.body.match.status, 'MATCHED');
    assert.equal((await wallet(A.token)).locked, 20);
    assert.equal((await wallet(B.token)).locked, 20);
    assert.equal((await api().post(`/api/challenges/${c.body.challenge.id}/accept`).set(auth(B.token))).body.error.code, 'CHALLENGE_CLOSED');
    // Private challenge matches can't be joined by others
    const C = await newPlayer('chC');
    assert.equal((await api().post(`/api/matches/${acc.body.match.id}/join`).set(auth(C.token))).status, 403);
  });

  test('decline, cancel and expiry', async () => {
    const g = await gameId('word-battle');
    const A = await newPlayer('ceA');
    const B = await newPlayer('ceB');
    const c1 = (await api().post('/api/challenges').set(auth(A.token)).send({ opponent: B.user.username, gameId: g, stake: 10 })).body.challenge;
    const d = await api().post(`/api/challenges/${c1.id}/decline`).set(auth(B.token));
    assert.equal(d.body.challenge.status, 'DECLINED');
    const notes = await api().get('/api/notifications').set(auth(A.token));
    assert.ok(notes.body.notifications.some((x) => x.type === 'CHALLENGE_DECLINED'));

    const c2 = (await api().post('/api/challenges').set(auth(A.token)).send({ opponent: B.user.username, gameId: g, stake: 10 })).body.challenge;
    assert.equal((await api().post(`/api/challenges/${c2.id}/cancel`).set(auth(B.token))).status, 403);
    assert.equal((await api().post(`/api/challenges/${c2.id}/cancel`).set(auth(A.token))).body.challenge.status, 'CANCELLED');

    const c3 = (await api().post('/api/challenges').set(auth(A.token)).send({ opponent: B.user.username, gameId: g, stake: 10 })).body.challenge;
    await query('UPDATE challenges SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [c3.id]);
    assert.equal((await api().post(`/api/challenges/${c3.id}/accept`).set(auth(B.token))).body.error.code, 'CHALLENGE_EXPIRED');
    await expireChallenges();
    assert.equal((await api().get(`/api/challenges/${c3.id}`).set(auth(A.token))).body.challenge.status, 'EXPIRED');
    // Outsider can't read it
    const C = await newPlayer('ceC');
    assert.equal((await api().get(`/api/challenges/${c3.id}`).set(auth(C.token))).status, 403);
  });

  test('accept fails cleanly if the accepter cannot cover the stake', async () => {
    const g = await gameId('reaction-rush');
    const A = await newPlayer('cfA');
    const B = await newPlayer('cfB');
    const c = (await api().post('/api/challenges').set(auth(A.token)).send({ opponent: B.user.username, gameId: g, stake: 200 })).body.challenge;
    await api().post('/api/wallet/demo-withdrawal').set(auth(B.token)).send({ amount: 100 });
    const res = await api().post(`/api/challenges/${c.id}/accept`).set(auth(B.token));
    assert.equal(res.body.error.code, 'INSUFFICIENT_BALANCE');
    assert.equal((await wallet(A.token)).locked, 0, 'challenger lock rolled back');
    assert.equal((await api().get(`/api/challenges/${c.id}`).set(auth(A.token))).body.challenge.status, 'PENDING');
  });
});

describe('leaderboard & notifications', () => {
  test('leaderboard periods come from real data', async () => {
    const t = await login('player');
    for (const period of ['daily', 'weekly', 'all']) {
      const res = await api().get(`/api/leaderboard?period=${period}`).set(auth(t));
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.entries));
    }
    const all = (await api().get('/api/leaderboard?period=all').set(auth(t))).body.entries;
    assert.ok(all.length >= 6);
    assert.equal(all[0].rank, 1);
    assert.ok(all[0].wins >= all[1].wins);
    const daily = (await api().get('/api/leaderboard?period=daily').set(auth(t))).body.entries;
    assert.ok(daily.length >= 1, 'matches played in this test run appear in daily');
  });

  test('mark notifications as read', async () => {
    const t = await login('player');
    const list = await api().get('/api/notifications').set(auth(t));
    assert.ok(list.body.unread > 0);
    const first = list.body.notifications.find((x) => !x.isRead);
    const r = await api().post(`/api/notifications/${first.id}/read`).set(auth(t));
    assert.equal(r.body.unread, list.body.unread - 1);
    // Can't mark someone else's
    const other = await newPlayer();
    assert.equal((await api().post(`/api/notifications/${first.id}/read`).set(auth(other.token))).status, 404);
    await api().post('/api/notifications/read-all').set(auth(t));
    assert.equal((await api().get('/api/me').set(auth(t))).body.unreadNotifications, 0);
  });
});

describe('admin', () => {
  test('admin routes are protected', async () => {
    const t = await login('player');
    assert.equal((await api().get('/api/admin/stats').set(auth(t))).status, 403);
    assert.equal((await api().get('/api/admin/stats')).status, 401);
  });

  test('admin dashboard, users, transactions, matches, challenges', async () => {
    const a = await login('admin@example.com', 'Admin123!');
    const s = await api().get('/api/admin/stats').set(auth(a));
    assert.equal(s.status, 200);
    assert.ok(s.body.users.total > 5);
    assert.ok(s.body.matches.completed > 0);
    assert.ok(s.body.finance.demoPlatformFees > 0);
    const users = await api().get('/api/admin/users?q=kab').set(auth(a));
    assert.equal(users.body.items[0].username, 'Kabelo');
    const detail = await api().get(`/api/admin/users/${users.body.items[0].id}`).set(auth(a));
    assert.ok(detail.body.wallet);
    assert.ok(detail.body.transactions.length > 0);
    assert.ok((await api().get('/api/admin/transactions?type=GAME_WIN').set(auth(a))).body.items.every((t) => t.type === 'GAME_WIN'));
    assert.ok((await api().get('/api/admin/matches?status=COMPLETED').set(auth(a))).body.items.length > 0);
    assert.ok((await api().get('/api/admin/challenges').set(auth(a))).body.challenges.length > 0);
  });

  test('disable / enable user revokes their sessions', async () => {
    const a = await login('admin@example.com', 'Admin123!');
    const P = await newPlayer('dis');
    const r = await api().post(`/api/admin/users/${P.user.id}/status`).set(auth(a)).send({ status: 'DISABLED' });
    assert.equal(r.body.user.status, 'DISABLED');
    assert.equal((await api().get('/api/me').set(auth(P.token))).status, 401);
    assert.equal((await api().post('/api/auth/login').send({ identifier: P.user.username, password: 'Secret123' })).status, 403);
    await api().post(`/api/admin/users/${P.user.id}/status`).set(auth(a)).send({ status: 'ACTIVE' });
    assert.equal((await api().post('/api/auth/login').send({ identifier: P.user.username, password: 'Secret123' })).status, 200);
    const me = (await api().get('/api/me').set(auth(a))).body.user;
    assert.equal((await api().post(`/api/admin/users/${me.id}/status`).set(auth(a)).send({ status: 'DISABLED' })).status, 400);
  });

  test('platform fee + stakes are configurable and apply to new matches', async () => {
    const a = await login('admin@example.com', 'Admin123!');
    assert.equal((await api().put('/api/admin/settings').set(auth(a)).send({ platform_fee_percent: 80 })).status, 400);
    const r = await api().put('/api/admin/settings').set(auth(a)).send({ platform_fee_percent: 5, stake_amounts: [5, 10, 25] });
    assert.equal(r.status, 200);
    invalidateSettings();
    const P = await newPlayer('fee');
    const m = await api().post('/api/matches/find').set(auth(P.token)).send({ gameId: await gameId('reaction-rush'), stake: 25 });
    assert.equal(m.status, 201);
    assert.equal(m.body.match.prize, 47.5); // 50 - 5%
    assert.equal(m.body.match.fee, 2.5);
    const bad = await api().post('/api/matches/find').set(auth(P.token)).send({ gameId: await gameId('reaction-rush'), stake: 20 });
    assert.equal(bad.body.error.code, 'INVALID_STAKE');
    const cfg = await api().get('/api/config');
    assert.equal(cfg.body.platformFeePercent, 5);
    await api().put('/api/admin/settings').set(auth(a)).send({ platform_fee_percent: 10, stake_amounts: [5, 10, 20, 50, 100, 200] });
    invalidateSettings();
  });

  test('games can be disabled / enabled; admin can cancel an active match', async () => {
    const a = await login('admin@example.com', 'Admin123!');
    const gid = await gameId('aim-challenge');
    await api().patch(`/api/admin/games/${gid}`).set(auth(a)).send({ isEnabled: false });
    const P = await newPlayer('gd');
    const res = await api().post('/api/matches/find').set(auth(P.token)).send({ gameId: gid, stake: 10 });
    assert.equal(res.body.error.code, 'GAME_DISABLED');
    const cat = await api().get('/api/games').set(auth(P.token));
    assert.ok(!cat.body.games.some((g) => g.id === gid));
    await api().patch(`/api/admin/games/${gid}`).set(auth(a)).send({ isEnabled: true });

    const m = (await api().post('/api/matches/find').set(auth(P.token)).send({ gameId: gid, stake: 10 })).body.match;
    const c = await api().post(`/api/admin/matches/${m.id}/cancel`).set(auth(a));
    assert.equal(c.body.match.status, 'CANCELLED');
    assert.equal((await wallet(P.token)).available, 250);
    const audit = await api().get('/api/admin/audit').set(auth(a));
    assert.ok(audit.body.entries.some((e) => e.action === 'MATCH_CANCELLED'));
  });

  test('ledger integrity: every wallet equals the sum of its transactions', async () => {
    const rows = await query(`
      SELECT w.user_id, w.available_balance + w.locked_balance AS total,
        COALESCE((SELECT SUM(CASE WHEN t.type = 'WITHDRAWAL' THEN -t.amount ELSE t.amount END) FROM transactions t
                  WHERE t.user_id = w.user_id AND t.type IN ('DEPOSIT','WITHDRAWAL','GAME_WIN')), 0)
        - COALESCE((SELECT SUM(mp.stake) FROM match_players mp WHERE mp.user_id = w.user_id AND mp.outcome IN ('WIN','LOSS')), 0) AS ledger
      FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.is_bot = 0`);
    for (const r of rows) assert.equal(Number(r.total).toFixed(2), Number(r.ledger).toFixed(2), `user ${r.user_id}`);
  });
});
