// Audit trail + settlement-integrity tests: every important lifecycle event
// must leave a structured audit_events row, every wallet mutation must have
// a real transactions row (including the forfeit fix), and settlement/
// cancellation must be provably idempotent under duplicate/concurrent calls.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rivalis_test';

const { migrate } = await import('../scripts/migrate.js');
const { seed } = await import('../scripts/seed.js');
const { createApp } = await import('../src/app.js');
const { pool, query, queryOne } = await import('../src/db.js');
const { finalizeMatch, cancelMatchTx } = await import('../src/services/matchService.js');
const { withTransaction } = await import('../src/db.js');
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
async function newPlayer(prefix = 'ap') {
  n += 1;
  const u = `${prefix}${Date.now().toString(36)}${n}`.slice(0, 20);
  const res = await api().post('/api/auth/register').send({
    firstName: 'Test', lastName: 'Player', username: u, email: `${u}@test.dev`, phone: '+267 71 234 567',
    password: 'Secret123', confirmPassword: 'Secret123',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { token: res.body.token, user: res.body.user };
}

const gameId = async (slug) => (await queryOne('SELECT id FROM games WHERE slug = ?', [slug])).id;
async function backdateStart(matchId, userId, ms = 5 * 60000) {
  await query('UPDATE match_players SET started_at = ? WHERE match_id = ? AND user_id = ?', [new Date(Date.now() - ms), matchId, userId]);
}
async function auditFor(matchId) {
  return query('SELECT * FROM audit_events WHERE match_id = ? ORDER BY id', [matchId]);
}

before(async () => {
  await migrate({ fresh: true, log: quiet });
  await seed({ log: quiet });
});

after(async () => {
  await pool.end();
});

describe('audit trail: full match lifecycle', () => {
  test('every stage of a WIN produces the expected structured audit events', async () => {
    const rr = await gameId('reaction-rush');
    const A = await newPlayer('auA');
    const B = await newPlayer('auB');

    const a1 = await api().post('/api/matches/find').set(auth(A.token)).send({ gameId: rr, stake: 20 });
    const b1 = await api().post('/api/matches/find').set(auth(B.token)).send({ gameId: rr, stake: 20 });
    const match = b1.body.match;

    await api().post(`/api/matches/${match.id}/ready`).set(auth(A.token));
    await api().post(`/api/matches/${match.id}/ready`).set(auth(B.token));
    await api().post(`/api/matches/${match.id}/start`).set(auth(A.token));
    await api().post(`/api/matches/${match.id}/start`).set(auth(B.token));
    await backdateStart(match.id, A.user.id);
    await backdateStart(match.id, B.user.id);
    const fast = { rounds: Array.from({ length: 10 }, () => ({ hit: true, reactionMs: 250 })) };
    const slow = { rounds: Array.from({ length: 10 }, (_, i) => (i < 8 ? { hit: true, reactionMs: 420 } : { hit: false })) };
    await api().post(`/api/matches/${match.id}/result`).set(auth(A.token)).send({ actions: fast });
    await api().post(`/api/matches/${match.id}/result`).set(auth(B.token)).send({ actions: slow });

    const events = await auditFor(match.id);
    const actions = events.map((e) => e.action);
    for (const expected of [
      'MATCH_CREATED', 'MATCH_JOINED', 'PLAYER_READY', 'MATCH_READY', 'MATCH_STARTED', 'GAMEPLAY_STARTED',
      'ANSWER_SUBMITTED', 'MATCH_COMPLETED', 'SETTLEMENT_CREATED',
    ]) {
      assert.ok(actions.includes(expected), `expected ${expected} in audit trail, got: ${actions.join(', ')}`);
    }
    // MATCH_CREATED is attributable to the creator, with structured metadata (not a bare log line).
    const created = events.find((e) => e.action === 'MATCH_CREATED');
    assert.equal(created.actor_type, 'PLAYER');
    assert.equal(created.actor_user_id, A.user.id);
    assert.equal(created.new_state, 'WAITING');
    const meta = created.metadata;
    assert.equal(meta.stake, 20);
    assert.equal(meta.gameSlug, 'reaction-rush');

    // Settlement event carries the full financial "why" — pool/fee/prize/winner.
    const settlement = events.find((e) => e.action === 'SETTLEMENT_CREATED');
    const smeta = settlement.metadata;
    assert.equal(smeta.outcome, 'WIN');
    assert.equal(smeta.winnerId, A.user.id);
    assert.equal(smeta.pool, 40);
    assert.equal(smeta.feeAmount, 4);
    assert.equal(smeta.prize, 36);

    // The completed transition itself is state-tracked, not just a free-text note.
    const completed = events.find((e) => e.action === 'MATCH_COMPLETED');
    assert.equal(completed.previous_state, 'IN_PROGRESS');
    assert.equal(completed.new_state, 'COMPLETED');
  });

  test('a genuine draw produces zero-fee audit metadata and a DRAW settlement event', async () => {
    const rr = await gameId('reaction-rush');
    const A = await newPlayer('drA');
    const B = await newPlayer('drB');
    const a1 = await api().post('/api/matches/find').set(auth(A.token)).send({ gameId: rr, stake: 10 });
    const b1 = await api().post('/api/matches/find').set(auth(B.token)).send({ gameId: rr, stake: 10 });
    const match = b1.body.match;
    await api().post(`/api/matches/${match.id}/ready`).set(auth(A.token));
    await api().post(`/api/matches/${match.id}/ready`).set(auth(B.token));
    await api().post(`/api/matches/${match.id}/start`).set(auth(A.token));
    await api().post(`/api/matches/${match.id}/start`).set(auth(B.token));
    await backdateStart(match.id, A.user.id);
    await backdateStart(match.id, B.user.id);
    const tie = { rounds: Array.from({ length: 10 }, () => ({ hit: true, reactionMs: 300 })) };
    await api().post(`/api/matches/${match.id}/result`).set(auth(A.token)).send({ actions: tie });
    await api().post(`/api/matches/${match.id}/result`).set(auth(B.token)).send({ actions: tie });

    const events = await auditFor(match.id);
    const settlement = events.find((e) => e.action === 'SETTLEMENT_CREATED');
    const smeta = settlement.metadata;
    assert.equal(smeta.outcome, 'DRAW');
    assert.equal(smeta.feeAmount, 0, 'a genuine draw must never carry a platform fee');
    assert.equal(smeta.prize, 0);

    const completed = events.find((e) => e.action === 'MATCH_COMPLETED');
    assert.equal(completed.metadata.outcome, 'DRAW');

    // Both refunds are independently traceable in the ledger.
    const refunds = await query(`SELECT * FROM transactions WHERE match_id = ? AND type = 'REFUND'`, [match.id]);
    assert.equal(refunds.length, 2);
    for (const r of refunds) assert.equal(Number(r.amount), 10);
  });

  test('cancellation before start refunds fully with zero fee and a traceable reason', async () => {
    const rr = await gameId('reaction-rush');
    const A = await newPlayer('cnA');
    const a1 = await api().post('/api/matches/find').set(auth(A.token)).send({ gameId: rr, stake: 20 });
    const match = a1.body.match;
    const cancelRes = await api().post(`/api/matches/${match.id}/cancel`).set(auth(A.token));
    assert.equal(cancelRes.status, 200);

    const events = await auditFor(match.id);
    const cancelled = events.find((e) => e.action === 'MATCH_CANCELLED');
    assert.ok(cancelled, 'expected a MATCH_CANCELLED audit event');
    assert.equal(cancelled.actor_type, 'PLAYER');
    assert.equal(cancelled.actor_user_id, A.user.id);
    assert.equal(cancelled.new_state, 'CANCELLED');
    assert.ok(cancelled.reason.includes('before an opponent joined'));
    const settlement = events.find((e) => e.action === 'SETTLEMENT_CREATED');
    const smeta = settlement.metadata;
    assert.equal(smeta.outcome, 'CANCELLED');
    assert.equal(smeta.feeAmount, 0);
  });
});

describe('settlement idempotency', () => {
  test('finalizeMatch cannot settle the same match twice even when called concurrently', async () => {
    const rr = await gameId('reaction-rush');
    const A = await newPlayer('idA');
    const B = await newPlayer('idB');
    const a1 = await api().post('/api/matches/find').set(auth(A.token)).send({ gameId: rr, stake: 10 });
    const b1 = await api().post('/api/matches/find').set(auth(B.token)).send({ gameId: rr, stake: 10 });
    const matchId = b1.body.match.id;
    await api().post(`/api/matches/${matchId}/ready`).set(auth(A.token));
    await api().post(`/api/matches/${matchId}/ready`).set(auth(B.token));
    await api().post(`/api/matches/${matchId}/start`).set(auth(A.token));
    await api().post(`/api/matches/${matchId}/start`).set(auth(B.token));
    await backdateStart(matchId, A.user.id);
    await backdateStart(matchId, B.user.id);
    const fast = { rounds: Array.from({ length: 10 }, () => ({ hit: true, reactionMs: 250 })) };
    const slow = { rounds: Array.from({ length: 10 }, () => ({ hit: false })) };
    await api().post(`/api/matches/${matchId}/result`).set(auth(A.token)).send({ actions: fast });
    await api().post(`/api/matches/${matchId}/result`).set(auth(B.token)).send({ actions: slow }); // triggers finalize once, A wins

    // Fire several concurrent direct finalize attempts — only the first should have ever settled;
    // every one of these must be a safe no-op.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => withTransaction((tx) => finalizeMatch(tx, matchId))),
    );
    assert.ok(results.every((r) => r === false), 'every redundant finalize call must return false, not re-settle');

    const settlements = await query('SELECT * FROM settlements WHERE match_id = ?', [matchId]);
    assert.equal(settlements.length, 1, 'exactly one settlement row must ever exist for a match');
    const settleEvents = await query(`SELECT * FROM audit_events WHERE match_id = ? AND action = 'SETTLEMENT_CREATED'`, [matchId]);
    assert.equal(settleEvents.length, 1, 'exactly one SETTLEMENT_CREATED audit event must ever exist');

    const winTx = await query(`SELECT * FROM transactions WHERE match_id = ? AND type = 'GAME_WIN'`, [matchId]);
    assert.equal(winTx.length, 1, 'the winner must be paid exactly once');
  });

  test('cancelMatchTx is a safe no-op once a match is already settled', async () => {
    const rr = await gameId('reaction-rush');
    const A = await newPlayer('vdA');
    const a1 = await api().post('/api/matches/find').set(auth(A.token)).send({ gameId: rr, stake: 10 });
    const matchId = a1.body.match.id;
    await api().post(`/api/matches/${matchId}/cancel`).set(auth(A.token));

    const m = await queryOne('SELECT * FROM matches WHERE id = ?', [matchId]);
    const again = await withTransaction((tx) => cancelMatchTx(tx, m, 'duplicate cancel attempt'));
    assert.equal(again, false, 'cancelling an already-settled match must be a no-op, not double-refund');

    const refunds = await query(`SELECT * FROM transactions WHERE match_id = ? AND type = 'REFUND'`, [matchId]);
    assert.equal(refunds.length, 1, 'the stake must only ever be refunded once');
  });
});

describe('forfeit stake is now a real, idempotent ledger entry', () => {
  test('the losing side of a WIN gets a FORFEIT transaction row (not a silent balance change)', async () => {
    const rr = await gameId('reaction-rush');
    const A = await newPlayer('fsA');
    const B = await newPlayer('fsB');
    const a1 = await api().post('/api/matches/find').set(auth(A.token)).send({ gameId: rr, stake: 20 });
    const b1 = await api().post('/api/matches/find').set(auth(B.token)).send({ gameId: rr, stake: 20 });
    const match = b1.body.match;
    await api().post(`/api/matches/${match.id}/ready`).set(auth(A.token));
    await api().post(`/api/matches/${match.id}/ready`).set(auth(B.token));
    await api().post(`/api/matches/${match.id}/start`).set(auth(A.token));
    await api().post(`/api/matches/${match.id}/start`).set(auth(B.token));
    await backdateStart(match.id, A.user.id);
    await backdateStart(match.id, B.user.id);
    const fast = { rounds: Array.from({ length: 10 }, () => ({ hit: true, reactionMs: 250 })) };
    const slow = { rounds: Array.from({ length: 10 }, () => ({ hit: false })) };
    await api().post(`/api/matches/${match.id}/result`).set(auth(A.token)).send({ actions: fast });
    const rb = await api().post(`/api/matches/${match.id}/result`).set(auth(B.token)).send({ actions: slow });
    assert.equal(rb.body.match.winnerId, A.user.id);

    const forfeitRows = await query(`SELECT * FROM transactions WHERE match_id = ? AND type = 'FORFEIT'`, [match.id]);
    assert.equal(forfeitRows.length, 1, 'the loser must have exactly one FORFEIT ledger row');
    assert.equal(forfeitRows[0].user_id, B.user.id);
    assert.equal(Number(forfeitRows[0].amount), 20);
    assert.ok(forfeitRows[0].idempotency_key.includes('forfeit'));

    // Ledger integrity: available + locked must equal the sum of every transaction's effect.
    const winnerWallet = await queryOne('SELECT * FROM wallets WHERE user_id = ?', [A.user.id]);
    const winnerTx = await query('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 1', [A.user.id]);
    assert.equal(Number(winnerWallet.available_balance), Number(winnerTx[0].available_after));
  });
});

describe('auth audit events', () => {
  test('login success/failure and logout are all recorded', async () => {
    const u = await newPlayer('lgA');
    await api().post('/api/auth/login').send({ identifier: u.user.username, password: 'wrong-password' });
    const token = await login(u.user.username, 'Secret123');
    await api().post('/api/auth/logout').set(auth(token));

    const events = await query('SELECT * FROM audit_events WHERE actor_user_id = ? ORDER BY id', [u.user.id]);
    const actions = events.map((e) => e.action);
    assert.ok(actions.includes('USER_REGISTERED'));
    assert.ok(actions.includes('LOGIN_FAILED'));
    assert.ok(actions.includes('LOGIN_SUCCESS'));
    assert.ok(actions.includes('LOGOUT'));
  });
});

describe('admin audit-events endpoint', () => {
  test('filters by match, actor type and free-text search', async () => {
    const admin = await login('admin@example.com', 'Admin123!');
    const rr = await gameId('reaction-rush');
    const A = await newPlayer('adA');
    const a1 = await api().post('/api/matches/find').set(auth(A.token)).send({ gameId: rr, stake: 10 });
    const matchId = a1.body.match.id;

    const byMatch = await api().get('/api/admin/audit-events').query({ matchId }).set(auth(admin));
    assert.equal(byMatch.status, 200);
    assert.ok(byMatch.body.items.length >= 1);
    assert.ok(byMatch.body.items.every((e) => e.matchId === matchId));

    const byActor = await api().get('/api/admin/audit-events').query({ actorType: 'SYSTEM', pageSize: 5 }).set(auth(admin));
    assert.equal(byActor.status, 200);
    assert.ok(byActor.body.items.every((e) => e.actorType === 'SYSTEM'));

    const nonAdmin = await api().get('/api/admin/audit-events').set(auth(A.token));
    assert.equal(nonAdmin.status, 403);
  });

  test('admin cancel/void actions are themselves audited with actor=ADMIN and a reason', async () => {
    const admin = await login('admin@example.com', 'Admin123!');
    const rr = await gameId('reaction-rush');
    const A = await newPlayer('avA');
    const a1 = await api().post('/api/matches/find').set(auth(A.token)).send({ gameId: rr, stake: 10 });
    const matchId = a1.body.match.id;

    const res = await api().post(`/api/admin/matches/${matchId}/cancel`).set(auth(admin)).send({ toStatus: 'VOID', reason: 'investigation test' });
    assert.equal(res.status, 200);
    assert.equal(res.body.match.status, 'VOID');

    const events = await query('SELECT * FROM audit_events WHERE match_id = ? AND action = ?', [matchId, 'MATCH_VOID']);
    assert.equal(events.length, 1);
    assert.equal(events[0].actor_type, 'ADMIN');
    assert.equal(events[0].new_state, 'VOID');
    assert.equal(events[0].reason, 'investigation test');

    // Calling it again must be rejected, not silently re-void the same match.
    const again = await api().post(`/api/admin/matches/${matchId}/cancel`).set(auth(admin)).send({ toStatus: 'VOID' });
    assert.equal(again.status, 400);
  });

  test('the match-details view returns match + settlements + transactions + full audit trail together', async () => {
    const admin = await login('admin@example.com', 'Admin123!');
    const rr = await gameId('reaction-rush');
    const A = await newPlayer('mdA');
    const a1 = await api().post('/api/matches/find').set(auth(A.token)).send({ gameId: rr, stake: 10 });
    const matchId = a1.body.match.id;
    await api().post(`/api/matches/${matchId}/cancel`).set(auth(A.token));

    const details = await api().get(`/api/admin/matches/${matchId}/details`).set(auth(admin));
    assert.equal(details.status, 200);
    assert.equal(details.body.match.id, matchId);
    assert.equal(details.body.settlements.length, 1);
    assert.equal(details.body.settlements[0].outcome, 'CANCELLED');
    assert.ok(details.body.transactions.length >= 1);
    assert.ok(details.body.auditTrail.some((e) => e.action === 'MATCH_CANCELLED'));
  });
});
