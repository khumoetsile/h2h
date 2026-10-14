import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV='test';process.env.DB_NAME=process.env.DB_NAME_TEST||'rivalis_test';
const {migrate}=await import('../scripts/migrate.js');const {seed}=await import('../scripts/seed.js');
const {pool,query,queryOne}=await import('../src/db.js');
const {config}=await import('../src/config.js');
const {ApiFootballProvider,normalizeApiFootballMeeting,normalizeApiFootballStatistics}=await import('../src/football/providers/apiFootballProvider.js');
const {importApiFootballFixture,selectApiFootballTeam,reserveApiFootballRequest}=await import('../src/football/apiFootballHistoryService.js');
const {researchTeams}=await import('../src/football/footballResearchService.js');
before(async()=>{await migrate({fresh:true,log:()=>{}});await seed({log:()=>{}});});
after(async()=>pool.end());
const raw=(id=1126337)=>({fixture:{id,date:'2023-09-21T16:45:00Z',status:{short:'FT'}},league:{id:3,name:'UEFA Europa League',country:'World',season:2023},teams:{home:{id:1026,name:'Lask Linz'},away:{id:40,name:'Liverpool'}},score:{fulltime:{home:1,away:3},halftime:{home:1,away:0}}});
test('API-Football validates errors inside HTTP 200, fixed origin, and quota reservation before sending',async()=>{
  let reserved=0,calls=0;const p=new ApiFootballProvider({apiKey:'test-only',intervalMs:0,reserveRequest:async()=>reserved++,fetcher:async(url,options)=>{calls++;assert.equal(url.origin,'https://v3.football.api-sports.io');assert.equal(options.headers['x-apisports-key'],'test-only');return new Response(JSON.stringify({errors:{plan:'unsupported'},response:[]}),{status:200});}});
  await assert.rejects(()=>p.headToHead(40,1026),/rejected/);assert.equal(reserved,1);
  await assert.rejects(()=>p.get('https://wrong.example/'),/origin/);assert.equal(calls,1);
  p.reserveRequest=async()=>{throw new Error('budget reached');};await assert.rejects(()=>p.headToHead(40,1026),/budget/);assert.equal(calls,1);
});
test('scheduled, awarded and extra-time matches are excluded; incorrect pairings cannot be linked',()=>{
  assert.equal(normalizeApiFootballMeeting(raw(),1026,40).homeScore,1);
  for(const status of ['NS','AWD','AET','PEN','CANC']){const m=raw();m.fixture.status.short=status;assert.equal(normalizeApiFootballMeeting(m,1026,40),null);}
  const future=raw();future.fixture.date='2099-01-01T00:00:00Z';assert.equal(normalizeApiFootballMeeting(future,1026,40),null);
  assert.throws(()=>normalizeApiFootballMeeting(raw(),1026,99),/pairing/);
  const unknown=raw();unknown.score.fulltime.home=null;assert.equal(normalizeApiFootballMeeting(unknown,1026,40),null);
});
test('club matching keeps countries and youth/women clubs distinct; missing statistics stay null',()=>{
  const rows=[{team:{id:40,name:'Liverpool',country:'England'}},{team:{id:10,name:'Liverpool W',country:'England'}},{team:{id:20,name:'Liverpool',country:'Uruguay'}}];
  assert.equal(selectApiFootballTeam({name:'Liverpool FC'},rows,null).id,40);
  assert.throws(()=>selectApiFootballTeam({name:'Liverpool W'},[],null),/unique/);
  assert.throws(()=>selectApiFootballTeam({name:'Liverpool'},rows,null),/unique/);
  const stats=normalizeApiFootballStatistics([{team:{id:40},statistics:[{type:'Ball Possession',value:'64%'},{type:'Corner Kicks',value:0}]}],1026,40);
  assert.deepEqual(stats.possession,[null,64]);assert.deepEqual(stats.corners,[null,0]);assert.deepEqual(stats.shots,[null,null]);
});
test('ASCII discovery preserves exact accented club identity and distinguishes coverage/quota errors',async()=>{
  let search;const p=new ApiFootballProvider({apiKey:'test-only',intervalMs:0,fetcher:async url=>{search=url.searchParams.get('search');return new Response(JSON.stringify({errors:[],response:[{team:{id:157,name:'Bayern München',country:'Germany'}}]}));}});
  const rows=await p.teams('Bayern München');assert.equal(search,'Bayern Munchen');assert.equal(selectApiFootballTeam({name:'FC Bayern München'},rows,null).id,157);
  p.fetcher=async()=>new Response(JSON.stringify({errors:{search:'Invalid characters'},response:[]}));await assert.rejects(()=>p.teams('Club'),e=>e.code==='API_SEARCH_REJECTED');
  p.fetcher=async()=>new Response(JSON.stringify({errors:{requests:'Quota exhausted'},response:[]}));await assert.rejects(()=>p.headToHead(1,2),e=>e.code==='API_QUOTA');
});
test('history import reuses local clubs, handles cross-competition meetings, corrections, empty/outage responses and daily caching',async()=>{
  const c=await query("INSERT INTO football_competitions(provider,provider_competition_id,code,name,country) VALUES('football-data','api-test','CL','UEFA Champions League','Europe')");
  const h=await query("INSERT INTO football_teams(provider,provider_team_id,name) VALUES('football-data','api-test-lask','LASK Linz')");const a=await query("INSERT INTO football_teams(provider,provider_team_id,name) VALUES('football-data','api-test-liverpool','Liverpool FC')");
  const f=await query("INSERT INTO football_fixtures(provider,provider_fixture_id,competition_id,home_team_id,away_team_id,kickoff_at,status,is_simulated) VALUES('football-data','api-test',?,?,?,NOW(),'SCHEDULED',0)",[c.insertId,h.insertId,a.insertId]);
  let meetings=[raw()],calls=0;const provider={teams:async name=>{calls++;return[{team:{id:name==='Liverpool'?40:1026,name,country:name==='Liverpool'?'England':'Austria'}}];},headToHead:async()=>{calls++;return meetings;},statistics:async()=>[]};
  const initial=await importApiFootballFixture(f.insertId,{provider});assert.equal(initial.imported,1);
  const repeat=await importApiFootballFixture(f.insertId,{provider});assert.equal(repeat.skipped,'checked within 24 hours');assert.equal(calls,3);
  let result=await researchTeams({teamA:h.insertId,teamB:a.insertId,venue:'all'});assert.equal(result.headToHead.summary.played,1);assert.equal(result.headToHead.matches[0].competition.code,'EL');assert.equal(result.teamA.id,h.insertId);
  meetings[0].score.fulltime.home=2;await importApiFootballFixture(f.insertId,{provider,force:true});assert.equal((await queryOne("SELECT COUNT(*) AS n FROM football_history_revisions")).n,1);
  meetings=[];await importApiFootballFixture(f.insertId,{provider,force:true});result=await researchTeams({teamA:h.insertId,teamB:a.insertId,venue:'all'});assert.equal(result.headToHead.summary.played,1);
  provider.headToHead=async()=>{throw new Error('quota reached');};await assert.rejects(()=>importApiFootballFixture(f.insertId,{provider,force:true}),/quota/);result=await researchTeams({teamA:h.insertId,teamB:a.insertId,venue:'all'});assert.equal(result.headToHead.summary.played,1);assert.equal(result.metadata.stale,true);
  assert.equal((await queryOne("SELECT COUNT(*) AS n FROM football_fixtures WHERE provider='api-football'")).n,0);
});
test('persistent request budget stops concurrent reservations exactly at the limit',async()=>{
  const old=config.football.historyDailyRequests;config.football.historyDailyRequests=2;
  try{const r=await Promise.allSettled([reserveApiFootballRequest(),reserveApiFootballRequest(),reserveApiFootballRequest()]);assert.equal(r.filter(v=>v.status==='fulfilled').length,2);assert.equal((await queryOne("SELECT requests FROM football_history_api_usage WHERE source='api-football'")).requests,2);}finally{config.football.historyDailyRequests=old;}
});
