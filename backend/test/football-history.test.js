import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV='test';process.env.DB_NAME=process.env.DB_NAME_TEST||'rivalis_test';process.env.FOOTBALL_PROVIDER='mock';
const {migrate}=await import('../scripts/migrate.js');const {seed}=await import('../scripts/seed.js');
const {pool,query,queryOne}=await import('../src/db.js');
const {OpenFootballProvider,digest}=await import('../src/football/providers/openFootballProvider.js');
const {importHistoricalSeason,canonicalSourceName}=await import('../src/football/historyImportService.js');
const {researchTeams,searchTeams}=await import('../src/football/footballResearchService.js');
const {summarizeResearch}=await import('../src/football/historyAnalytics.js');
const provider=new OpenFootballProvider();
let matches,downloads=0;
const fake=new OpenFootballProvider();
fake.loadHistoricalSeason=async(code,season)=>{downloads++;const raw=JSON.stringify({matches});return{raw,hash:digest(raw),url:fake.historicalUrl(code,season),matches:fake.normalizeHistoricalSeason({matches},code,season)};};
before(async()=>{await migrate({fresh:true,log:()=>{}});await seed({log:()=>{}});matches=Array.from({length:25},(_,i)=>({date:`2024-${String(1+Math.floor(i/25)).padStart(2,'0')}-${String(i+1).padStart(2,'0')}`,team1:i%2?'Archive City':'Archive United',team2:i%2?'Archive United':'Archive City',score:{ft:[i%4,i%3]}}));});
after(async()=>pool.end());
test('normalization rejects ambiguous clubs, duplicates and invalid dates; missing scores never become zero',()=>{
  assert.equal(canonicalSourceName('BL1','Bayern München'),'FC Bayern München');assert.equal(canonicalSourceName('SA','Inter'),'FC Internazionale Milano');assert.equal(canonicalSourceName('PD','Real Madrid'),'Real Madrid CF');assert.equal(canonicalSourceName('FL1','Paris Saint-Germain'),'Paris Saint-Germain FC');assert.equal(canonicalSourceName('PL','Liverpool Women'),'Liverpool Women');
  const normalized=provider.normalizeHistoricalSeason({matches:[{date:'2024-01-01',team1:'One',team2:'Two',score:{ht:[0,0]}},{date:'2024-01-02',team1:'Two',team2:'One',status:'AWARDED',score:{ft:[3,0]}}]},'PL','2024-25');
  assert.ok(normalized.every(m=>m.status==='UNVERIFIED'&&m.homeScore===null&&m.statistics===null));
  for(const data of [{date:'2024-02-30',team1:'One',team2:'Two'},{date:'2024-01-01',team1:'One',team2:'One'}])assert.throws(()=>provider.normalizeHistoricalSeason({matches:[data]},'PL','2024-25'));
  assert.throws(()=>provider.normalizeHistoricalSeason({matches:[normalized[0].raw,normalized[0].raw]},'PL','2024-25'),/duplicate/);
  assert.throws(()=>provider.historicalUrl('UNKNOWN','2024-25'));assert.throws(()=>provider.historicalUrl('PL','../../file'));
  const inconsistent=provider.normalizeHistoricalSeason({matches:[{round:'Matchday 37',date:'2019-07-22',team1:'One',team2:'Two',score:{ft:[5,3]}}]},'PL','2019-20');assert.equal(inconsistent[0].status,'UNVERIFIED','A late-season result with an inconsistent year is excluded, never silently redated');
});
test('repeatable imports preserve IDs, exact identities, audit corrections and withdraw removed matches',async()=>{
  matches=[{date:'2024-08-01',team1:'Liverpool',team2:'Chelsea',score:{ft:[2,1],ht:[1,0]}},{date:'2025-02-01',team1:'Chelsea FC',team2:'Liverpool FC',score:{ft:[1,1]}}];
  const first=await importHistoricalSeason('PL','2024-25',{provider:fake});assert.equal(first.imported,2);
  const rows=await query('SELECT * FROM football_history_matches');assert.equal(rows.length,2);
  const beforeIds=rows.map(r=>r.id);const oldFixtures=(await queryOne('SELECT COUNT(*) AS n FROM football_fixtures')).n;
  await importHistoricalSeason('PL','2024-25',{provider:fake});assert.equal(downloads,1,'Stored completed seasons are not downloaded on repeat');
  await importHistoricalSeason('PL','2024-25',{provider:fake,force:true});assert.deepEqual((await query('SELECT id FROM football_history_matches')).map(r=>r.id),beforeIds);
  const names=(await searchTeams({q:'Liverpool'})).teams;assert.equal(names.filter(t=>t.name==='Liverpool FC').length,1);
  const city=await query("SELECT * FROM football_teams WHERE provider='openfootball' AND name='Chelsea FC'");assert.equal(city.length,1);
  const comparison=await researchTeams({teamA:names.find(t=>t.name==='Liverpool FC').id,teamB:city[0].id});
  assert.equal(comparison.headToHead.summary.played,2);assert.equal(comparison.headToHead.summary.goalsFor,3);assert.equal(comparison.headToHead.summary.over15Pct,100);assert.equal(comparison.form.teamA.home.played,1);assert.equal(comparison.form.teamA.away.draws,1);assert.equal(comparison.headToHead.matches[0].statistics,null);
  matches[0]={...matches[0],date:'2024-08-02',score:{ft:[3,1]}};await importHistoricalSeason('PL','2024-25',{provider:fake,force:true});assert.equal((await queryOne('SELECT COUNT(*) AS n FROM football_history_revisions')).n,1);assert.deepEqual((await query('SELECT id FROM football_history_matches')).map(r=>r.id),beforeIds);
  matches=matches.slice(0,1);await importHistoricalSeason('PL','2024-25',{provider:fake,force:true});assert.equal((await queryOne("SELECT COUNT(*) AS n FROM football_history_matches WHERE status='WITHDRAWN'")).n,1);assert.equal((await queryOne('SELECT COUNT(*) AS n FROM football_fixtures')).n,oldFixtures,'Archives never become challenge fixtures');
});
test('similar names remain distinct; local pagination and factual insights retain total sample',async()=>{
  matches=[];for(let i=0;i<12;i++){const season=`${2015+i}-${String(2016+i).slice(-2)}`;matches=[{date:`${2015+i}-08-01`,team1:'Archive United',team2:'Archive United Women',score:{ft:[2,1]}},{date:`${2016+i}-02-01`,team1:'Archive United Women',team2:'Archive United',score:{ft:[0,3]}}];if(i===11)matches=matches.filter(m=>m.date<new Date().toISOString().slice(0,10));await importHistoricalSeason('BL1',season,{provider:fake,force:true});}
  const teams=(await searchTeams({q:'Archive United'})).teams;assert.equal(teams.length,2);
  const a=teams.find(t=>t.name==='Archive United'),b=teams.find(t=>t.name==='Archive United Women');
  const all=await researchTeams({teamA:a.id,teamB:b.id});assert.ok(all.headToHead.summary.played>20);assert.equal(all.headToHead.matches.length,20);assert.equal(all.headToHead.hasMore,true);
  const page2=await researchTeams({teamA:a.id,teamB:b.id,page:2});assert.equal(page2.headToHead.summary.played,all.headToHead.summary.played);assert.equal(new Set([...all.headToHead.matches,...page2.headToHead.matches].map(m=>m.id)).size,all.headToHead.summary.played);
  const five=await researchTeams({teamA:a.id,teamB:b.id,meetings:'5',form:5});assert.equal(five.headToHead.summary.played,5);assert.equal(five.form.teamA.summary.played,5);assert.equal(five.form.teamA.home.played,5);assert.ok(five.insights.every(i=>i.denominator>=3&&i.numerator<=i.denominator));assert.match(five.insights[0].text,/of the last 5/);
});
test('frequencies, clean sheets and two-decimal averages use only valid completed scores',()=>{
  const s=summarizeResearch([{teamScore:0,opponentScore:0},{teamScore:2,opponentScore:1},{teamScore:4,opponentScore:0},{teamScore:null,opponentScore:0}]);assert.equal(s.played,3);assert.equal(s.over15Pct,67);assert.equal(s.over35Pct,33);assert.equal(s.bothTeamsScoredPct,33);assert.equal(s.cleanSheets,2);assert.equal(s.opponentCleanSheets,1);assert.equal(s.averageGoals,2.33);assert.equal(s.winPct,67);
});
test('source errors log and retain the last good archive; pages never need network',async()=>{
  const previous=await queryOne("SELECT COUNT(*) AS n FROM football_history_matches WHERE status='FINISHED'");fake.loadHistoricalSeason=async()=>{throw new Error('Fixture source unavailable');};await assert.rejects(importHistoricalSeason('PL','2024-25',{provider:fake,force:true}),/unavailable/);assert.equal((await queryOne("SELECT COUNT(*) AS n FROM football_history_matches WHERE status='FINISHED'")).n,previous.n);assert.equal((await queryOne("SELECT status FROM football_history_imports WHERE competition_code='PL' AND season='2024-25'")).status,'ERROR');
  const original=globalThis.fetch;globalThis.fetch=()=>{throw new Error('No external requests');};try{const teams=(await searchTeams({q:'Liverpool'})).teams;const other=(await searchTeams({q:'Chelsea'})).teams;const r=await researchTeams({teamA:teams.find(t=>t.name==='Liverpool FC').id,teamB:other.find(t=>t.name==='Chelsea FC').id});assert.equal(r.metadata.stale,true);}finally{globalThis.fetch=original;}
});
test('a conflicting synced score is excluded rather than choosing one source silently',async()=>{
  const history=await queryOne("SELECT * FROM football_history_matches WHERE status='FINISHED' AND home_score<>away_score LIMIT 1");
  await query(`INSERT INTO football_fixtures(provider,provider_fixture_id,competition_id,home_team_id,away_team_id,kickoff_at,status,home_score,away_score,is_simulated,research_eligible) VALUES('mock','history-conflict',?,?,?,?, 'FINISHED',?, ?,1,1)`,[history.competition_id,history.home_team_id,history.away_team_id,new Date(history.match_date),history.home_score+1,history.away_score]);
  const result=await researchTeams({teamA:history.home_team_id,teamB:history.away_team_id,competitionId:history.competition_id});assert.equal(result.metadata.conflicts,1);assert.ok(!result.headToHead.matches.some(m=>m.historicalId===history.id));
});
test('download permissions and cooldowns are bounded without bypassing source restrictions',async()=>{
  let calls=0;await assert.rejects(provider.loadHistoricalSeason('PL','2024-25',{fetcher:async()=>{calls++;return {status:429,headers:new Headers({'retry-after':'60'})};}}),/cooldown/);assert.equal(calls,1);
  await assert.rejects(provider.loadHistoricalSeason('PL','2024-25',{fetcher:async()=>({status:403,ok:false,headers:new Headers()})}),/403/);
  await assert.rejects(provider.loadHistoricalSeason('PL','2024-25',{fetcher:async()=>({status:200,ok:true,headers:new Headers({'content-length':'3000000'})})}),/size limit/);
});
