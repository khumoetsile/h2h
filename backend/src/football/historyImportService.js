import { pool, query, queryOne, withTransaction } from '../db.js';
import { OpenFootballProvider, HISTORY_LEAGUES, digest } from './providers/openFootballProvider.js';
import { logSystemError } from '../services/systemErrorService.js';

// Explicit aliases only. Identical full names are also resolved inside the
// same competition; approximate/fuzzy names never identify a club.
const ALIASES = {
  BL1: {'Bayern München':'FC Bayern München','Bayer Leverkusen':'Bayer 04 Leverkusen','Werder Bremen':'SV Werder Bremen','1899 Hoffenheim':'TSG 1899 Hoffenheim','Bor. Mönchengladbach':'Borussia Mönchengladbach','Borussia M’gladbach':'Borussia Mönchengladbach','VfL Bochum':'VfL Bochum 1848','FC St. Pauli':'FC St. Pauli 1910','1. FC Heidenheim':'1. FC Heidenheim 1846'},
  PD: {'Real Madrid':'Real Madrid CF','Atlético Madrid':'Club Atlético de Madrid','Atlético de Madrid':'Club Atlético de Madrid','Real Sociedad':'Real Sociedad de Fútbol','Rayo Vallecano':'Rayo Vallecano de Madrid','RC Celta':'RC Celta de Vigo','Celta Vigo':'RC Celta de Vigo','Real Betis':'Real Betis Balompié','Espanyol Barcelona':'RCD Espanyol de Barcelona','RCD Espanyol':'RCD Espanyol de Barcelona','Deportivo La Coruña':'RC Deportivo La Coruña','Sporting Gijón':'Real Sporting de Gijón'},
  SA: {'Inter':'FC Internazionale Milano','Internazionale':'FC Internazionale Milano','Juventus':'Juventus FC','Atalanta':'Atalanta BC','Lazio Roma':'SS Lazio','Bologna FC':'Bologna FC 1909','Hellas Verona':'Hellas Verona FC','Sampdoria':'UC Sampdoria','Chievo Verona':'AC Chievo Verona','Sassuolo Calcio':'US Sassuolo Calcio','AC Milan':'AC Milan','Palermo':'US Palermo'},
  FL1: {'Paris Saint-Germain':'Paris Saint-Germain FC','AS Monaco':'AS Monaco FC','Olympique Marseille':'Olympique de Marseille','Stade Rennais':'Stade Rennais FC 1901','Girondins Bordeaux':'FC Girondins de Bordeaux','RC Lens':'Racing Club de Lens','Stade Brestois':'Stade Brestois 29'},
  PL: { 'Liverpool': 'Liverpool FC', 'Chelsea': 'Chelsea FC', 'Arsenal': 'Arsenal FC', 'Manchester United': 'Manchester United FC', 'Manchester City': 'Manchester City FC', 'Tottenham Hotspur': 'Tottenham Hotspur FC', 'Everton': 'Everton FC', 'Newcastle United': 'Newcastle United FC', 'West Ham United': 'West Ham United FC', 'Southampton': 'Southampton FC', 'Leicester City': 'Leicester City FC', 'Crystal Palace': 'Crystal Palace FC', 'Aston Villa': 'Aston Villa FC', 'Fulham': 'Fulham FC', 'Burnley': 'Burnley FC', 'Sunderland': 'Sunderland AFC', 'West Bromwich Albion': 'West Bromwich Albion FC', 'Stoke City': 'Stoke City FC', 'Swansea City': 'Swansea City AFC', 'Watford': 'Watford FC', 'Bournemouth': 'AFC Bournemouth', 'Hull City': 'Hull City AFC', 'Middlesbrough': 'Middlesbrough FC', 'Brighton & Hove Albion': 'Brighton & Hove Albion FC', 'Wolverhampton Wanderers': 'Wolverhampton Wanderers FC', 'Norwich City': 'Norwich City FC', 'Sheffield United': 'Sheffield United FC', 'Leeds United': 'Leeds United FC', 'Nottingham Forest': 'Nottingham Forest FC', 'Brentford': 'Brentford FC', 'Ipswich Town': 'Ipswich Town FC' },
};
export const canonicalSourceName = (code, name) => ALIASES[code]?.[name] || name;

