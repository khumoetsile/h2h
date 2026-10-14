// Public analysis reads local archives and verified synced results only.
// No provider calls or scraping are permitted in these request paths.
import { query, queryOne } from '../db.js';
import { config } from '../config.js';
import { badRequest, notFound } from '../utils/errors.js';
import { escapeLike } from '../utils/search.js';
import { summarizeResearch, quickInsights } from './historyAnalytics.js';
export { summarizeResearch } from './historyAnalytics.js';
export function clearResearchCache() {} // Compatibility for existing test/tools.
const teamView = t => ({ id: t.id, name: t.name, shortName: t.short_name || t.name, crestUrl: t.crest_url });
const real = config.football.provider === 'mock' ? '' : 'AND fx.is_simulated = 0';
const eligible = `EXISTS (SELECT 1 FROM football_history_matches h JOIN football_competitions c ON c.id=h.competition_id WHERE c.is_enabled=1 AND h.status='FINISHED' AND (h.home_team_id=t.id OR h.away_team_id=t.id))
  OR EXISTS (SELECT 1 FROM football_fixtures fx JOIN football_competitions c ON c.id=fx.competition_id WHERE c.is_enabled=1 AND fx.provider=? ${real} AND (fx.home_team_id=t.id OR fx.away_team_id=t.id))`;

