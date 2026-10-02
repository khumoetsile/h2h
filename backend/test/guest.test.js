// Guest accounts: tap Play, get an account with no form, play, and save it later with a password.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rivalis_test';

const { migrate } = await import('../scripts/migrate.js');
const { seed } = await import('../scripts/seed.js');
const { createApp } = await import('../src/app.js');
const { pool, queryOne } = await import('../src/db.js');
const request = (await import('supertest')).default;

const app = createApp();
const api = () => request(app);
const auth = (t) => ({ Authorization: `Bearer ${t}` });

before(async () => {
  await migrate({ fresh: true, log: () => {} });
  await seed({ log: () => {} });
});
after(async () => { await pool.end(); });

describe('guest accounts', () => {
  test('one call makes a playable account with a friendly name, a wallet and a session', async () => {
    const g = await api().post('/api/auth/guest').send({});
    assert.equal(g.status, 201, JSON.stringify(g.body));
    assert.ok(g.body.token);
    assert.equal(g.body.user.isGuest, true);
    assert.match(g.body.user.username, /^[A-Z][a-z]+[A-Z][a-z]+\d+$/);
    const me = await api().get('/api/me').set(auth(g.body.token));
    assert.equal(me.status, 200);
    assert.equal(me.body.user.isGuest, true);
    assert.ok(me.body.wallet.available > 0, 'gets the welcome balance so they can play right away');
    // Two guests never collide.
    const g2 = await api().post('/api/auth/guest').send({});
    assert.notEqual(g2.body.user.username, g.body.user.username);
  });

  test('a guest can start a practice match straight away', async () => {
    const g = await api().post('/api/auth/guest').send({});
    const game = await queryOne("SELECT id FROM games WHERE slug = 'penalty-shootout'");
    const p = await api().post('/api/matches/practice').set(auth(g.body.token)).send({ gameId: game.id, stake: 10 });
    assert.equal(p.status, 201, JSON.stringify(p.body));
  });

  test('saving the account sets a password and optionally a name; after that they can sign in', async () => {
    const g = await api().post('/api/auth/guest').send({});
    const wanted = `Keeper${Date.now().toString(36)}`.slice(0, 20);
    assert.equal((await api().post('/api/auth/claim').set(auth(g.body.token)).send({ password: '123' })).status, 400);
    const c = await api().post('/api/auth/claim').set(auth(g.body.token)).send({ password: 'secret1', username: wanted });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.user.isGuest, false);
    assert.equal(c.body.user.username, wanted);
    const login = await api().post('/api/auth/login').send({ identifier: wanted, password: 'secret1' });
    assert.equal(login.status, 200);
    // Already saved: a second claim is refused.
    assert.equal((await api().post('/api/auth/claim').set(auth(g.body.token)).send({ password: 'another1' })).status, 409);
  });

  test('claiming with a taken name is refused and leaves the guest as they were', async () => {
    const a = await api().post('/api/auth/guest').send({});
    const b = await api().post('/api/auth/guest').send({});
    const r = await api().post('/api/auth/claim').set(auth(b.body.token)).send({ password: 'secret1', username: a.body.user.username });
    assert.equal(r.status, 409);
    assert.equal((await api().get('/api/me').set(auth(b.body.token))).body.user.isGuest, true);
  });
});