async function resolveTeam(tx, code, name, competitionId, identities, source) {
  const canonical = source==='openfootball'?canonicalSourceName(code, name):name;
  if (identities.has(canonical)) return identities.get(canonical);
  const known = await tx.one('SELECT team_id FROM football_team_aliases WHERE source = ? AND competition_code = ? AND source_name = ?', [source, code, canonical]);
  let teamId = known?.team_id;
  let resolution = 'SOURCE_ID';
  if (!teamId) {
    const exact = await tx.q(`SELECT DISTINCT t.id FROM football_teams t WHERE BINARY t.name = ? AND
      (EXISTS(SELECT 1 FROM football_fixtures f WHERE f.competition_id=? AND f.is_simulated=0 AND (f.home_team_id=t.id OR f.away_team_id=t.id)) OR EXISTS(SELECT 1 FROM football_history_matches h WHERE h.competition_id=? AND h.status='FINISHED' AND (h.home_team_id=t.id OR h.away_team_id=t.id)))`, [canonical,competitionId,competitionId]);
    if (exact.length === 1) { teamId = exact[0].id; resolution = 'EXACT_IN_LEAGUE'; }
    else if (exact.length > 1) throw new Error(`Ambiguous exact team identity for ${code}: ${canonical}`);
    else {
      const key = digest(`${code}:${canonical}`).slice(0, 40);
      await tx.q(`INSERT INTO football_teams (provider, provider_team_id, name, short_name) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE provider_team_id = VALUES(provider_team_id)`, [source, key, canonical, canonical.slice(0, 60)]);
      teamId = (await tx.one("SELECT id FROM football_teams WHERE provider = ? AND provider_team_id = ?", [source,key])).id;
    }
    await tx.q('INSERT INTO football_team_aliases (source, competition_code, source_name, team_id, resolution) VALUES (?, ?, ?, ?, ?)', [source, code, canonical, teamId, resolution]);
  }
  if (name !== canonical) await tx.q('INSERT INTO football_team_aliases (source, competition_code, source_name, team_id, resolution) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE team_id = VALUES(team_id)', [source, code, name, teamId, 'EXPLICIT_ALIAS']);
  identities.set(canonical, teamId);
  return teamId;
}

export async function storeHistoricalSeason(provider, code, season, snapshot) {
  return withTransaction(async tx => {
    const imports = await tx.one('SELECT * FROM football_history_imports WHERE source = ? AND competition_code = ? AND season = ? FOR UPDATE', [provider.name, code, season]);
    if (!imports) throw new Error('Import registration missing.');
    if (snapshot.unchanged || snapshot.hash === imports.content_hash) {
      await tx.q("UPDATE football_history_imports SET last_checked_at = NOW(), status = 'READY', last_error = NULL WHERE id = ?", [imports.id]);
      return { unchanged: true, imported: imports.match_count, corrected: 0 };
    }
    let competition = await tx.one("SELECT * FROM football_competitions WHERE code = ? AND provider <> 'mock' ORDER BY (provider = 'openfootball'), id LIMIT 1", [code]);
    if (!competition) {
      const c = (await provider.listCompetitions()).find(c=>c.code===code)||HISTORY_LEAGUES[code];
      if(!c)throw new Error('Historical competition identity is unavailable.');
      await tx.q("INSERT INTO football_competitions (provider, provider_competition_id, code, name, country) VALUES (?, ?, ?, ?, ?)", [provider.name,c.providerId||code, code, c.name, c.country||null]);
      competition = await tx.one("SELECT * FROM football_competitions WHERE provider = ? AND code = ?", [provider.name,code]);
    }
    const identities = new Map(); let corrected = 0; const keys = [];
    for (const match of snapshot.matches) {
      const homeId = await resolveTeam(tx, code, match.homeName, competition.id, identities,provider.name);
      const awayId = await resolveTeam(tx, code, match.awayName, competition.id, identities,provider.name);
      if (homeId === awayId) throw new Error('Historical aliases resolved both sides to the same team.');
      const key = digest(JSON.stringify([code, season, homeId, awayId])); keys.push(key);
      const existing = await tx.one('SELECT id, record_hash, raw_record FROM football_history_matches WHERE import_id = ? AND source_key = ?', [imports.id, key]);
      if (existing?.record_hash === match.hash) continue;
      if (existing) { await tx.q('INSERT INTO football_history_revisions (match_id, previous_record, previous_hash) VALUES (?, ?, ?)', [existing.id, JSON.stringify(existing.raw_record), existing.record_hash]); corrected++; }
      await tx.q(`INSERT INTO football_history_matches (import_id, source_key, competition_id, season, home_team_id, away_team_id, match_date, status, home_score, away_score, home_half_score, away_half_score, statistics, raw_record, record_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE match_date = VALUES(match_date), status = VALUES(status), home_score = VALUES(home_score), away_score = VALUES(away_score), home_half_score = VALUES(home_half_score), away_half_score = VALUES(away_half_score), statistics = VALUES(statistics), raw_record = VALUES(raw_record), record_hash = VALUES(record_hash), updated_at = NOW()`,
        [imports.id, key, competition.id, season, homeId, awayId, match.date, match.status, match.homeScore, match.awayScore, match.homeHalfScore, match.awayHalfScore, match.statistics ? JSON.stringify(match.statistics) : null, JSON.stringify(match.raw), match.hash]);
    }
    // Removed results no longer contribute; old raw versions remain auditable.
    await tx.q("UPDATE football_history_matches SET status = 'WITHDRAWN', updated_at = NOW() WHERE import_id = ? AND source_key NOT IN (?) AND status <> 'WITHDRAWN'", [imports.id, keys]);
    const completed = snapshot.matches.filter(m => m.status === 'FINISHED').length;
    await tx.q("UPDATE football_history_imports SET etag = ?, content_hash = ?, raw_payload = ?, status = 'READY', match_count = ?, last_checked_at = NOW(), last_imported_at = NOW(), last_error = NULL WHERE id = ?", [snapshot.etag || null, snapshot.hash, snapshot.raw, completed, imports.id]);
    return { unchanged: false, imported: completed, corrected };
  });
}

