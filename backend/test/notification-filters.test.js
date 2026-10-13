import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rivalis_test';
const { migrate } = await import('../scripts/migrate.js');
const { seed } = await import('../scripts/seed.js');
const { createApp } = await import('../src/app.js');
const { pool, query, queryOne } = await import('../src/db.js');
const request = (await import('supertest')).default;
const api = () => request(createApp());
let token, userId, otherId;
const auth = () => ({ Authorization: `Bearer ${token}` });
before(async () => {
  await migrate({ fresh: true, log: () => {} });
  await seed({ log: () => {} });
  const login = await api().post('/api/auth/login').send({ identifier: 'player', password: 'Player123!' });
  token = login.body.token;
  userId = login.body.user.id;
  otherId = (await queryOne("SELECT id FROM users WHERE username = 'kabelo'")).id;
  await query('DELETE FROM notifications WHERE user_id = ?', [userId]);
  for (const [type, title, message, link, read] of [
    ['CHESS_TURN', 'Chess turn', 'Your move', '/chess/M-CHESS', 0],
    ['MATCH_FOUND', 'Football game', 'Your match', '/football/1', 0],
    ['DEPOSIT', 'Deposit received', 'P20 DEMO', '/wallet', 0],
    ['CHALLENGE_RECEIVED', 'Literal 100% title', 'A_B result', '/challenges', 1],
    ['GENERAL', 'Welcome', 'Helpful account information', '/profile', 0],
  ]) await query('INSERT INTO notifications (user_id, type, title, message, link, is_read) VALUES (?, ?, ?, ?, ?, ?)', [userId, type, title, message, link, read]);
  await query("INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'GENERAL', 'Other user private note', 'Do not expose')", [otherId]);
});
after(async () => pool.end());

test('pagination is stable and unread count stays global while categories/search filter total', async () => {
  const page1 = await api().get('/api/notifications').set(auth()).query({ pageSize: 2, page: 1 });
  const page2 = await api().get('/api/notifications').set(auth()).query({ pageSize: 2, page: 2 });
  assert.equal(page1.status, 200, JSON.stringify(page1.body));
  assert.equal(page1.body.total, 5);
  assert.equal(page1.body.unread, 4);
  assert.equal(new Set([...page1.body.notifications, ...page2.body.notifications].map(n => n.id)).size, 4);
  assert.ok(page1.body.notifications.every(n => n.title !== 'Other user private note'));
  const games = await api().get('/api/notifications').set(auth()).query({ category: 'games' });
  assert.equal(games.body.total, 2);
  assert.ok(games.body.notifications.every(n => n.category === 'games'));
  assert.equal(games.body.unread, 4);
  const football = await api().get('/api/notifications').set(auth()).query({ category: 'football' });
  assert.equal(football.body.total, 1);
  assert.equal(football.body.notifications[0].category, 'football');
  const wallet = await api().get('/api/notifications').set(auth()).query({ category: 'wallet', unread: true });
  assert.equal(wallet.body.total, 1);
  assert.equal(wallet.body.notifications[0].type, 'DEPOSIT');
});

test('notification search treats wildcard characters literally and validates pagination/filter choices', async () => {
  assert.equal((await api().get('/api/notifications').set(auth()).query({ search: '%' })).body.total, 1);
  assert.equal((await api().get('/api/notifications').set(auth()).query({ search: '_' })).body.total, 1);
  for (const q of [{ page: 0 }, { pageSize: 51 }, { unread: 'perhaps' }, { category: 'invalid' }, { search: 'x'.repeat(101) }]) assert.equal((await api().get('/api/notifications').set(auth()).query(q)).status, 400);
});

test('read all returns the actual count and future notifications remain unread', async () => {
  const res = await api().post('/api/notifications/read-all').set(auth());
  assert.equal(res.status, 200);
  assert.equal(res.body.unread, 0);
  await query("INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'GENERAL', 'After read all', 'New note')", [userId]);
  const after = await api().get('/api/notifications').set(auth()).query({ unread: 'true' });
  assert.equal(after.body.unread, 1);
  assert.equal(after.body.total, 1);
});

test('football settlement and legacy direct challenge notifications are classified consistently', async () => {
  const game = await queryOne("SELECT id FROM games WHERE slug = 'football'");
  await query(`INSERT INTO matches (code, game_id, category, stake, pool, fee_percent, fee_amount, prize, status, source, created_by, seed)
    VALUES ('M-NOTEFOOT', ?, 'FOOTBALL', 5, 10, 10, 1, 9, 'COMPLETED', 'CHALLENGE', ?, 1)`, [game.id, userId]);
  await query("INSERT INTO notifications (user_id, type, title, message, link) VALUES (?, 'MATCH_WON', 'Football settled', 'Final result', '/matches/M-NOTEFOOT')", [userId]);
  await query("INSERT INTO notifications (user_id, type, title, message, link) VALUES (?, 'CHALLENGE_RECEIVED', 'Direct football challenge', 'A friend challenged you on a football match', '/challenges')", [userId]);
  const football = await api().get('/api/notifications').set(auth()).query({ category: 'football' });
  assert.equal(football.body.total, 3);
  assert.ok(football.body.notifications.every(n => n.category === 'football'));
  const games = await api().get('/api/notifications').set(auth()).query({ category: 'games' });
  assert.ok(games.body.notifications.every(n => n.title !== 'Football settled' && n.title !== 'Direct football challenge'));
});