export async function searchTeams({ q = '', competitionId, limit = 20 } = {}) {
  const params = [config.football.provider]; let filter = '';
  if (q.trim()) { filter += " AND (t.name LIKE ? ESCAPE '!' OR t.short_name LIKE ? ESCAPE '!' OR EXISTS(SELECT 1 FROM football_team_aliases a WHERE a.team_id=t.id AND a.source_name LIKE ? ESCAPE '!'))"; params.push(...Array(3).fill(`%${escapeLike(q.trim())}%`)); }
  if (competitionId) { filter += ` AND (EXISTS(SELECT 1 FROM football_history_matches h WHERE h.competition_id=? AND (h.home_team_id=t.id OR h.away_team_id=t.id)) OR EXISTS(SELECT 1 FROM football_fixtures fx WHERE fx.competition_id=? ${real} AND (fx.home_team_id=t.id OR fx.away_team_id=t.id)))`; params.push(competitionId, competitionId); }
  const sql = `FROM football_teams t WHERE (${eligible})${filter}`;
  const [counts, rows] = await Promise.all([query(`SELECT COUNT(*) AS total ${sql}`, params), query(`SELECT t.* ${sql} ORDER BY t.name,t.id LIMIT ?`, [...params, limit])]);
  const ids=rows.map(t=>t.id);
  const comps=ids.length?await query(`SELECT DISTINCT h.home_team_id AS team_id,c.id,c.code,c.name FROM football_history_matches h JOIN football_competitions c ON c.id=h.competition_id WHERE h.home_team_id IN (?) AND c.is_enabled=1
    UNION SELECT DISTINCT h.away_team_id,c.id,c.code,c.name FROM football_history_matches h JOIN football_competitions c ON c.id=h.competition_id WHERE h.away_team_id IN (?) AND c.is_enabled=1
    UNION SELECT DISTINCT fx.home_team_id,c.id,c.code,c.name FROM football_fixtures fx JOIN football_competitions c ON c.id=fx.competition_id WHERE fx.home_team_id IN (?) AND c.is_enabled=1 ${real}
    UNION SELECT DISTINCT fx.away_team_id,c.id,c.code,c.name FROM football_fixtures fx JOIN football_competitions c ON c.id=fx.competition_id WHERE fx.away_team_id IN (?) AND c.is_enabled=1 ${real}`, [ids,ids,ids,ids]):[];
  return { teams: rows.map(t=>({...teamView(t),competitions:comps.filter(c=>c.team_id===t.id).map(({team_id,...c})=>c)})), total: Number(counts[0].total), provider: 'local-history', lastUpdatedAt: (await queryOne('SELECT MAX(last_imported_at) AS updated FROM football_history_imports'))?.updated || null };
}
export async function researchTeam(id) {
  let t = await queryOne(`SELECT t.* FROM football_teams t WHERE t.id=? AND (${eligible})`, [id, config.football.provider]);
  if(!t){
    const redirected=await query(`SELECT DISTINCT current.* FROM football_teams old JOIN football_team_aliases a ON a.source=old.provider AND BINARY CONVERT(a.source_name USING utf8mb4)=BINARY CONVERT(old.name USING utf8mb4) JOIN football_teams current ON current.id=a.team_id
      WHERE old.id=? AND current.id<>old.id AND EXISTS(SELECT 1 FROM football_history_matches h JOIN football_competitions c ON c.id=h.competition_id WHERE c.code=a.competition_code AND (h.home_team_id=old.id OR h.away_team_id=old.id))`,[id]);
    if(redirected.length===1)t=redirected[0];
  }
  if (!t) throw notFound('This team has no supported football history or fixtures.');
  return { team: teamView(t) };
}
const date = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const validScore = m => m.status === 'FINISHED' && m.eligible !== false && m.date <= new Date().toISOString().slice(0, 10) && [m.homeScore, m.awayScore].every(n => Number.isSafeInteger(n) && n >= 0);
const optionalStat = value => value != null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const statsFrom = r => ({ shots: [optionalStat(r.home_shots), optionalStat(r.away_shots)], shotsOnTarget: [optionalStat(r.home_shots_on_target), optionalStat(r.away_shots_on_target)], possession: [optionalStat(r.home_possession), optionalStat(r.away_possession)], corners: [optionalStat(r.home_corners), optionalStat(r.away_corners)], fouls: [null, null], yellowCards: [null, null], redCards: [null, null] });
const hasStats = s => s && Object.values(s).some(pair => Array.isArray(pair) && pair.some(n => n != null));
async function storedMatches(teamA, teamB) {
  const ids = [teamA, teamB];
  const joins = `JOIN football_competitions c ON c.id=m.competition_id JOIN football_teams ht ON ht.id=m.home_team_id JOIN football_teams at ON at.id=m.away_team_id`;
  const selected = `m.*,c.code AS competition_code,c.name AS competition_name,ht.name AS home_name,ht.short_name AS home_short,ht.crest_url AS home_crest,at.name AS away_name,at.short_name AS away_short,at.crest_url AS away_crest`;
  const [archive, synced] = await Promise.all([
    query(`SELECT ${selected},i.source,i.source_url,i.license,i.last_imported_at,i.status AS import_status FROM football_history_matches m ${joins} JOIN football_history_imports i ON i.id=m.import_id WHERE c.is_enabled=1 AND m.status IN ('FINISHED','UNVERIFIED') AND m.match_date<=UTC_DATE() AND (m.home_team_id IN (?) OR m.away_team_id IN (?)) ORDER BY m.match_date DESC LIMIT 12000`, [ids, ids]),
    query(`SELECT ${selected} FROM football_fixtures m ${joins} WHERE c.is_enabled=1 AND m.provider=? ${config.football.provider === 'mock' ? '' : 'AND m.is_simulated=0'} AND m.status='FINISHED' AND (m.home_team_id IN (?) OR m.away_team_id IN (?)) ORDER BY m.kickoff_at DESC LIMIT 12000`, [config.football.provider, ids, ids]),
  ]);
  const team = (r, home) => ({ id: home ? r.home_team_id : r.away_team_id, name: home ? r.home_name : r.away_name, shortName: (home ? r.home_short : r.away_short) || (home ? r.home_name : r.away_name), crestUrl: home ? r.home_crest : r.away_crest });
  const map = (r, archived) => ({ id: `${archived ? 'H' : 'F'}-${r.id}`, historicalId: archived ? r.id : null, fixtureId: archived ? null : r.id, date: date(archived ? r.match_date : r.kickoff_at), kickoffAt: archived ? `${date(r.match_date)}T00:00:00Z` : r.kickoff_at, datePrecision: archived ? 'DATE' : 'TIME', season: /^\d{4}$/.test(r.season||'')?r.season+'-'+String(Number(r.season)+1).slice(-2):r.season, competition: { id: r.competition_id, code: r.competition_code, name: r.competition_name }, homeTeam: team(r, true), awayTeam: team(r, false), homeScore: r.home_score, awayScore: r.away_score, halfTime: [r.home_half_score ?? null, r.away_half_score ?? null], statistics: archived ? r.statistics : statsFrom(r), status: r.status, eligible: archived || !!r.research_eligible, source: archived ? 'ARCHIVE' : 'SYNCED', sourceName: archived ? (r.source==='openfootball'?'OpenFootball':r.source==='api-football'?'API-Football':r.source) : config.football.provider, sourceUrl: archived ? r.source_url : null, license: archived ? r.license : null, sourceUpdatedAt: archived ? r.last_imported_at : r.last_synced_at, stale: archived && r.import_status === 'ERROR', isSimulated: !archived && !!r.is_simulated, scoreBasis: archived || r.score_duration === 'REGULAR' ? 'REGULATION' : 'REPORTED_FINAL' });
  const merged = new Map(); let conflicts = 0;
  for (const m of [...archive.map(r => map(r, true)), ...synced.map(r => map(r, false))]) {
    const key = `${m.competition.code}:${m.date}:${m.homeTeam.id}:${m.awayTeam.id}`; const p = merged.get(key);
    if (!p) { merged.set(key, m); continue; }
    if (validScore(p) && validScore(m) && (p.homeScore !== m.homeScore || p.awayScore !== m.awayScore)) { p.eligible = false; conflicts++; continue; }
    if (m.eligible === false) p.eligible = false;
    if (!validScore(p) && validScore(m) && p.eligible !== false) merged.set(key, m);
    else { p.fixtureId ||= m.fixtureId; if (!hasStats(p.statistics) && hasStats(m.statistics)) {p.statistics = m.statistics;p.statisticsSource=m.sourceName;} }
  }
  return { matches: [...merged.values()].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)), conflicts, truncated: archive.length >= 12000 || synced.length >= 12000 };
}
const orient = (m, id) => {
  const home = m.homeTeam.id === id, a = home ? m.homeScore : m.awayScore, b = home ? m.awayScore : m.homeScore;
  return { ...m, opponent: home ? m.awayTeam : m.homeTeam, venue: home ? 'HOME' : 'AWAY', teamAVenue: home ? 'HOME' : 'AWAY', teamScore: a, opponentScore: b, teamAScore: a, teamBScore: b, outcome: a > b ? 'W' : a === b ? 'D' : 'L' };
};
export async function researchTeams(filters) {
  filters = { venue: 'all', form: 10, meetings: 'all', page: 1, ...filters };
  if (filters.teamA === filters.teamB) throw badRequest('SAME_TEAM', 'Choose two different teams.');
  if (filters.competitionId && !(await queryOne('SELECT id FROM football_competitions WHERE id=? AND is_enabled=1', [filters.competitionId]))) throw notFound('This competition is not available.');
  const [{ team: teamA }, { team: teamB }] = await Promise.all([researchTeam(filters.teamA), researchTeam(filters.teamB)]);
  if(teamA.id===teamB.id)throw badRequest('SAME_TEAM','Choose two different teams.');
  filters={...filters,teamA:teamA.id,teamB:teamB.id};
  const stored=await storedMatches(teamA.id,teamB.id);
  const competitions = [...new Map(stored.matches.map(m => [m.competition.id, m.competition])).values()];
  const scoped = stored.matches.filter(m => (!filters.competitionId || m.competition.id === filters.competitionId) && (!filters.dateFrom || m.date >= filters.dateFrom) && (!filters.dateTo || m.date <= filters.dateTo) && (!filters.season || m.season === filters.season));
  const valid = scoped.filter(validScore);
  const allPair = valid.filter(m => [m.homeTeam.id, m.awayTeam.id].includes(teamA.id) && [m.homeTeam.id, m.awayTeam.id].includes(teamB.id)).map(m => orient(m, teamA.id));
  const pair = allPair.filter(m => filters.venue === 'all' || m.venue.toLowerCase() === filters.venue);
  const chosen = filters.meetings === 'all' ? pair : pair.slice(0, Number(filters.meetings));
  const pageSize = 20;
  const formFor = t => {
    const all = valid.filter(m => m.homeTeam.id === t.id || m.awayTeam.id === t.id).map(m => orient(m, t.id));
    const chosen = all.filter(m => filters.venue === 'all' || m.venue.toLowerCase() === filters.venue).slice(0, filters.form);
    const home = all.filter(m => m.venue === 'HOME').slice(0, filters.form), away = all.filter(m => m.venue === 'AWAY').slice(0, filters.form);
    return { matches: chosen, summary: summarizeResearch(chosen), home: summarizeResearch(home), away: summarizeResearch(away), sampleLimit: filters.form };
  };
  const form = { teamA: formFor(teamA), teamB: formFor(teamB) }, used = [...chosen, ...form.teamA.matches, ...form.teamB.matches];
  const sources = [...new Set(used.map(m => m.source))];
  const dates = used.map(m => m.sourceUpdatedAt).filter(Boolean).map(d => new Date(d).getTime()).filter(Number.isFinite);
  const imports = await query('SELECT competition_code,season,last_imported_at,status,match_count,source_url,license FROM football_history_imports WHERE content_hash IS NOT NULL ORDER BY season DESC,competition_code');
  const excluded = scoped.filter(m => !validScore(m) && [m.homeTeam.id, m.awayTeam.id].includes(teamA.id) && [m.homeTeam.id, m.awayTeam.id].includes(teamB.id)).length;
  const trend = list => list.slice().reverse().map(m => ({ date: m.date, goalsFor: m.teamScore, goalsAgainst: m.opponentScore, total: m.teamScore + m.opponentScore }));
  const nextFixture=await queryOne("SELECT f.id,f.kickoff_at AS kickoffAt FROM football_fixtures f JOIN football_competitions c ON c.id=f.competition_id WHERE c.is_enabled=1 AND f.is_simulated=0 AND f.provider<>'mock' AND f.status='SCHEDULED' AND f.kickoff_at>UTC_TIMESTAMP() AND f.home_team_id IN (?) AND f.away_team_id IN (?) ORDER BY f.kickoff_at LIMIT 1",[[teamA.id,teamB.id],[teamA.id,teamB.id]]);
  return { teamA, teamB, filters,nextFixture,
    headToHead: { status: chosen.length ? 'AVAILABLE' : 'EMPTY', matches: chosen.slice((filters.page - 1) * pageSize, filters.page * pageSize), summary: summarizeResearch(chosen), byVenue: { home: summarizeResearch(chosen.filter(m => m.venue === 'HOME')), away: summarizeResearch(chosen.filter(m => m.venue === 'AWAY')) }, availableMatches: pair.length, excludedUnverified: excluded, sampleLimit: filters.meetings === 'all' ? pair.length : Number(filters.meetings), total: chosen.length, page: filters.page, pageSize, hasMore: filters.page * pageSize < chosen.length }, form,
    insights: quickInsights(chosen, form.teamA, form.teamB, teamA, teamB), trends: { meetings: trend(chosen.slice(0, 20)), teamA: trend(form.teamA.matches), teamB: trend(form.teamB.matches) },
    metadata: { lastMatchDate: used.length?[...used].sort((a,b)=>b.date.localeCompare(a.date))[0].date:null, provider: 'local-history', source: sources.length > 1 ? 'COMBINED' : sources[0] || null, updatedAt: dates.length ? new Date(Math.min(...dates)).toISOString() : null, stale: used.some(m => m.stale), providerStatus: 'STORED', sampleLimit: chosen.length, historyLimit: null, excludedUnverified: excluded, conflicts: stored.conflicts, isSimulated: used.length > 0 && used.every(m => m.isSimulated), scoreBasis: used.some(m => m.scoreBasis === 'REPORTED_FINAL') ? 'REPORTED_FINAL' : 'REGULATION', historyCoverage: imports.length ? `${imports.length} stored history imports. Coverage varies by competition and source.` : 'Only locally synced scores are available; historical archives have not been imported yet.', notice: 'Calculated from verified completed scores stored in Head2Head. Missing fields stay unavailable. Archive dates are match dates, not inferred kickoff times. Historical frequencies are not predictions or betting advice. Coverage is not a complete all-time record.', imports, truncated: stored.truncated, sources: [...new Map(used.map(m => [m.sourceName, { name: m.sourceName, url: m.sourceUrl, license: m.license }])).values()] }, competitions, seasons: [...new Set(stored.matches.map(m => m.season).filter(Boolean))].sort().reverse(), serverNow: new Date() };
}
