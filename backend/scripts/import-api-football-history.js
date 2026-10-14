import {pool,query} from '../src/db.js';
import {config} from '../src/config.js';
import {importApiFootballFixture,reserveApiFootballRequest} from '../src/football/apiFootballHistoryService.js';
import {digest} from '../src/football/providers/openFootballProvider.js';
import {ApiFootballProvider} from '../src/football/providers/apiFootballProvider.js';
const options=Object.fromEntries(process.argv.slice(2).map(a=>{const [k,v]=a.replace(/^--/,'').split('=');return[k,v??true];}));
let failed=false;
try{
  if(!config.football.historyApiKey){console.log('API-Football history is not configured; archive imports remain active.');}
  else{
    const limit=Number(options.limit||8);if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw new Error('Use --limit=1..20.');
    const fixture=options.fixture===undefined?null:Number(options.fixture);if(fixture!==null&&(!Number.isSafeInteger(fixture)||fixture<1))throw new Error('Invalid fixture ID.');
    const rows=fixture?[{id:fixture}]:await query("SELECT MIN(id) AS id,LEAST(home_team_id,away_team_id) AS team_a,GREATEST(home_team_id,away_team_id) AS team_b FROM football_fixtures WHERE is_simulated=0 AND kickoff_at>=UTC_DATE() AND kickoff_at<DATE_ADD(UTC_DATE(),INTERVAL 21 DAY) GROUP BY LEAST(home_team_id,away_team_id),GREATEST(home_team_id,away_team_id) ORDER BY MIN(kickoff_at) LIMIT 100");
    if(!fixture){
      const checked=await query("SELECT season,last_checked_at FROM football_history_imports WHERE source='api-football' AND competition_code='AFH2H'");
      const dates=new Map(checked.map(r=>[r.season,new Date(r.last_checked_at||0).getTime()]));
      const date=r=>dates.get(digest(JSON.stringify([r.team_a,r.team_b])).slice(0,20))||0;
      rows.sort((a,b)=>date(a)-date(b)); // Rotate through uncached/oldest pairs, not always the first eight.
    }
    const provider=new ApiFootballProvider({apiKey:config.football.historyApiKey,reserveRequest:reserveApiFootballRequest});
    let handled=0,failures=0;
    for(const row of rows){
      try{const result=await importApiFootballFixture(row.id,{force:options.force!==undefined,provider});console.log(JSON.stringify({fixture:row.id,...result}));if(!result.skipped)handled++;}
      catch(err){
        console.error(`Fixture ${row.id}: ${err.message}`);handled++;
        if(err.message.includes('budget reached')||err.code==='API_QUOTA')break;
        if(!err.message.includes('unique verified')&&!['API_SEARCH_REJECTED','API_COVERAGE'].includes(err.code)){failed=true;failures++;if(failures>=3)break;}
      }
      if(handled>=limit)break;
    }
  }
}finally{await pool.end();}
process.exitCode=failed?1:0;
