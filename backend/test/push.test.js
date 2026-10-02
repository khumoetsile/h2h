// Web push: subscribing, and the notification a waiting player gets when a friend joins their invite.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rivalis_test';

const { migrate } = await import('../scripts/migrate.js');
const { seed } = await import('../scripts/seed.js');
const { createApp } = await import('../src/app.js');
const { pool, query, queryOne } = await import('../src/db.js');
const push = await import('../src/services/pushService.js');
const request = (await import('supertest')).default;

const app = createApp();
const api = () => request(app);
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let n = 0;
const uname = (p) => `${p}${Date.now().toString(36)}${++n}`.slice(0, 20);

async function player() {
  const u = uname('pu');
  const res = await api().post('/api/auth/register').send({
    firstName: 'Push', lastName: 'Player', username: u, email: `${u}@test.dev`, phone: '+267 71 234 567',
    password: 'Secret123', confirmPassword: 'Secret123',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { token: res.body.token, id: res.body.user.id, username: u };
}

const sub = (tag) => ({ endpoint: `https://push.example.test/send/${tag}`, keys: { p256dh: 'BPubKey' + tag, auth: 'auth' + tag } });
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  return fn();
};

before(async () => {
  await migrate({ fresh: true, log: () => {} });
  await seed({ log: () => {} });
  push.setEnabledForTests(true);
});
after(async () => {
  push.setEnabledForTests(null);
  push.setSender(null);
  await pool.end();
});

describe('web push', () => {
  test('the key is only for signed-in players, and subscribing twice keeps a single row', async () => {
    assert.equal((await api().get('/api/push/key')).status, 401);
    const p = await player();
    const key = await api().get('/api/push/key').set(auth(p.token));
    assert.equal(key.status, 200);
    assert.ok(key.body.publicKey);
    const s = sub('one' + p.id);
    assert.equal((await api().post('/api/push/subscribe').set(auth(p.token)).send(s)).status, 201);
    assert.equal((await api().post('/api/push/subscribe').set(auth(p.token)).send(s)).status, 201);
    assert.equal(await push.subscriptionCount(p.id), 1);
    assert.equal((await api().post('/api/push/subscribe').set(auth(p.token)).send({ endpoint: 'nope', keys: {} })).status, 400);
    assert.equal((await api().post('/api/push/unsubscribe').set(auth(p.token)).send({ endpoint: s.endpoint })).status, 200);
    assert.equal(await push.subscriptionCount(p.id), 0);
  });

  test('when a friend joins an invite, the waiting player gets a push that opens the match', async () => {
    const sent = [];
    push.setSender(async (s, body) => { sent.push({ s, body: JSON.parse(body) }); });
    const host = await player();
    await api().post('/api/push/subscribe').set(auth(host.token)).send(sub('host' + host.id));
    const game = await queryOne("SELECT id FROM games WHERE slug = 'penalty-shootout'");
    const created = await api().post('/api/matches').set(auth(host.token)).send({ gameId: game.id, stake: 10 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const code = created.body.match.code;

    const friend = await player();
    assert.equal((await api().post(`/api/matches/${code}/join`).set(auth(friend.token))).status, 200);

    const got = await until(() => sent.find((x) => x.body.url === `/match/${code}`));
    assert.ok(got, 'the host should have been pushed');
    assert.match(got.body.body, new RegExp(friend.username));
    assert.equal(got.s.endpoint, `https://push.example.test/send/host${host.id}`);
    // The friend has no subscription, so nothing else went out.
    assert.equal(sent.every((x) => x.s.endpoint.includes('host')), true);
  });

  test('a subscription the phone has dropped (410) is removed, and a failing push does not break the action', async () => {
    push.setSender(async () => { const e = new Error('gone'); e.statusCode = 410; throw e; });
    const p = await player();
    await api().post('/api/push/subscribe').set(auth(p.token)).send(sub('dead' + p.id));
    assert.equal(await push.sendToUser(p.id, { title: 't', body: 'b', url: '/' }), 0);
    assert.equal(await push.subscriptionCount(p.id), 0);
    // Errors other than "gone" are swallowed and keep the subscription.
    push.setSender(async () => { throw new Error('network down'); });
    await api().post('/api/push/subscribe').set(auth(p.token)).send(sub('flaky' + p.id));
    assert.equal(await push.sendToUser(p.id, { title: 't', body: 'b', url: '/' }), 0);
    assert.equal(await push.subscriptionCount(p.id), 1);
  });

  test('with push switched off nothing is sent and the key is null', async () => {
    push.setEnabledForTests(false);
    try {
      const sent = [];
      push.setSender(async (s) => { sent.push(s); });
      const p = await player();
      assert.equal((await api().get('/api/push/key').set(auth(p.token))).body.publicKey, null);
      await query('INSERT INTO push_subscriptions (user_id, endpoint_hash, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)', [p.id, 'x'.repeat(64), 'https://push.example.test/x', 'k', 'a']);
      assert.equal(await push.sendToUser(p.id, { title: 't', body: 'b' }), 0);
      assert.equal(sent.length, 0);
    } finally { push.setEnabledForTests(true); }
  });
});
