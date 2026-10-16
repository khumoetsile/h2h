import {test,afterEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {selectAutomaticSlips} from '../src/football/automaticArenaService.js';
import {FootballDataOrgProvider} from '../src/football/providers/footballDataOrgProvider.js';
import {pool} from '../src/db.js';
after(()=>pool.end());
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
test('automatic selection prioritises big-club meetings, stays within major leagues and bounds daily slips',()=>{
  const rows=Array.from({length:8},(_,i)=>({id:i+1,code:'PL',home_provider_id:'65',away_provider_id:i===7?'64':'9999',kickoff_at:`2030-01-02T${String(10+i).padStart(2,'0')}:00:00Z`}));
  rows.push({id:20,code:'LOWER',home_provider_id:'65',away_provider_id:'64',kickoff_at:'2030-01-02T09:00:00Z'});
  const slips=selectAutomaticSlips(rows);
  assert.equal(slips.length,1);assert.equal(slips[0].fixtures.length,5);
  assert.ok(slips[0].fixtures.some(f=>f.id===8));assert.ok(!slips[0].fixtures.some(f=>f.id===20));
  assert.deepEqual(selectAutomaticSlips(rows.slice(0,2)),[]);
  assert.deepEqual(selectAutomaticSlips(rows.map(f=>({...f,home_provider_id:'9998',away_provider_id:'9999'}))),[]);
});
test('competition and fixture-window caching prevents redundant polling and shares concurrent calls',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({competitions:[],matches:[]}));};
  const p=new FootballDataOrgProvider({apiKey:'test',baseUrl:'https://example.test'});
  await Promise.all([p.listCompetitions(),p.listCompetitions()]);await p.listCompetitions();
  assert.equal(calls,1);
  await p.listUpcomingFixtures('PL','2030-01-01','2030-01-08');
  await p.listUpcomingFixtures('PL','2030-01-01','2030-01-08');assert.equal(calls,2);
});
test('rate limits stop further network calls during cooldown, and recent-score batches include finals',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return new Response('Too many requests',{status:429,headers:{'retry-after':'60'}});};
  const p=new FootballDataOrgProvider({apiKey:'test',baseUrl:'https://example.test'});
  await assert.rejects(p.listCompetitions(),/429/);await assert.rejects(p.getFixture('1'),/cooling down/);assert.equal(calls,1);
  globalThis.fetch=async()=>new Response(JSON.stringify({matches:[{id:1,competition:{code:'PL'},utcDate:'2030-01-01T12:00:00Z',status:'FINISHED',score:{duration:'REGULAR',fullTime:{home:2,away:1}},homeTeam:{id:65},awayTeam:{id:64}}]}));
  const scores=await new FootballDataOrgProvider({apiKey:'test',baseUrl:'https://example.test'}).getLiveFixtures();
  assert.equal(scores[0].status,'FINISHED');assert.equal(scores[0].competitionProviderId,'PL');assert.equal(scores[0].researchEligible,true);
});
