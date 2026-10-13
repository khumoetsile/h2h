// Public, read-only research over scores we actually have. Search uses the
// locally synced directory; external history is loaded only after team choice.
import { query, queryOne } from '../db.js';
import { config } from '../config.js';
import { badRequest, notFound } from '../utils/errors.js';
import { escapeLike } from '../utils/search.js';
import { getFootballProvider } from './providerRegistry.js';
import { logSystemError } from '../services/systemErrorService.js';

const HISTORY_LIMIT = 500;
const H2H_LIMIT = 50;
const FORM_LIMIT = 10;
const CACHE_MS = 15 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const cache = new Map();
export function clearResearchCache() { cache.clear(); }
const publicTeam = team => ({ id: team.id, name: team.name, shortName: team.short_name || team.name, crestUrl: team.crest_url });

const eligibleTeamsSql = `FROM football_teams t WHERE t.provider = ? AND EXISTS (
  SELECT 1 FROM football_fixtures fx JOIN football_competitions c ON c.id = fx.competition_id
  WHERE c.is_enabled = 1 AND c.provider = ? AND fx.provider = ?
    AND (fx.home_team_id = t.id OR fx.away_team_id = t.id)
    ${config.football.provider === 'mock' ? '' : 'AND fx.is_simulated = 0'}
)`;

export async function searchTeams({ q = '', competitionId, limit = 20 } = {}) {
  const provider = getFootballProvider();
  const filters = [];
  const params = [provider.name, provider.name, provider.name];
  if (q.trim()) {
    filters.push("(t.name LIKE ? ESCAPE '!' OR t.short_name LIKE ? ESCAPE '!')");
    params.push(`%${escapeLike(q.trim())}%`, `%${escapeLike(q.trim())}%`);
  }
  if (competitionId) {
    filters.push(`EXISTS (SELECT 1 FROM football_fixtures fxc WHERE fxc.competition_id = ? AND fxc.provider = t.provider
      AND (fxc.home_team_id = t.id OR fxc.away_team_id = t.id) ${config.football.provider === 'mock' ? '' : 'AND fxc.is_simulated = 0'})`);
    params.push(competitionId);
  }
  const suffix = filters.length ? ` AND ${filters.join(' AND ')}` : '';
  const [countRows, teams] = await Promise.all([
    query(`SELECT COUNT(*) AS total ${eligibleTeamsSql}${suffix}`, params),
    query(`SELECT t.* ${eligibleTeamsSql}${suffix} ORDER BY t.name, t.id LIMIT ?`, [...params, limit]),
  ]);
  const ids = teams.map(t => t.id);
  const competitions = ids.length ? await query(`SELECT DISTINCT c.id, c.code, c.name, t.id AS team_id
    FROM football_teams t JOIN football_fixtures fx ON fx.home_team_id = t.id OR fx.away_team_id = t.id
    JOIN football_competitions c ON c.id = fx.competition_id WHERE t.id IN (?) AND c.is_enabled = 1 AND c.provider = ? AND fx.provider = ?
    ${config.football.provider === 'mock' ? '' : 'AND fx.is_simulated = 0'} ORDER BY c.name, c.id`, [ids, provider.name, provider.name]) : [];
  const updated = await queryOne('SELECT MAX(last_synced_at) AS updated_at FROM football_fixtures WHERE provider = ?', [provider.name]);
  return {
    teams: teams.map(team => ({ ...publicTeam(team), competitions: competitions.filter(c => c.team_id === team.id).map(({ team_id, ...c }) => c) })),
    total: Number(countRows[0].total), provider: provider.name, lastUpdatedAt: updated?.updated_at || null,
  };
}

async function supportedTeam(id, provider) {
  const team = await queryOne(`SELECT t.* ${eligibleTeamsSql} AND t.id = ?`, [provider.name, provider.name, provider.name, id]);
  if (!team) throw notFound('This team is not in the currently supported football directory.');
  return team;
}

