import {pool,query,queryOne,withTransaction} from '../db.js';
import {config} from '../config.js';
import {digest} from './providers/openFootballProvider.js';
import {ApiFootballProvider,API_FOOTBALL_BASE,normalizeApiFootballMeeting,normalizeApiFootballStatistics} from './providers/apiFootballProvider.js';

// Reviewed names, not fuzzy matching: never merge men's/women's/youth clubs.
const reviewed={
  'SSC Napoli':['Napoli','Italy'],'Bologna FC 1909':['Bologna','Italy'],
  'AS Roma':['AS Roma','Italy'],'AC Milan':['AC Milan','Italy'],
  'Borussia Dortmund':['Borussia Dortmund','Germany'],'Bayer 04 Leverkusen':['Bayer Leverkusen','Germany'],
  '1. FC Union Berlin':['Union Berlin','Germany'],'SV Werder Bremen':['Werder Bremen','Germany'],
  '1. FSV Mainz 05':['FSV Mainz 05','Germany'],'1. FC Köln':['1. FC Köln','Germany'],
  'Villarreal CF':['Villarreal','Spain'],'Real Betis Balompié':['Real Betis','Spain'],
  'RCD Espanyol de Barcelona':['Espanyol','Spain'],'Fenerbahçe SK':['Fenerbahce','Turkey'],
  'Ipswich Town FC':['Ipswich','England'],'Hull City AFC':['Hull City','England'],
  'Frosinone Calcio':['Frosinone','Italy'],'Le Mans FC':['Le Mans','France'],
  'Liverpool FC':['Liverpool','England'],'Chelsea FC':['Chelsea','England'],'Arsenal FC':['Arsenal','England'],
  'Manchester City FC':['Manchester City','England'],'Manchester United FC':['Manchester United','England'],
  'Brentford FC':['Brentford','England'],'LASK Linz':['Lask Linz','Austria'],
  'Tottenham Hotspur FC':['Tottenham','England'],'Brighton & Hove Albion FC':['Brighton','England'],
  'Newcastle United FC':['Newcastle','England'],'Aston Villa FC':['Aston Villa','England'],
  'Crystal Palace FC':['Crystal Palace','England'],'Everton FC':['Everton','England'],'Fulham FC':['Fulham','England'],
  'AFC Bournemouth':['Bournemouth','England'],'Nottingham Forest FC':['Nottingham Forest','England'],
  'West Ham United FC':['West Ham','England'],'Wolverhampton Wanderers FC':['Wolves','England'],
  'Leicester City FC':['Leicester','England'],'Southampton FC':['Southampton','England'],
  'Feyenoord Rotterdam':['Feyenoord','Netherlands'],'Como 1907':['Como','Italy'],
  'FK Shakhtar Donetsk':['Shakhtar Donetsk','Ukraine'],'ŠK Slovan Bratislava':['Slovan Bratislava','Slovakia'],
  'FC Bayern München':['Bayern München','Germany'],'Real Madrid CF':['Real Madrid','Spain'],
  'FC Barcelona':['Barcelona','Spain'],'Club Atlético de Madrid':['Atletico Madrid','Spain'],
  'FC Internazionale Milano':['Inter','Italy'],'Juventus FC':['Juventus','Italy'],
  'Paris Saint-Germain FC':['Paris Saint Germain','France'],'Sporting Clube de Portugal':['Sporting CP','Portugal'],
  'SL Benfica':['Benfica','Portugal'],'AFC Ajax':['Ajax','Netherlands'],
  'GNK Dinamo Zagreb':['Dinamo Zagreb','Croatia'],'FC København':['FC Copenhagen','Denmark'],
};
export function selectApiFootballTeam(team,rows,country){
  const [name,expectedCountry]=reviewed[team.name]||[team.name,country];
  const exact=rows.map(r=>r.team).filter(t=>t&&t.name?.toLowerCase()===name.toLowerCase()&&(!expectedCountry||t.country===expectedCountry));
  if(exact.length!==1||!Number.isSafeInteger(exact[0].id))throw new Error(`No unique verified API-Football identity for ${team.name}.`);
  return exact[0];
}
export async function reserveApiFootballRequest(){
  const budget=Math.min(80,Math.max(1,config.football.historyDailyRequests));
  await withTransaction(async tx=>{
    await tx.q("INSERT IGNORE INTO football_history_api_usage(source,usage_date) VALUES('api-football',UTC_DATE())");
    const row=await tx.one("SELECT requests FROM football_history_api_usage WHERE source='api-football' AND usage_date=UTC_DATE() FOR UPDATE");
    if(row.requests>=budget)throw new Error('API-Football daily research request budget reached.');
    await tx.q("UPDATE football_history_api_usage SET requests=requests+1 WHERE source='api-football' AND usage_date=UTC_DATE()");
  });
}
async function resolveTeam(team,country,provider){
  const known=await queryOne("SELECT provider_team_id AS id FROM football_history_team_links WHERE source='api-football' AND team_id=?",[team.id]);if(known)return known.id;
  const name=reviewed[team.name]?.[0]||team.name;
  const selected=selectApiFootballTeam(team,await provider.teams(name),country);
  await query("INSERT INTO football_history_team_links(source,provider_team_id,team_id,provider_name,country) VALUES('api-football',?,?,?,?)",[selected.id,team.id,selected.name,selected.country]);
  return selected.id;
}
const leagueCodes={39:'PL',78:'BL1',140:'PD',135:'SA',61:'FL1',2:'CL',3:'EL'};
export async function importApiFootballFixture(fixtureId,{force=false,provider=new ApiFootballProvider({apiKey:config.football.historyApiKey,reserveRequest:reserveApiFootballRequest})}={}){
  const fixture=await queryOne(`SELECT f.*,c.country FROM football_fixtures f JOIN football_competitions c ON c.id=f.competition_id WHERE f.id=? AND f.is_simulated=0`,[fixtureId]);
  if(!fixture)throw new Error('Choose an existing real football fixture.');
  const pair=[fixture.home_team_id,fixture.away_team_id].sort((a,b)=>a-b);const key=digest(JSON.stringify(pair)).slice(0,20);
  const previous=await queryOne("SELECT * FROM football_history_imports WHERE source='api-football' AND competition_code='AFH2H' AND season=?",[key]);
  if(!force&&previous?.last_checked_at&&Date.now()-new Date(previous.last_checked_at).getTime()<86400000)return {skipped:'checked within 24 hours'};
  const lock=await pool.getConnection();
  try{
    const [[r]]=await lock.query("SELECT GET_LOCK('h2h-api-football-history',0) AS acquired");if(!r.acquired)return {skipped:'history import already running'};
    const url='https://www.api-football.com/';
    await query("INSERT IGNORE INTO football_history_imports(source,competition_code,season,source_url,license) VALUES('api-football','AFH2H',?,?,'API-Football terms')",[key,url]);
    try{
      const teams=await query('SELECT * FROM football_teams WHERE id IN (?)',[pair]);
      const country=['England','Germany','Spain','Italy','France','Austria'].includes(fixture.country)?fixture.country:null;
      const a=await resolveTeam(teams.find(t=>t.id===pair[0]),country,provider);const b=await resolveTeam(teams.find(t=>t.id===pair[1]),country,provider);
      const raw=await provider.headToHead(a,b);if(raw.length>500)throw new Error('Head-to-head history is too large.');
      const meetings=raw.map(m=>normalizeApiFootballMeeting(m,a,b)).filter(Boolean).sort((a,b)=>b.date.localeCompare(a.date));
      const statistics=new Map();
      // Only enrich the latest two completed meetings; old values stay stored.
      for(const m of meetings.slice(0,2)){
        try{statistics.set(m.raw.fixture.id,normalizeApiFootballStatistics(await provider.statistics(m.raw.fixture.id),m.homeProviderId,m.awayProviderId));}
        catch{break;} // Scores remain useful when the plan omits statistics.
      }
      return await withTransaction(async tx=>{
        const imports=await tx.one("SELECT * FROM football_history_imports WHERE source='api-football' AND competition_code='AFH2H' AND season=? FOR UPDATE",[key]);
        for(const m of meetings){
          const league=m.raw.league;const code=leagueCodes[league.id]||`AF${league.id}`;
          let comp=await tx.one("SELECT id FROM football_competitions WHERE code=? AND provider<>'mock' ORDER BY id LIMIT 1",[code]);
          if(!comp){await tx.q("INSERT INTO football_competitions(provider,provider_competition_id,code,name,country) VALUES('api-football',?,?,?,?)",[String(league.id),code,league.name,league.country||null]);comp=await tx.one("SELECT id FROM football_competitions WHERE provider='api-football' AND code=?",[code]);}
          const sourceKey=digest(String(m.raw.fixture.id));const existing=await tx.one('SELECT * FROM football_history_matches WHERE import_id=? AND source_key=?',[imports.id,sourceKey]);
          const stats=statistics.get(m.raw.fixture.id)||existing?.statistics||null;
          const record={fixture:m.raw,statistics:stats};const hash=digest(JSON.stringify(record));if(existing?.record_hash===hash)continue;
          if(existing)await tx.q('INSERT INTO football_history_revisions(match_id,previous_record,previous_hash) VALUES(?,?,?)',[existing.id,JSON.stringify(existing.raw_record),existing.record_hash]);
          const local=id=>id===a?pair[0]:pair[1];
          const ht=m.halfTime.map(n=>Number.isSafeInteger(n)&&n>=0&&n<=99?n:null);
          await tx.q(`INSERT INTO football_history_matches(import_id,source_key,competition_id,season,home_team_id,away_team_id,match_date,status,home_score,away_score,home_half_score,away_half_score,statistics,raw_record,record_hash)
            VALUES(?,?,?,?,?,?,?,'FINISHED',?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE status='FINISHED',competition_id=VALUES(competition_id),match_date=VALUES(match_date),home_score=VALUES(home_score),away_score=VALUES(away_score),home_half_score=VALUES(home_half_score),away_half_score=VALUES(away_half_score),statistics=VALUES(statistics),raw_record=VALUES(raw_record),record_hash=VALUES(record_hash),updated_at=NOW()`,
            [imports.id,sourceKey,comp.id,String(league.season),local(m.homeProviderId),local(m.awayProviderId),m.date,m.homeScore,m.awayScore,...ht,stats?JSON.stringify(stats):null,JSON.stringify(record),hash]);
        }
        for(const r of raw.filter(r=>!meetings.some(m=>m.raw.fixture.id===r.fixture.id))){
          const sourceKey=digest(String(r.fixture.id));const existing=await tx.one("SELECT * FROM football_history_matches WHERE import_id=? AND source_key=? AND status='FINISHED'",[imports.id,sourceKey]);
          if(existing){
            await tx.q('INSERT INTO football_history_revisions(match_id,previous_record,previous_hash) VALUES(?,?,?)',[existing.id,JSON.stringify(existing.raw_record),existing.record_hash]);
            await tx.q("UPDATE football_history_matches SET status='UNVERIFIED',raw_record=?,record_hash=?,updated_at=NOW() WHERE id=?",[JSON.stringify({fixture:r}),digest(JSON.stringify(r)),existing.id]);
          }
        }
        // A restricted/empty plan response never erases previously stored evidence.
        const count=await tx.one("SELECT COUNT(*) AS n FROM football_history_matches WHERE import_id=? AND status='FINISHED'",[imports.id]);
        await tx.q("UPDATE football_history_imports SET source_url=?,content_hash=?,raw_payload=?,status='READY',match_count=?,last_checked_at=NOW(),last_imported_at=NOW(),last_error=NULL WHERE id=?",[url,digest(JSON.stringify(raw)),JSON.stringify({endpoint:`${API_FOOTBALL_BASE}/fixtures/headtohead`,teamIds:[a,b],matches:raw}),count.n,imports.id]);
        return {imported:meetings.length,stored:count.n};
      });
    }catch(err){await query("UPDATE football_history_imports SET status='ERROR',last_checked_at=NOW(),last_error=? WHERE source='api-football' AND competition_code='AFH2H' AND season=?",[err.message.slice(0,500),key]);throw err;}
  }finally{await lock.query("SELECT RELEASE_LOCK('h2h-api-football-history')").catch(()=>{});lock.release();}
}
