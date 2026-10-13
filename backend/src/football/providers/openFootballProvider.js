import { createHash } from 'node:crypto';
import { FootballDataProvider } from './provider.js';
import { validIsoDate } from '../../utils/search.js';

export const HISTORY_LEAGUES = {
  PL: { file: 'en.1', name: 'Premier League', country: 'England' },
  BL1: { file: 'de.1', name: 'Bundesliga', country: 'Germany' },
  PD: { file: 'es.1', name: 'Primera Division', country: 'Spain' },
  SA: { file: 'it.1', name: 'Serie A', country: 'Italy' },
  FL1: { file: 'fr.1', name: 'Ligue 1', country: 'France' },
};
export const HISTORY_SEASONS = Array.from({ length: 12 }, (_, i) => `${2015 + i}-${String(2016 + i).slice(-2)}`);
export const digest = value => createHash('sha256').update(value).digest('hex');
const score = value => Array.isArray(value) && value.length === 2 && value.every(n => Number.isSafeInteger(n) && n >= 0 && n <= 99) ? value : [null, null];

/** Downloadable CC0 data. Only the offline importer invokes network methods. */
export class OpenFootballProvider extends FootballDataProvider {
  get name() { return 'openfootball'; }
  get historicalLicense() { return 'CC0-1.0'; }
  hashPayload(raw) { return digest(`normalizer-v4:${raw}`); }
  capabilities() { return { statistics: false, events: false, historical: true }; }
  async listCompetitions() { return Object.entries(HISTORY_LEAGUES).map(([code, c]) => ({ code, providerId: code, name: c.name, country: c.country, emblemUrl: null })); }
  historicalSeasons() { return [...HISTORY_SEASONS]; }
  historicalUrl(code, season) {
    if (!HISTORY_LEAGUES[code] || !HISTORY_SEASONS.includes(season)) throw new Error('Unsupported historical competition or season.');
    return `https://raw.githubusercontent.com/openfootball/football.json/master/${season}/${HISTORY_LEAGUES[code].file}.json`;
  }
  async loadHistoricalSeason(code, season, { etag, fetcher = fetch } = {}) {
    const url = this.historicalUrl(code, season);
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetcher(url, { headers: { 'User-Agent': 'Head2Head-History/1.0 (+https://h2h.khumo.co.bw)', ...(etag ? { 'If-None-Match': etag } : {}) }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (response.status === 304) return { unchanged: true, url };
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retry = Number(response.headers.get('retry-after'));
        if (Number.isFinite(retry) && retry > 30) throw new Error(`Source requested a ${retry}s cooldown; retry this import later.`);
        await new Promise(resolve => setTimeout(resolve, Math.max(1000 * (attempt + 1), (retry || 0) * 1000))); continue;
      }
      if (!response.ok) throw new Error(`Historical source returned HTTP ${response.status}.`);
      if (Number(response.headers.get('content-length')) > 2_000_000) throw new Error('Historical file exceeds the import size limit.');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 2_000_000) { await response.body.cancel?.().catch(() => {}); throw new Error('Historical file exceeds the import size limit.'); } chunks.push(chunk); }
      const raw = Buffer.concat(chunks).toString('utf8');
      return { url, raw, hash: this.hashPayload(raw), etag: response.headers.get('etag'), matches: this.normalizeHistoricalSeason(JSON.parse(raw), code, season) };
    }
  }
  normalizeHistoricalSeason(data, code, season) {
    this.historicalUrl(code, season);
    if (!Array.isArray(data.matches) || data.matches.length < 1 || data.matches.length > 1000) throw new Error('Invalid historical match list.');
    const seen = new Set();
    return data.matches.map(raw => {
      if (!validIsoDate(raw.date) || ![raw.team1, raw.team2].every(n => typeof n === 'string' && n.trim() && n.length <= 100) || raw.team1 === raw.team2) throw new Error('Invalid historical date or team identity.');
      // These supported leagues play one home/away pairing per season. Date is
      // deliberately excluded so a corrected date updates the same stable row.
      const sourceKey = digest(JSON.stringify([code, season, raw.team1, raw.team2]));
      if (seen.has(sourceKey)) throw new Error('Ambiguous duplicate pairing in historical season.');
      seen.add(sourceKey);
      const [homeScore, awayScore] = score(raw.score?.ft);
      const [homeHalfScore, awayHalfScore] = score(raw.score?.ht);
      const explicitlyUnplayed = raw.status && !['FINISHED', 'FT', 'COMPLETED'].includes(String(raw.status).toUpperCase());
      const seasonStart=Number(season.slice(0,4));const round=Number(String(raw.round||'').match(/Matchday\s+(\d+)/i)?.[1]);
      const inconsistentSeason=raw.date<`${seasonStart}-07-01`||raw.date>`${seasonStart+1}-09-30`||(round>=30&&raw.date<`${seasonStart+1}-01-01`);
      const complete = !explicitlyUnplayed && !inconsistentSeason && homeScore !== null && raw.date < new Date().toISOString().slice(0, 10);
      return { sourceKey, competitionCode: code, season, date: raw.date, homeName: raw.team1, awayName: raw.team2, status: complete ? 'FINISHED' : 'UNVERIFIED', homeScore: complete ? homeScore : null, awayScore: complete ? awayScore : null, homeHalfScore, awayHalfScore, statistics: null, raw, hash: digest(JSON.stringify([raw,complete])) };
    });
  }
}
