import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
process.env.NODE_ENV='test';
process.env.DB_NAME=process.env.DB_NAME_TEST || 'rivalis_test';
const {migrate}=await import('../scripts/migrate.js');
const {seed}=await import('../scripts/seed.js');
const {createApp}=await import('../src/app.js');
const {pool,query,queryOne}=await import('../src/db.js');
const request=(await import('supertest')).default;
const app=createApp();
const auth=token=>({Authorization:`Bearer ${token}`});
let player,other,admin;
async function account(prefix){
  const username=(prefix+randomUUID().replaceAll('-','')).slice(0,20);
  const r=await request(app).post('/api/auth/quick').send({username,password:'Secret123!'});
  assert.equal(r.status,201,JSON.stringify(r.body));return r.body;
}
before(async()=>{await migrate({fresh:true,log:()=>{}});await seed({log:()=>{}});player=await account('xp');other=await account('xo');admin=await account('xa');await query("UPDATE users SET role='ADMIN' WHERE id=?",[admin.user.id]);});
after(async()=>pool.end());
test('public rankings expose only competitive fields and keep personal position private',async()=>{
  const r=await request(app).get('/api/leaderboard');assert.equal(r.status,200);assert.equal(r.body.me,null);
  const keys=Object.keys(r.body.entries[0]);
  for(const forbidden of ['email','phone','available','locked','password_hash','wallet'])assert.ok(!keys.includes(forbidden));
  assert.equal((await request(app).get('/api/wallet')).status,401);
  assert.equal((await request(app).get('/api/dashboard')).status,401);
});
test('activity count uses the full match query total',async()=>{
  const game=await queryOne("SELECT id FROM games WHERE slug='penalty-shootout'");
  assert.equal((await request(app).post('/api/matches').set(auth(player.token)).send({gameId:game.id,stake:10})).status,201);
  const r=await request(app).get('/api/dashboard').set(auth(player.token));
  const matches=await request(app).get('/api/matches?status=active&pageSize=1').set(auth(player.token));
  assert.equal(r.status,200);assert.equal(r.body.activeMatchCount,matches.body.total);assert.equal(r.body.activeMatchCount,1);
});
test('measurement authenticates, validates allowlisted categories and deduplicates concurrent events',async()=>{
  const body={eventId:randomUUID(),visitId:randomUUID(),event:'page_view',surface:'home'};
  assert.equal((await request(app).post('/api/experience/events').send(body)).status,401);
  assert.equal((await request(app).post('/api/experience/events').set(auth(player.token)).send({...body,route:'/reset-password?token=secret'})).status,400);
  assert.equal((await request(app).post('/api/experience/events').set(auth(player.token)).send({...body,surface:'wallet'})).status,400);
  const rows=await Promise.all(Array.from({length:8},()=>request(app).post('/api/experience/events').set(auth(player.token)).send(body)));
  rows.forEach(r=>assert.equal(r.status,204));
  assert.equal((await queryOne('SELECT COUNT(*) n FROM experience_events WHERE event_id=?',[body.eventId])).n,1);
});
test('aggregate metrics are admin-only and deleting events never affects another account',async()=>{
  const body={eventId:randomUUID(),visitId:randomUUID(),event:'empty_recovery',surface:'challenges'};
  assert.equal((await request(app).post('/api/experience/events').set(auth(other.token)).send(body)).status,204);
  assert.equal((await request(app).get('/api/experience/summary').set(auth(player.token))).status,403);
  const summary=await request(app).get('/api/experience/summary').set(auth(admin.token));
  assert.equal(summary.status,200,JSON.stringify(summary.body));assert.equal(summary.body.retention.length,3);assert.equal(summary.body.active.dailyActive,2);
  assert.ok(!JSON.stringify(summary.body).includes(player.user.username));
  assert.equal((await request(app).delete('/api/experience/events').set(auth(player.token))).status,204);
  assert.equal((await queryOne('SELECT COUNT(*) n FROM experience_events WHERE user_id=?',[player.user.id])).n,0);
  assert.equal((await queryOne('SELECT COUNT(*) n FROM experience_events WHERE user_id=?',[other.user.id])).n,1);
});
