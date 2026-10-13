import { pool } from '../src/db.js';
import { OpenFootballProvider, HISTORY_LEAGUES, HISTORY_SEASONS } from '../src/football/providers/openFootballProvider.js';
import { importHistoricalSeason } from '../src/football/historyImportService.js';

const options = Object.fromEntries(process.argv.slice(2).map(arg => {const [key,value]=arg.replace(/^--/,'').split('=');return[key,value??true];}));
const leagues = (options.leagues || 'PL').split(',');
const seasons = options.seasons === 'all' ? HISTORY_SEASONS : (options.seasons || HISTORY_SEASONS.at(-1)).split(',');
const jobs = leagues.flatMap(code => seasons.map(season => ({ code, season })));
if (options.list !== undefined) { console.log(JSON.stringify({ leagues: HISTORY_LEAGUES, seasons: HISTORY_SEASONS, source: 'OpenFootball', license: 'CC0-1.0' }, null, 2)); await pool.end(); process.exit(0); }
if (jobs.length > 60 || leagues.some(code => !HISTORY_LEAGUES[code]) || seasons.some(season => !HISTORY_SEASONS.includes(season))) throw new Error('Use supported leagues/seasons; at most 60 files per run.');
let failures = 0;
try {
  const provider = new OpenFootballProvider();
  for (const { code, season } of jobs) {
    try { console.log(JSON.stringify({ code, season, ...await importHistoricalSeason(code, season, { provider, force: options.force !== undefined }) })); }
    catch (err) { failures++; console.error(`${code} ${season}: ${err.message}`); if (failures >= 3) { console.error('Stopped after three failures.'); break; } }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
} finally { await pool.end(); }
process.exitCode = failures ? 1 : 0;
