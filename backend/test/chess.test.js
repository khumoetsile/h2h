import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rivalis_test';

const { migrate } = await import('../scripts/migrate.js');
const { seed } = await import('../scripts/seed.js');
const { createApp } = await import('../src/app.js');
const { query, queryOne, pool } = await import('../src/db.js');
const { sweepChess } = await import('../src/services/chessService.js');
const { sweepMatches, compensateDowntime, heartbeat } = await import('../src/services/matchService.js');
const { config } = await import('../src/config.js');
const { invalidateSettings } = await import('../src/services/settingsService.js');
const request = (await import('supertest')).default;
const app = createApp();
const api = () => request(app);
const auth = player => ({ Authorization: `Bearer ${player.token}` });
const quiet = () => {};
let seq = 0;
let chessId;

before(async () => {
  await migrate({ fresh: true, log: quiet });
  await seed({ log: quiet });
  chessId = (await queryOne("SELECT id FROM games WHERE slug = 'chess'")).id;
});
after(async () => pool.end());

async function player() {
  const username = `ch${Date.now().toString(36)}${++seq}`;
  const res = await api().post('/api/auth/register').send({ firstName: 'Chess', lastName: 'Player', username, email: `${username}@test.dev`, phone: '+267 71 234 567', password: 'Secret123', confirmPassword: 'Secret123' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { token: res.body.token, id: res.body.user.id, username };
}
const wallet = async p => (await api().get('/api/wallet').set(auth(p))).body.wallet;
const view = async (p, code) => (await api().get(`/api/chess/${code}`).set(auth(p))).body.game;
async function invite(a, b = null, stake = 20) {
  const res = await api().post('/api/chess').set(auth(a)).send({ stake, ...(b ? { opponent: b.username } : {}) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.game;
}
async function pair() {
  const a = await player(), b = await player();
  const game = await invite(a, b);
  const accepted = await api().post(`/api/chess/${game.code}/accept`).set(auth(b));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { a, b, game: accepted.body.game };
}
async function move(p, game, from, to, promotion) {
  return api().post(`/api/chess/${game.code}/move`).set(auth(p)).send({ from, to, version: game.version, ...(promotion ? { promotion } : {}) });
}
const settlement = id => query('SELECT * FROM settlements WHERE match_id = ?', [id]);
const entries = id => query("SELECT * FROM transactions WHERE match_id = ? AND type = 'GAME_ENTRY'", [id]);

test('pending invitations show reviewed fee and deadlines, hold no funds and reveal no session data', async () => {
  const a = await player(), b = await player();
  const before = await wallet(a);
  const game = await invite(a, b);
  assert.equal(game.status, 'PENDING');
  assert.equal(game.matchId, null);
  assert.equal(game.turnSeconds, config.chess.turnSeconds);
  assert.equal(game.turnDeadline, null);
  assert.ok(new Date(game.inviteExpiresAt) - Date.now() > (config.chess.inviteSeconds - 5) * 1000);
  assert.deepEqual(await wallet(a), before);
  const preview = await api().get(`/api/chess/${game.code}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.game.stake, 20);
  assert.equal(preview.body.game.canAccept, false);
  assert.deepEqual(preview.body.game.legalMoves, []);
  assert.equal(preview.body.game.white.email, undefined);
  const cfg = await api().get('/api/chess/config');
  assert.equal(cfg.body.turnSeconds, 86400);
});

test('acceptance locks both stakes atomically, creates a normal ledger match and starts White’s deadline', async () => {
  const { a, b, game } = await pair();
  assert.equal(game.status, 'ACTIVE');
  assert.equal(game.isYourTurn, false);
  assert.equal(game.viewerColor, 'b');
  assert.equal((await wallet(a)).locked, 20);
  assert.equal((await wallet(b)).locked, 20);
  assert.equal((await entries(game.matchId)).length, 2);
  assert.equal((await queryOne('SELECT category FROM matches WHERE id = ?', [game.matchId])).category, 'CHESS');
  assert.ok(new Date(game.turnDeadline) - Date.now() > (86400 - 5) * 1000);
  const first = await view(a, game.code);
  assert.equal(first.isYourTurn, true);
  assert.equal(first.legalMoves.length, 20);
  const repeated = await api().post(`/api/chess/${game.code}/accept`).set(auth(b));
  assert.equal(repeated.status, 200);
  assert.equal((await entries(game.matchId)).length, 2);
  const history = await api().get('/api/matches?category=CHESS').set(auth(a));
  assert.equal(history.body.items[0].chess.code, game.code);
  assert.equal(history.body.items[0].chess.isYourTurn, true);
});

test('active game previews hide board, PGN, moves and legal actions from outsiders', async () => {
  const { game } = await pair();
  const outsider = await player();
  const publicView = await api().get(`/api/chess/${game.code}`);
  for (const key of ['fen', 'pgn', 'moves', 'legalMoves', 'lastMove']) assert.equal(publicView.body.game[key], undefined);
  const res = await api().post(`/api/chess/${game.code}/move`).set(auth(outsider)).send({ from: 'e2', to: 'e4', version: game.version });
  assert.equal(res.status, 403);
});

test('self accepts and wrong named recipients are refused; simultaneous open accepts select one player', async () => {
  const a = await player(), b = await player(), c = await player();
  const named = await invite(a, b);
  assert.equal((await api().post(`/api/chess/${named.code}/accept`).set(auth(a))).status, 400);
  assert.equal((await api().post(`/api/chess/${named.code}/accept`).set(auth(c))).status, 403);
  const open = await invite(a);
  const results = await Promise.all([b, c].map(p => api().post(`/api/chess/${open.code}/accept`).set(auth(p))));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 403]);
  const game = await view(a, open.code);
  assert.equal((await entries(game.matchId)).length, 2);
});

test('insufficient creator funds at acceptance leave no match, stake hold or partial ledger', async () => {
  const a = await player(), b = await player();
  const game = await invite(a, b);
  await query('UPDATE wallets SET available_balance = 0 WHERE user_id = ?', [a.id]);
  const before = await wallet(b);
  const res = await api().post(`/api/chess/${game.code}/accept`).set(auth(b));
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'INSUFFICIENT_BALANCE');
  assert.deepEqual(await wallet(b), before);
  assert.equal((await queryOne('SELECT match_id FROM chess_games WHERE code = ?', [game.code])).match_id, null);
  assert.equal(await queryOne('SELECT id FROM matches WHERE code = ?', [game.code]), null);
});

test('illegal moves, wrong turns and stale versions do not change board, wallet or deadline', async () => {
  const { a, b, game } = await pair();
  const initial = await view(a, game.code);
  assert.equal((await move(b, game, 'e7', 'e5')).body.error.code, 'NOT_YOUR_TURN');
  assert.equal((await move(a, game, 'e2', 'e5')).body.error.code, 'ILLEGAL_MOVE');
  assert.equal((await move(a, { ...game, version: 0 }, 'e2', 'e4')).body.error.code, 'STALE_CHESS_VERSION');
  const after = await view(a, game.code);
  assert.equal(after.fen, initial.fen);
  assert.equal(after.turnDeadline, initial.turnDeadline);
  assert.equal(after.version, initial.version);
});

test('confirmed moves persist, advance ownership and reset only the next player’s deadline; repeats never add moves', async () => {
  const { a, b, game } = await pair();
  const res = await move(a, game, 'e2', 'e4');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const after = res.body.game;
  assert.equal(after.moves.length, 1);
  assert.equal(after.turn, 'b');
  assert.equal(after.version, game.version + 1);
  const black = await view(b, game.code);
  assert.equal(black.isYourTurn, true);
  assert.equal(black.legalMoves.length, 20);
  const reply = await move(b, black, 'e7', 'e5');
  assert.equal(reply.status, 200);
  const replay = await move(a, game, 'e2', 'e4');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.game.moves.length, 2);
  const persisted = await view(a, game.code);
  assert.equal(persisted.pgn, reply.body.game.pgn);
  assert.equal(persisted.fen, reply.body.game.fen);
});

test('two concurrent moves for the same turn commit only once', async () => {
  const { a, game } = await pair();
  const results = await Promise.all([move(a, game, 'e2', 'e4'), move(a, game, 'd2', 'd4')]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await view(a, game.code)).moves.length, 1);
});

test('checkmate pays the winner and takes the configured fee exactly once', async () => {
  const { a, b, game } = await pair();
  const heldA = await wallet(a), heldB = await wallet(b);
  let current = await view(a, game.code);
  for (const [p, from, to] of [[a, 'f2', 'f3'], [b, 'e7', 'e5'], [a, 'g2', 'g4'], [b, 'd8', 'h4']]) {
    const res = await move(p, current, from, to);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    current = res.body.game;
  }
  assert.equal(current.status, 'COMPLETED');
  assert.equal(current.winnerId, b.id);
  assert.equal(current.endReason, 'CHESS_CHECKMATE');
  assert.equal((await wallet(a)).locked, 0);
  assert.equal((await wallet(b)).locked, 0);
  assert.equal((await wallet(a)).available, heldA.available);
  assert.equal((await wallet(b)).available, heldB.available + game.prize);
  const [ledger] = await settlement(game.matchId);
  assert.equal(ledger.fee_amount, game.fee);
  assert.equal(ledger.prize, game.prize);
  assert.equal((await api().post(`/api/chess/${game.code}/resign`).set(auth(a))).status, 200);
  await sweepChess();
  assert.equal((await settlement(game.matchId)).length, 1);
  assert.equal((await query("SELECT id FROM transactions WHERE match_id = ? AND type = 'GAME_WIN'", [game.matchId])).length, 1);
});

test('resignation settles both stakes with normal fee; cancel cannot free an accepted stake', async () => {
  const { a, b, game } = await pair();
  const cancelled = await api().post(`/api/chess/${game.code}/cancel`).set(auth(a));
  assert.equal(cancelled.status, 409);
  const before = await wallet(b);
  const results = await Promise.all([a, b].map(p => api().post(`/api/chess/${game.code}/resign`).set(auth(p))));
  assert.ok(results.every(r => r.status === 200));
  const ended = await view(b, game.code);
  assert.equal(ended.status, 'COMPLETED');
  assert.equal((await settlement(game.matchId)).length, 1);
  assert.equal((await wallet(b)).locked, before.locked - 20);
  assert.equal((await query("SELECT id FROM transactions WHERE match_id = ? AND type = 'ABANDONMENT_FEE'", [game.matchId])).length, 0);
});

test('agreed draws refund both entries and charge no fee; offering/declining never resets deadline', async () => {
  const { a, b, game } = await pair();
  const heldA = await wallet(a), heldB = await wallet(b);
  const offer = await api().post(`/api/chess/${game.code}/draw`).set(auth(a)).send({ action: 'offer' });
  assert.equal(offer.status, 200);
  assert.equal(offer.body.game.turnDeadline, game.turnDeadline);
  assert.equal((await api().post(`/api/chess/${game.code}/draw`).set(auth(a)).send({ action: 'accept' })).status, 409);
  const decline = await api().post(`/api/chess/${game.code}/draw`).set(auth(b)).send({ action: 'decline' });
  assert.equal(decline.body.game.turnDeadline, game.turnDeadline);
  await api().post(`/api/chess/${game.code}/draw`).set(auth(a)).send({ action: 'offer' });
  const accepted = await api().post(`/api/chess/${game.code}/draw`).set(auth(b)).send({ action: 'accept' });
  assert.equal(accepted.body.game.status, 'COMPLETED');
  assert.equal(accepted.body.game.isDraw, true);
  assert.equal(accepted.body.game.myPayout, 20);
  assert.equal(accepted.body.game.fee, 0);
  const [ledger] = await settlement(game.matchId);
  assert.equal(ledger.outcome, 'DRAW');
  assert.equal(ledger.fee_amount, 0);
  assert.equal((await wallet(a)).locked, 0);
  assert.equal((await wallet(b)).locked, 0);
  assert.equal((await wallet(a)).available, heldA.available + game.stake);
  assert.equal((await wallet(b)).available, heldB.available + game.stake);
});

test('automatic repetition draw uses saved full history and refunds both stakes', async () => {
  const { a, b, game } = await pair();
  let current = game;
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const [p, from, to] of [[a, 'g1', 'f3'], [b, 'g8', 'f6'], [a, 'f3', 'g1'], [b, 'f6', 'g8']]) {
      const res = await move(p, current, from, to);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      current = res.body.game;
    }
  }
  assert.equal(current.status, 'COMPLETED');
  assert.equal(current.endReason, 'CHESS_REPETITION');
  assert.equal((await settlement(game.matchId))[0].fee_amount, 0);
});

test('late moves settle even before the sweeper; concurrent deadline sweeps never pay twice', async () => {
  const { a, b, game } = await pair();
  await query('UPDATE chess_games SET turn_deadline = ? WHERE code = ?', [new Date(Date.now() - 1000), game.code]);
  const res = await move(a, game, 'e2', 'e4');
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'CHESS_TURN_EXPIRED');
  assert.equal((await view(b, game.code)).winnerId, b.id);
  await Promise.all([sweepChess(), sweepChess(), sweepMatches()]);
  assert.equal((await settlement(game.matchId)).length, 1);
  assert.equal((await settlement(game.matchId))[0].fee_amount, game.fee);
  const history = await api().get('/api/matches?filter=timed_out').set(auth(a));
  assert.ok(history.body.items.some(row => row.code === game.code));
});

test('expired and cancelled invitations move no funds', async () => {
  const a = await player(), b = await player();
  const before = await wallet(a);
  const game = await invite(a, b);
  await query('UPDATE chess_games SET invite_expires_at = ? WHERE code = ?', [new Date(Date.now() - 1000), game.code]);
  assert.equal((await api().post(`/api/chess/${game.code}/accept`).set(auth(b))).status, 409);
  assert.equal((await view(a, game.code)).status, 'EXPIRED');
  const other = await invite(a);
  assert.equal((await api().post(`/api/chess/${other.code}/cancel`).set(auth(a))).body.game.status, 'CANCELLED');
  assert.deepEqual(await wallet(a), before);
});

test('a named recipient can decline a pending invite; sender and outsiders cannot', async () => {
  const a = await player(), b = await player(), c = await player();
  const game = await invite(a, b);
  const beforeA = await wallet(a), beforeB = await wallet(b);
  assert.equal((await view(b, game.code)).canDecline, true);
  assert.equal((await api().post(`/api/chess/${game.code}/decline`).set(auth(a))).status, 403);
  assert.equal((await api().post(`/api/chess/${game.code}/decline`).set(auth(c))).status, 403);
  const declined = await api().post(`/api/chess/${game.code}/decline`).set(auth(b));
  assert.equal(declined.status, 200);
  assert.equal(declined.body.game.status, 'CANCELLED');
  assert.equal(declined.body.game.endReason, 'INVITE_DECLINED');
  assert.deepEqual(await wallet(a), beforeA);
  assert.deepEqual(await wallet(b), beforeB);
  assert.equal((await api().post(`/api/chess/${game.code}/decline`).set(auth(b))).status, 200);
});

test('accepted entries, fee and turn duration honour the invitation terms when settings change', async () => {
  const a = await player(), b = await player();
  const game = await invite(a, b);
  const originalDuration = config.chess.turnSeconds;
  try {
    await query("UPDATE admin_settings SET setting_value = ? WHERE setting_key = 'platform_fee_percent'", [JSON.stringify(25)]);
    invalidateSettings();
    config.chess.turnSeconds = 3600;
    const accepted = await api().post(`/api/chess/${game.code}/accept`).set(auth(b));
    assert.equal(accepted.body.game.fee, game.fee);
    assert.equal(accepted.body.game.feePercent, game.feePercent);
    assert.equal(accepted.body.game.turnSeconds, game.turnSeconds);
    await api().post(`/api/chess/${game.code}/resign`).set(auth(a));
    assert.equal((await settlement(accepted.body.game.matchId))[0].fee_amount, game.fee);
  } finally {
    config.chess.turnSeconds = originalDuration;
    await query("UPDATE admin_settings SET setting_value = ? WHERE setting_key = 'platform_fee_percent'", [JSON.stringify(10)]);
    invalidateSettings();
  }
});

test('existing live timer sweeper and presence never expire active correspondence games; restart extends remaining turn time', async () => {
  const { a, game } = await pair();
  const before = await view(a, game.code);
  await sweepMatches(new Date(Date.now() + 3600000));
  assert.equal((await view(a, game.code)).status, 'ACTIVE');
  await heartbeat(new Date(Date.now() - 60000));
  const extensions = await Promise.all([compensateDowntime({ thresholdMs: 1000 }), compensateDowntime({ thresholdMs: 1000 })]);
  assert.equal(extensions.filter(gap => gap >= 60).length, 1, 'multiple workers compensate the outage once');
  const after = await view(a, game.code);
  assert.ok(new Date(after.turnDeadline) - new Date(before.turnDeadline) >= 60000);
  assert.equal(after.moves.length, before.moves.length);
});

test('generic live entry, challenge and scoring routes refuse chess mode', async () => {
  const { a, b, game } = await pair();
  for (const path of ['/api/matches', '/api/matches/find', '/api/matches/practice']) {
    const res = await api().post(path).set(auth(a)).send({ gameId: chessId, stake: 20 });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'CHESS_MODE_REQUIRED');
  }
  const c = await api().post('/api/challenges').set(auth(a)).send({ opponent: b.username, gameId: chessId, stake: 20 });
  assert.equal(c.body.error.code, 'CHESS_MODE_REQUIRED');
  for (const path of ['ready', 'start', 'cancel']) {
    const res = await api().post(`/api/matches/${game.code}/${path}`).set(auth(a));
    assert.equal(res.body.error.code, 'CHESS_MODE_REQUIRED');
  }
  const r = await api().post(`/api/matches/${game.code}/result`).set(auth(a)).send({ actions: {} });
  assert.equal(r.body.error.code, 'CHESS_MODE_REQUIRED');
});

test('administrator void refunds both stakes and closes the chess board permanently', async () => {
  const { a, b, game } = await pair();
  const login = await api().post('/api/auth/login').send({ identifier: 'admin', password: 'Admin123!' });
  const admin = { token: login.body.token };
  const board = await api().get(`/api/chess/${game.code}`).set(auth(admin));
  assert.ok(board.body.game.fen);
  assert.equal(board.body.game.isYourTurn, false);
  const res = await api().post(`/api/admin/matches/${game.matchId}/cancel`).set(auth(admin)).send({ reason: 'Test technical failure', toStatus: 'VOID' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await view(a, game.code)).status, 'CANCELLED');
  assert.equal((await move(a, game, 'e2', 'e4')).status, 409);
  assert.equal((await wallet(a)).locked, 0);
  assert.equal((await wallet(b)).locked, 0);
  assert.equal((await settlement(game.matchId))[0].fee_amount, 0);
});

test('simultaneous administrative refund and resignation produce a single consistent settlement', async () => {
  const { a, b, game } = await pair();
  const login = await api().post('/api/auth/login').send({ identifier: 'admin', password: 'Admin123!' });
  const admin = { token: login.body.token };
  const heldA = await wallet(a), heldB = await wallet(b);
  const responses = await Promise.all([
    api().post(`/api/admin/matches/${game.matchId}/cancel`).set(auth(admin)).send({ reason: 'Concurrent test refund', toStatus: 'VOID' }),
    api().post(`/api/chess/${game.code}/resign`).set(auth(a)),
  ]);
  assert.ok(responses.every(r => [200, 400, 409].includes(r.status)), JSON.stringify(responses.map(r => r.body)));
  const ended = await view(a, game.code);
  const ledgers = await settlement(game.matchId);
  assert.equal(ledgers.length, 1);
  assert.equal((await wallet(a)).locked, 0);
  assert.equal((await wallet(b)).locked, 0);
  assert.equal(ended.turnDeadline, null);
  if (ledgers[0].outcome === 'VOID') {
    assert.equal(ended.status, 'CANCELLED');
    assert.equal((await wallet(a)).available, heldA.available + 20);
    assert.equal((await wallet(b)).available, heldB.available + 20);
  } else {
    assert.equal(ended.status, 'COMPLETED');
    assert.equal(ledgers[0].winner_id, b.id);
    assert.equal((await wallet(a)).available, heldA.available);
    assert.equal((await wallet(b)).available, heldB.available + game.prize);
  }
});