function bounded(promise, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Football history request timed out.')), milliseconds); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Coalescing is by team, so changing date/venue filters or reversing a pair
// does not spend another provider request. Failures get a short cooldown;
// previously fetched history remains explicitly marked stale.
async function teamHistory(provider, team) {
  if (typeof provider.getTeamMatches !== 'function') return { matches: [], fetchedAt: null, stale: false, status: 'UNSUPPORTED' };
  const key = `${provider.name}:${team.provider_team_id}`;
  let entry = cache.get(key);
  if (entry?.promise) return entry.promise;
  if (entry?.expiresAt > Date.now()) return entry.value;
  const previous = entry?.value;
  if (!entry && cache.size >= 100) {
    const disposable = [...cache].find(([, value]) => !value.promise);
    if (disposable) cache.delete(disposable[0]);
    else return { matches: [], fetchedAt: null, stale: false, status: 'UNAVAILABLE' };
  }
  entry = { expiresAt: 0, value: previous, promise: null };
  entry.promise = bounded(Promise.resolve().then(async () => {
    const snapshot = typeof provider.getTeamMatchesSnapshot === 'function'
      ? await provider.getTeamMatchesSnapshot(team.provider_team_id)
      : { matches: await provider.getTeamMatches(team.provider_team_id), fetchedAt: new Date().toISOString() };
    if (!Array.isArray(snapshot.matches)) throw new Error('Football history response did not contain a match list.');
    return { matches: snapshot.matches.slice(0, HISTORY_LIMIT), fetchedAt: snapshot.fetchedAt || null, stale: false, status: 'AVAILABLE' };
  }), 11000).then(value => {
    entry.value = value;
    entry.expiresAt = Date.now() + CACHE_MS;
    return value;
  }).catch(async err => {
    await logSystemError(`football-research:${provider.name}:${team.provider_team_id}`, err);
    const value = { matches: previous?.matches || [], fetchedAt: previous?.fetchedAt || null, stale: !!previous?.matches?.length, status: 'UNAVAILABLE' };
    entry.value = value;
    entry.expiresAt = Date.now() + RETRY_MS;
    return value;
  }).finally(() => { entry.promise = null; });
  cache.set(key, entry);
  if (cache.size > 100) {
    const disposable = [...cache].find(([cacheKey, value]) => cacheKey !== key && !value.promise);
    if (disposable) cache.delete(disposable[0]);
  }
  return entry.promise;
}

export function summarizeResearch(results) {
  const summary = { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, bothTeamsScored: 0, over15: 0, over25: 0, cleanSheets: 0 };
  for (const result of results) {
    const a = result.teamScore, b = result.opponentScore;
    if (!Number.isSafeInteger(a) || a < 0 || !Number.isSafeInteger(b) || b < 0) continue;
    summary.played++;
    summary.wins += a > b ? 1 : 0;
    summary.draws += a === b ? 1 : 0;
    summary.losses += a < b ? 1 : 0;
    summary.goalsFor += a;
    summary.goalsAgainst += b;
    summary.bothTeamsScored += a > 0 && b > 0 ? 1 : 0;
    summary.over15 += a + b > 1 ? 1 : 0;
    summary.over25 += a + b > 2 ? 1 : 0;
    summary.cleanSheets += b === 0 ? 1 : 0;
  }
  const average = amount => summary.played ? Number((amount / summary.played).toFixed(1)) : null;
  const percentage = amount => summary.played ? Math.round(amount / summary.played * 100) : null;
  return {
    ...summary, homeWins: summary.wins, awayWins: summary.losses,
    averageGoals: average(summary.goalsFor + summary.goalsAgainst), goalsForPerMatch: average(summary.goalsFor), goalsAgainstPerMatch: average(summary.goalsAgainst),
    bothTeamsScoredPct: percentage(summary.bothTeamsScored), over15Pct: percentage(summary.over15), over25Pct: percentage(summary.over25), cleanSheetsPct: percentage(summary.cleanSheets),
  };
}

function matchesFilter(match, filters, competitions) {
  const timestamp = new Date(match.kickoffAt).getTime();
  if (match.status !== 'FINISHED' || match.researchEligible === false || !Number.isFinite(timestamp) || timestamp > Date.now()) return false;
  if (!competitions.has(String(match.competitionProviderId))) return false;
  if (filters.competitionId && competitions.get(String(match.competitionProviderId)).id !== filters.competitionId) return false;
  const day = new Date(timestamp).toISOString().slice(0, 10);
  if (filters.dateFrom && day < filters.dateFrom) return false;
  if (filters.dateTo && day > filters.dateTo) return false;
  return true;
}
const scored = match => Number.isSafeInteger(match.homeScore) && match.homeScore >= 0 && Number.isSafeInteger(match.awayScore) && match.awayScore >= 0;
const participates = (match, id) => String(match.homeTeam?.providerId) === String(id) || String(match.awayTeam?.providerId) === String(id);

function mappedResearchMatch(match, teamA, teamB, competition) {
  const aHome = String(match.homeTeam.providerId) === String(teamA.provider_team_id);
  const teamAScore = aHome ? match.homeScore : match.awayScore;
  const teamBScore = aHome ? match.awayScore : match.homeScore;
  const mappedTeam = team => ({ id: String(team.providerId) === String(teamA.provider_team_id) ? teamA.id : String(team.providerId) === String(teamB.provider_team_id) ? teamB.id : null, name: team.name, shortName: team.shortName || team.name, crestUrl: team.crestUrl || null });
  return {
    id: match.providerId, fixtureId: match.fixtureId || null, kickoffAt: match.kickoffAt, competition,
    homeTeam: mappedTeam(match.homeTeam), awayTeam: mappedTeam(match.awayTeam), homeScore: match.homeScore, awayScore: match.awayScore,
    teamAScore, teamBScore, teamAVenue: aHome ? 'HOME' : 'AWAY', outcome: teamAScore > teamBScore ? 'W' : teamAScore === teamBScore ? 'D' : 'L',
    source: match.source, sourceUpdatedAt: match.sourceUpdatedAt || null, isSimulated: !!match.isSimulated, scoreBasis: match.scoreBasis || 'REPORTED_FINAL', scoreDuration: match.scoreDuration || null,
  };
}

function formFor(matches, team, filters, competitions) {
  const all = matches.filter(match => participates(match, team.provider_team_id) && matchesFilter(match, filters, competitions))
    .filter(match => filters.venue === 'all' || (String(match.homeTeam.providerId) === String(team.provider_team_id) ? 'home' : 'away') === filters.venue);
  const verified = all.filter(scored);
  const selected = verified.slice(0, FORM_LIMIT);
  const mapped = selected.map(match => {
    const atHome = String(match.homeTeam.providerId) === String(team.provider_team_id);
    const opponent = atHome ? match.awayTeam : match.homeTeam;
    const teamScore = atHome ? match.homeScore : match.awayScore, opponentScore = atHome ? match.awayScore : match.homeScore;
    return {
      id: match.providerId, fixtureId: match.fixtureId || null, kickoffAt: match.kickoffAt, competition: competitions.get(String(match.competitionProviderId)),
      opponent: { id: opponent.localId || null, name: opponent.name, shortName: opponent.shortName || opponent.name, crestUrl: opponent.crestUrl || null },
      venue: atHome ? 'HOME' : 'AWAY', teamScore, opponentScore, outcome: teamScore > opponentScore ? 'W' : teamScore === opponentScore ? 'D' : 'L',
      source: match.source, sourceUpdatedAt: match.sourceUpdatedAt || null, isSimulated: !!match.isSimulated, scoreBasis: match.scoreBasis || 'REPORTED_FINAL', scoreDuration: match.scoreDuration || null,
    };
  });
  return { matches: mapped, summary: summarizeResearch(mapped), availableMatches: verified.length, excludedUnverified: all.length - verified.length, sampleLimit: FORM_LIMIT };
}

export async function researchTeams(filters) {
  filters = { ...filters, venue: filters.venue || 'all' };
  if (filters.teamA === filters.teamB) throw badRequest('SAME_TEAM', 'Choose two different teams to compare.');
  const provider = getFootballProvider();
  const [teamA, teamB, competitionRows] = await Promise.all([
    supportedTeam(filters.teamA, provider), supportedTeam(filters.teamB, provider),
    query('SELECT id, code, name, provider_competition_id FROM football_competitions WHERE is_enabled = 1 AND provider = ? ORDER BY name, id', [provider.name]),
  ]);
  if (filters.competitionId && !competitionRows.some(c => c.id === filters.competitionId)) throw notFound('This competition is not supported by the current football source.');
  const competitions = new Map();
  for (const c of competitionRows) {
    const row = { id: c.id, code: c.code, name: c.name };
    competitions.set(String(c.code), row);
    competitions.set(String(c.provider_competition_id), row);
  }
  const [aHistory, bHistory, syncedRows] = await Promise.all([
    teamHistory(provider, teamA), teamHistory(provider, teamB),
    query(`SELECT fx.*, c.code AS competition_code, c.name AS competition_name,
      ht.provider_team_id AS home_provider_id, ht.name AS home_name, ht.short_name AS home_short, ht.crest_url AS home_crest,
      at.provider_team_id AS away_provider_id, at.name AS away_name, at.short_name AS away_short, at.crest_url AS away_crest
      FROM football_fixtures fx JOIN football_competitions c ON c.id = fx.competition_id
      JOIN football_teams ht ON ht.id = fx.home_team_id JOIN football_teams at ON at.id = fx.away_team_id
      WHERE fx.provider = ? AND c.provider = ? AND c.is_enabled = 1 AND fx.status = 'FINISHED'
        AND (fx.home_team_id IN (?, ?) OR fx.away_team_id IN (?, ?)) ${config.football.provider === 'mock' ? '' : 'AND fx.is_simulated = 0'}
      ORDER BY fx.kickoff_at DESC, fx.id DESC LIMIT 1000`, [provider.name, provider.name, teamA.id, teamB.id, teamA.id, teamB.id]),
  ]);
  const synced = syncedRows.map(row => ({
    providerId: row.provider_fixture_id, fixtureId: row.id, competitionProviderId: row.competition_code, kickoffAt: row.kickoff_at, status: row.status,
    homeTeam: { providerId: row.home_provider_id, localId: row.home_team_id, name: row.home_name, shortName: row.home_short, crestUrl: row.home_crest },
    awayTeam: { providerId: row.away_provider_id, localId: row.away_team_id, name: row.away_name, shortName: row.away_short, crestUrl: row.away_crest },
    homeScore: row.home_score, awayScore: row.away_score, source: 'SYNCED', isSimulated: !!row.is_simulated,
    researchEligible: !!row.research_eligible, scoreDuration: row.score_duration, scoreBasis: row.score_duration === 'REGULAR' ? 'REGULATION' : 'REPORTED_FINAL', sourceUpdatedAt: row.last_synced_at,
  }));
  const merged = new Map();
  for (const match of [...aHistory.matches.map(match => ({ ...match, sourceUpdatedAt: aHistory.fetchedAt })), ...bHistory.matches.map(match => ({ ...match, sourceUpdatedAt: bHistory.fetchedAt }))]) {
    if (!match.providerId || !match.homeTeam?.providerId || !match.awayTeam?.providerId) continue;
    const candidate = { ...match, source: 'PROVIDER', isSimulated: provider.name === 'mock' };
    const previous = merged.get(String(match.providerId));
    if (!previous || (!scored(previous) && scored(candidate))) merged.set(String(match.providerId), candidate);
  }
  for (const match of synced) {
    const previous = merged.get(String(match.providerId));
    // A verified provider score can be newer than the background sync. Keep it
    // and attach the local link; otherwise a verified local score is useful.
    const mergedMatch = previous && (scored(previous) || previous.researchEligible === false) ? { ...previous, fixtureId: match.fixtureId } : match;
    if (previous?.researchEligible === false || match.researchEligible === false) mergedMatch.researchEligible = false;
    merged.set(String(match.providerId), mergedMatch);
  }
  const matches = [...merged.values()].sort((a, b) => new Date(b.kickoffAt) - new Date(a.kickoffAt) || String(b.providerId).localeCompare(String(a.providerId)));
  const comparable = matches.filter(match => participates(match, teamA.provider_team_id) && participates(match, teamB.provider_team_id) && matchesFilter(match, filters, competitions))
    .filter(match => filters.venue === 'all' || (String(match.homeTeam.providerId) === String(teamA.provider_team_id) ? 'home' : 'away') === filters.venue);
  const verified = comparable.filter(scored);
  const meetings = verified.slice(0, H2H_LIMIT).map(match => mappedResearchMatch(match, teamA, teamB, competitions.get(String(match.competitionProviderId))));
  const summaryFor = selected => summarizeResearch(selected.map(match => ({ teamScore: match.teamAScore, opponentScore: match.teamBScore })));
  const form = { teamA: formFor(matches, teamA, filters, competitions), teamB: formFor(matches, teamB, filters, competitions) };
  const used = [...meetings, ...form.teamA.matches, ...form.teamB.matches];
  const sources = new Set(used.map(m => m.source));
  const source = sources.size > 1 ? 'COMBINED' : [...sources][0] || null;
  const providerStatus = [aHistory, bHistory].some(h => h.status === 'UNAVAILABLE') ? 'UNAVAILABLE' : [aHistory, bHistory].every(h => h.status === 'UNSUPPORTED') ? 'UNSUPPORTED' : 'AVAILABLE';
  const fetchedDates = used.map(match => match.sourceUpdatedAt).filter(Boolean).map(d => new Date(d)).filter(date => Number.isFinite(date.getTime()));
  const updatedAt = fetchedDates.length ? new Date(Math.min(...fetchedDates.map(d => d.getTime()))).toISOString() : null;
  const stale = aHistory.stale || bHistory.stale;
  const status = meetings.length ? (providerStatus === 'UNAVAILABLE' ? 'PARTIAL' : 'AVAILABLE') : providerStatus === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'EMPTY';
  return {
    teamA: publicTeam(teamA), teamB: publicTeam(teamB), filters: { venue: filters.venue || 'all', competitionId: filters.competitionId || null, dateFrom: filters.dateFrom || null, dateTo: filters.dateTo || null },
    headToHead: { status, matches: meetings, summary: summaryFor(meetings), byVenue: { home: summaryFor(meetings.filter(m => m.teamAVenue === 'HOME')), away: summaryFor(meetings.filter(m => m.teamAVenue === 'AWAY')) }, availableMatches: verified.length, excludedUnverified: comparable.length - verified.length, sampleLimit: H2H_LIMIT },
    form,
    metadata: {
      provider: provider.name, source, updatedAt, stale, providerStatus, sampleLimit: H2H_LIMIT, historyLimit: HISTORY_LIMIT,
      historyCoverage: provider.name === 'football-data' ? 'Provider history covers the past 749 days; older synced scores may also appear.' : null,
      excludedUnverified: comparable.length - verified.length, isSimulated: provider.name === 'mock',
      scoreBasis: used.every(match => match.scoreBasis === 'REGULATION') && used.length ? 'REGULATION' : 'REPORTED_FINAL',
      notice: `${provider.name === 'mock' ? 'Simulated development data. ' : ''}Computed only from available completed matches with verified scores in supported competitions; awarded or unplayed matches are excluded where identified. Uses regulation scores when supplied, otherwise the reported final score, which may include extra time. These are historical score trends. Up to ${HISTORY_LIMIT} provider results per team; head-to-head uses the latest ${H2H_LIMIT}, form the latest ${FORM_LIMIT}. Coverage depends on the connected provider and is not a complete all-time record.${providerStatus === 'UNAVAILABLE' ? ' The history source is currently unavailable; showing saved results where available.' : ''}${stale ? ' Previously fetched provider history is marked stale.' : ''}`,
    },
    competitions: competitionRows.map(({ provider_competition_id, ...c }) => c), serverNow: new Date(),
  };
}
