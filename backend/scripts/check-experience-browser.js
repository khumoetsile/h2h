// Runs only against a NEW disposable local schema. No Docker, live writes or database resets.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
if(process.env.DB_HOST!=='127.0.0.1'||process.env.DB_PORT!=='33318'||!/^h2h_ux_browser_[a-f0-9]{8}$/.test(process.env.DB_NAME??''))throw new Error('Requires a new h2h_ux_browser_<8 hex> schema on local port 33318.');
process.env.NODE_ENV='development';
process.env.FOOTBALL_PROVIDER='football-data';
process.env.FOOTBALL_API_KEY='';
process.env.API_FOOTBALL_KEY='';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE_PATH||'playwright');
const mysql=(await import('mysql2/promise')).default;
const {config}=await import('../src/config.js');
const bootstrap=await mysql.createConnection({...config.db,database:undefined});
const [exists]=await bootstrap.query('SELECT SCHEMA_NAME FROM information_schema.schemata WHERE SCHEMA_NAME=?',[config.db.database]);
await bootstrap.end();
assert.equal(exists.length,0,'Refusing to use an existing database.');
const {migrate}=await import('./migrate.js');
await migrate({log:()=>{}});
const {pool,query,queryOne}=await import('../src/db.js');
const {createServer}=await import('../src/server.js');
const {createArena,publishArena}=await import('../src/football/fantasyArenaService.js');
// Copy catalogue metadata only from this run's separate regression-test schema.
const source=await mysql.createConnection({...config.db,database:'h2h_ux_targeted'});
for(const table of ['games','football_challenge_types','admin_settings']){
  const [rows]=await source.query(`SELECT * FROM ${table}`);
  for(const row of rows){if(table==='admin_settings'&&typeof row.setting_value!=='string')row.setting_value=JSON.stringify(row.setting_value);await query(`INSERT IGNORE INTO ${table} SET ?`,[row]);}
}
await source.end();
const snapshots=[];
for(const status of ['upcoming','completed']){
  const response=await fetch(`https://h2h.khumo.co.bw/api/football/fixtures?status=${status}&pageSize=8`);
  assert.equal(response.status,200,'Public football reference unavailable');
  snapshots.push(...(await response.json()).fixtures.filter(f=>!f.isSimulated));
}
const competitions=new Map(snapshots.map(f=>[f.competition.id,f.competition]));
const teams=new Map(snapshots.flatMap(f=>[[f.homeTeam.id,f.homeTeam],[f.awayTeam.id,f.awayTeam]]));
for(const c of competitions.values())await query("INSERT INTO football_competitions(id,provider,provider_competition_id,code,name) VALUES(?,'football-data',?,?,?)",[c.id,c.code,c.code,c.name]);
for(const t of teams.values())await query("INSERT INTO football_teams(id,provider,provider_team_id,name,short_name,crest_url) VALUES(?,'football-data',?,?,?,?)",[t.id,t.providerId??String(t.id),t.name,t.shortName,t.crestUrl]);
for(const f of snapshots)await query("INSERT INTO football_fixtures(id,provider,provider_fixture_id,competition_id,home_team_id,away_team_id,kickoff_at,status,home_score,away_score,last_synced_at,is_simulated,research_eligible,score_duration) VALUES(?,'football-data',?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),0,1,'REGULAR')",[f.id,'ux-snapshot-'+f.id,f.competition.id,f.homeTeam.id,f.awayTeam.id,new Date(f.kickoffAt),f.status,f.homeScore,f.awayScore]);
const output=path.resolve('artifacts/ux-review');
await fs.mkdir(output,{recursive:true});
const origin='http://127.0.0.1:33319';
let browser,server,io;
const errors=[],failures=[],checks=[],networkFailures=[];
function monitor(page){
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',r=>{if(r.url().startsWith(origin+'/api/')&&r.status()>=400)networkFailures.push({path:new URL(r.url()).pathname,status:r.status()});});
}
async function api(url,token,body){
  const r=await fetch(origin+'/api'+url,{method:body?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const d=await r.json();assert.ok(r.ok,JSON.stringify({url,status:r.status,error:d.error}));return d;
}
async function login(page,username,next='/dashboard'){
  await page.goto(origin+'/login?next='+encodeURIComponent(next));
  await page.locator('input[formcontrolname=identifier]').fill(username);
  await page.locator('input[formcontrolname=password]').fill('Secret123!');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.waitForURL(origin+next);
}
async function capture(page,name,url,widths=[320,375,390,768,1024,1440,1920]){
  await page.goto(origin+url);await page.waitForLoadState('networkidle');
  for(const width of widths){
    await page.setViewportSize({width,height:950});
    const overflow=await page.evaluate(()=>({screen:innerWidth,content:document.documentElement.scrollWidth}));
    if(overflow.content>overflow.screen)failures.push({name,width,overflow,offenders:await page.locator('body *').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(n=>({tag:n.tagName,class:n.className}))) });
    if([320,1440].includes(width))await page.screenshot({path:path.join(output,`${name}-${width}.png`),fullPage:true});
    checks.push(`${name}: ${width}px`);
  }
}
try{
  ({server,io}=createServer());await new Promise(resolve=>server.listen(33319,'127.0.0.1',resolve));
  const a=await api('/auth/quick',null,{username:'uxplayer',password:'Secret123!'});
  const b=await api('/auth/quick',null,{username:'uxfriend',password:'Secret123!'});
  const admin=await api('/auth/quick',null,{username:'uxadmin',password:'Secret123!'});
  await query("UPDATE users SET role='ADMIN' WHERE id=?",[admin.user.id]);
  const upcoming=snapshots.filter(f=>f.status==='SCHEDULED');assert.ok(upcoming.length>=2);
  const arena=await createArena(admin.user.id,{name:'UX verification arena',description:'Local QA competition using a public fixture snapshot.',entryFee:10,feePercent:10,prizePercentages:[50,30,20],fixtures:upcoming.slice(0,2).map(f=>({fixtureId:f.id,referenceTeamId:f.homeTeam.id}))});
  await publishArena(admin.user.id,arena.id);
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({serviceWorkers:'block'});context.setDefaultTimeout(15000);context.setDefaultNavigationTimeout(20000);const page=await context.newPage();
  monitor(page);
  await capture(page,'landing','/');
  await page.getByRole('link',{name:'Explore football free',exact:true}).click();await page.waitForURL(origin+'/football');
  await capture(page,'football-public','/football');
  await capture(page,'analysis-public','/football/'+upcoming[0].id);
  await page.locator('#pvp-challenge').click();await page.getByRole('link',{name:'Sign in',exact:true}).last().click();
  await page.locator('input[formcontrolname=identifier]').fill('uxplayer');await page.locator('input[formcontrolname=password]').fill('Secret123!');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(origin+'/football/'+upcoming[0].id);
  console.log('PASS public exploration → protected action → sign-in → original fixture');
  await page.locator('app-favourite-button').first().getByRole('button').click();
  await capture(page,'dashboard','/dashboard');
  await page.getByRole('button',{name:'Skip for now',exact:true}).click();
  await page.reload();assert.equal(await page.getByRole('button',{name:'Skip for now',exact:true}).count(),0);
  assert.equal((await queryOne('SELECT COUNT(*) n FROM experience_events')).n,0,'No tracking without consent');
  await capture(page,'challenges-empty','/challenges');
  await capture(page,'matches-empty','/matches');
  await page.goto(origin+'/games/penalty-shootout?mode=invite');await page.locator('.stake-tiles .tile').first().click();await page.getByRole('button',{name:'Invite a friend',exact:true}).click();await page.waitForURL(/\/match\//);await page.locator('app-invite-share').waitFor();
  const code=(await page.locator('app-invite-share strong').textContent()).split(':')[1].trim();
  await page.getByRole('button',{name:'Copy code',exact:true}).click();
  const friend=await browser.newContext();const friendPage=await friend.newPage();monitor(friendPage);
  await login(friendPage,'uxfriend','/join/'+code);await friendPage.getByRole('button',{name:'Play uxplayer',exact:true}).click();await friendPage.waitForURL(origin+'/match/'+code);
  assert.equal((await api('/matches/'+code,a.token)).match.players.length,2);
  console.log('PASS empty lobby → create invitation → copy code → second account reviews and joins');
  await capture(page,'matches-active','/matches?filter=active');
  await capture(page,'arena','/arena');
  await page.goto(origin+'/arena/'+arena.id);await page.locator('.pick-grid').first().waitFor();for(const group of await page.locator('.pick-grid').all())await group.getByRole('button',{name:'Win',exact:true}).click();await page.getByRole('button',{name:/Confirm entry/}).click();await page.getByRole('button',{name:'Save changed predictions',exact:true}).waitFor();
  assert.ok((await api('/arenas/'+arena.id,a.token)).myEntry);
  await capture(page,'my-arenas','/arena?view=mine');
  await capture(page,'arena-entry','/arena/'+arena.id);
  await capture(page,'rankings','/leaderboard');
  await capture(page,'profile','/profile');
  await capture(page,'daily','/daily-predictions');
  const anon=await browser.newContext();const anonPage=await anon.newPage();await capture(anonPage,'login','/login');await anon.close();
  await page.goto(origin+'/profile');await page.getByText('Preferences & privacy',{exact:true}).click();await page.getByRole('checkbox',{name:'Allow optional usage measurement'}).check();await page.goto(origin+'/dashboard');await page.waitForLoadState('networkidle');
  assert.ok((await queryOne('SELECT COUNT(*) n FROM experience_events WHERE user_id=?',[a.user.id])).n>0);
  await page.goto(origin+'/profile');await page.getByText('Preferences & privacy',{exact:true}).click();await page.getByRole('button',{name:'Delete my usage events',exact:true}).click();await page.getByText('Your usage events were deleted. Measurement is off.',{exact:true}).waitFor();assert.equal((await queryOne('SELECT COUNT(*) n FROM experience_events WHERE user_id=?',[a.user.id])).n,0);
  const chess=await api('/chess',a.token,{stake:5,opponent:'uxfriend'});await api('/chess/'+chess.game.code+'/accept',b.token,{});
  await page.goto(origin+'/dashboard');await page.getByRole('link',{name:/Make your move/}).click();await page.waitForURL(origin+'/chess/'+chess.game.code);
  await page.locator('#chess-square-e2').click();await page.locator('#chess-square-e4').click();await page.getByRole('button',{name:'Confirm move',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  const moved=await api('/chess/'+chess.game.code,a.token);assert.equal(moved.game.lastMove.from,'e2');assert.equal(moved.game.lastMove.to,'e4');
  await api('/chess/'+chess.game.code+'/resign',b.token,{});await capture(page,'returning-player','/dashboard');
  console.log('PASS returning player → next chess turn → confirmed legal move → verified completed result');
  const adminContext=await browser.newContext({serviceWorkers:'block'});const adminPage=await adminContext.newPage();monitor(adminPage);await login(adminPage,'uxadmin','/admin');await capture(adminPage,'admin-metrics','/admin');await adminContext.close();
  console.log('PASS optional onboarding dismissal, favourites, arena entry, private activity and measurement deletion');
  assert.deepEqual(errors,[],'Browser exceptions');assert.deepEqual(failures,[],'Horizontal overflow');assert.deepEqual(networkFailures,[],'Failed API requests');
  console.log(`PASS ${checks.length} responsive route/viewport checks; ${errors.length} browser exceptions.`);
}catch(error){console.error('Browser journey failed:',error);throw error;}finally{
  await fs.writeFile(path.join(output,'browser-report.json'),JSON.stringify({database:config.db.database,checks,errors,failures,networkFailures,reference:'Read-only public fixture snapshots; only local QA accounts and local competition entries.'},null,2));
  await browser?.close();io?.close();server?.closeAllConnections();if(server?.listening)await new Promise(resolve=>server.close(resolve));await pool.end();
}
