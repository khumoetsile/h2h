// Invite links: a public preview of the challenge, a two-field sign-up, and joining the match.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rivalis_test';

const { migrate } = await import('../scripts/migrate.js');
const { seed } = await import('../scripts/seed.js');
const { createApp } = await import('../src/app.js');
const { pool, query, queryOne } = await import('../src/db.js');
const request = (await import('supertest')).default;

const app = createApp();
const api = () => request(app);
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let n = 0;
const uname = (p) => `${p}${Date.now().toString(36)}${++n}`.slice(0, 20);

async function host() {
  const u = uname('ih');
  const res = await api().post('/api/auth/register').send({
    firstName: 'Host', lastName: 'Player', username: u, email: `${u}@test.dev`, phone: '+267 71 234 567',
    password: 'Secret123', confirmPassword: 'Secret123',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { token: res.body.token, username: u };
}

describe('invite links', () => {
  test('preview is public, then a new player signs up with two fields, joins and both are in the match', async () => {
    const h = await host();
    const game = await queryOne("SELECT id FROM games WHERE slug = 'penalty-shootout'");
    const created = await api().post('/api/matches').set(auth(h.token)).send({ gameId: game.id, stake: 10 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const code = created.body.match.code;

    const pre = await api().get(`/api/invites/${code}`);
    assert.equal(pre.status, 200);
    assert.equal(pre.body.invite.state, 'OPEN');
    assert.equal(pre.body.invite.from.username, h.username);
    assert.equal(pre.body.invite.game.slug, 'penalty-shootout');
    assert.ok(!JSON.stringify(pre.body).includes('@'), 'no email or contact details in a public preview');

    const friend = uname('fr');
    const q = await api().post('/api/auth/quick').send({ username: friend, password: 'abc123' });
    assert.equal(q.status, 201, JSON.stringify(q.body));
    assert.ok(q.body.token);
    const j = await api().post(`/api/matches/${code}/join`).set(auth(q.body.token));
    assert.equal(j.status, 200, JSON.stringify(j.body));
    assert.equal(j.body.match.players.length, 2);

    // Once taken the link says so, and the same account can sign in normally afterwards.
    assert.equal((await api().get(`/api/invites/${code}`)).body.invite.state, 'TAKEN');
    const login = await api().post('/api/auth/login').send({ identifier: friend, password: 'abc123' });
    assert.equal(login.status, 200);
  });

  test('quick sign-up validates and refuses a taken username', async () => {
    const h = await host();
    assert.equal((await api().post('/api/auth/quick').send({ username: 'a', password: 'abc123' })).status, 400);
    assert.equal((await api().post('/api/auth/quick').send({ username: uname('sh'), password: '123' })).status, 400);
    const dup = await api().post('/api/auth/quick').send({ username: h.username, password: 'abc123' });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error.message, /username/i);
  });

  test('unknown codes, challenges and expired invites are not offered', async () => {
    assert.equal((await api().get('/api/invites/M-DOESNOTEXIST')).status, 404);
    const h = await host();
    const game = await queryOne("SELECT id FROM games WHERE slug = 'penalty-shootout'");
    const created = await api().post('/api/matches').set(auth(h.token)).send({ gameId: game.id, stake: 10 });
    await query('UPDATE matches SET acceptance_deadline = ? WHERE code = ?', [new Date(Date.now() - 1000), created.body.match.code]);
    assert.equal((await api().get(`/api/invites/${created.body.match.code}`)).body.invite.state, 'EXPIRED');
  });
});

before(async () => {
  await migrate({ fresh: true, log: () => {} });
  await seed({ log: () => {} });
});
after(async () => { await pool.end(); });