export async function importHistoricalSeason(code, season, { force = false, provider = new OpenFootballProvider() } = {}) {
  const url = provider.historicalUrl(code, season);
  if(!provider.historicalLicense)throw new Error('Historical source permission/license must be configured before import.');
  const lock = await pool.getConnection();
  const lockName = `h2h-history:${provider.name}:${code}:${season}`;
  try {
    const [[locked]] = await lock.query('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
    if (!locked.acquired) return { skipped: 'already running' };
    await query(`INSERT INTO football_history_imports (source, competition_code, season, source_url, license) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE source_url = VALUES(source_url)`, [provider.name, code, season, url,provider.historicalLicense]);
    const previous = await queryOne('SELECT * FROM football_history_imports WHERE source = ? AND competition_code = ? AND season = ?', [provider.name, code, season]);
    // Completed archives are immutable between manual corrections; current
    // seasons update at most daily. Force performs a conditional recheck.
    const archived = Number(season.slice(0, 4)) < (new Date().getUTCMonth() >= 6 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1);
    if (!force && previous.content_hash && previous.status==='READY' && (archived || Date.now() - new Date(previous.last_checked_at).getTime() < 86400000)) return { skipped: archived ? 'stored archive' : 'checked today', imported: previous.match_count };
    if (!force && previous.status==='ERROR' && Date.now()-new Date(previous.last_checked_at).getTime()<3600000)return {skipped:'failure cooldown'};
    let snapshot = await provider.loadHistoricalSeason(code, season, { etag: previous.etag });
    if(snapshot.unchanged && previous.raw_payload && provider.hashPayload && provider.hashPayload(previous.raw_payload)!==previous.content_hash){snapshot={raw:previous.raw_payload,hash:provider.hashPayload(previous.raw_payload),etag:previous.etag,url,matches:provider.normalizeHistoricalSeason(JSON.parse(previous.raw_payload),code,season)};}
    return await storeHistoricalSeason(provider, code, season, snapshot);
  } catch (err) {
    await query("UPDATE football_history_imports SET status = 'ERROR', last_checked_at = NOW(), last_error = ? WHERE source = ? AND competition_code = ? AND season = ?", [String(err.message).slice(0, 500), provider.name, code, season]);
    await logSystemError(`football-history:${code}:${season}`, err); throw err;
  } finally { await lock.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {}); lock.release(); }
}
