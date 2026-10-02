// Ads are inert until a publisher ID is configured; then the config and ads.txt carry it.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rivalis_test';
process.env.ADSENSE_CLIENT = 'ca-pub-1234567890123456';
process.env.ADSENSE_SLOT_HOME = '1111111111';

const { migrate } = await import('../scripts/migrate.js');
const { seed } = await import('../scripts/seed.js');
const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const request = (await import('supertest')).default;

before(async () => {
  await migrate({ fresh: true, log: () => {} });
  await seed({ log: () => {} });
});
after(async () => { await pool.end(); });

describe('ads configuration', () => {
  test('the public config exposes the publisher and slot IDs, and ads.txt authorises Google', async () => {
    const app = createApp();
    const cfg = await request(app).get('/api/config');
    assert.equal(cfg.status, 200);
    assert.deepEqual(cfg.body.ads, { client: 'ca-pub-1234567890123456', slots: { home: '1111111111', list: '' } });
    const txt = await request(app).get('/ads.txt');
    assert.equal(txt.status, 200);
    assert.match(txt.type, /text\/plain/);
    assert.equal(txt.text.trim(), 'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0');
  });
});
