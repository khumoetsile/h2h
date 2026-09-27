// Background worker (started alongside the existing match sweeper) that:
//  1. pulls competitions/fixtures from the configured FootballDataProvider
//     and stores them locally — the frontend and settlement engine never
//     call the provider directly;
//  2. refreshes fixtures that are imminent, live or just finished;
//  3. moves matched football challenges into IN_PROGRESS at kickoff;
//  4. voids/cancels challenges whose fixture was postponed/cancelled/abandoned;
//  5. settles challenges whose fixture is FINISHED (see footballSettlementService).
// Every provider call is wrapped so a provider outage becomes a logged
// system error, never a silent incorrect settlement.
import { query, queryOne, withTransaction } from '../db.js';
import { config } from '../config.js';
import { getSettings } from '../services/settingsService.js';
import { notify } from '../services/notificationService.js';
import { emitAll } from '../realtime.js';
import { getFootballProvider } from './providerRegistry.js';
import { settleMatchesForFixture, voidMatchesForFixture } from './footballSettlementService.js';
import { logSystemError } from '../services/systemErrorService.js';
import { cancelMatchTx } from '../services/matchService.js';

async function upsertCompetitions(provider) {
  const settings = await getSettings();
  const supported = new Set(settings.football_supported_competitions);
  let list;
  try {
    list = await provider.listCompetitions();
  } catch (err) {
    await logSystemError('football-sync:competitions', err);
    return [];
  }
  const active = list.filter((c) => supported.has(c.code));
  for (const [i, c] of active.entries()) {
    await query(
      `INSERT INTO football_competitions (provider, provider_competition_id, code, name, country, emblem_url, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), country = VALUES(country), emblem_url = VALUES(emblem_url)`,
      [provider.name, c.providerId, c.code, c.name, c.country, c.emblemUrl, i],
    );
  }
  return query('SELECT * FROM football_competitions WHERE is_enabled = 1');
}

async function upsertTeam(provider, team) {
  await query(
    `INSERT INTO football_teams (provider, provider_team_id, name, short_name, crest_url) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), short_name = VALUES(short_name), crest_url = VALUES(crest_url)`,
    [provider.name, team.providerId, team.name, team.shortName, team.crestUrl],
  );
  return queryOne('SELECT id FROM football_teams WHERE provider = ? AND provider_team_id = ?', [provider.name, team.providerId]).then((r) => r.id);
}

async function upsertFixture(provider, competitionRow, fx) {
  const homeId = await upsertTeam(provider, fx.homeTeam);
  const awayId = await upsertTeam(provider, fx.awayTeam);
  const isSimulated = provider.name === 'mock' ? 1 : 0;
  await query(
    `INSERT INTO football_fixtures
       (provider, provider_fixture_id, competition_id, season, home_team_id, away_team_id, kickoff_at, status, minute,
        home_score, away_score, home_shots, away_shots, home_shots_on_target, away_shots_on_target,
        home_possession, away_possession, home_corners, away_corners, home_cards, away_cards,
        first_goal_team, stats_available, is_simulated, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       kickoff_at = VALUES(kickoff_at), status = VALUES(status), minute = VALUES(minute),
       home_score = VALUES(home_score), away_score = VALUES(away_score),
       home_shots = VALUES(home_shots), away_shots = VALUES(away_shots),
       home_shots_on_target = VALUES(home_shots_on_target), away_shots_on_target = VALUES(away_shots_on_target),
       home_possession = VALUES(home_possession), away_possession = VALUES(away_possession),
       home_corners = VALUES(home_corners), away_corners = VALUES(away_corners),
       home_cards = VALUES(home_cards), away_cards = VALUES(away_cards),
       first_goal_team = VALUES(first_goal_team), stats_available = VALUES(stats_available),
       last_synced_at = NOW()`,
    [
      provider.name, fx.providerId, competitionRow.id, fx.season, homeId, awayId, new Date(fx.kickoffAt), fx.status, fx.minute,
      fx.homeScore, fx.awayScore, fx.stats.homeShots ?? null, fx.stats.awayShots ?? null,
      fx.stats.homeShotsOnTarget ?? null, fx.stats.awayShotsOnTarget ?? null,
      fx.stats.homePossession ?? null, fx.stats.awayPossession ?? null,
      fx.stats.homeCorners ?? null, fx.stats.awayCorners ?? null,
      fx.stats.homeCards ?? null, fx.stats.awayCards ?? null, fx.stats.firstGoalTeam ?? null, fx.statsAvailable ? 1 : 0, isSimulated,
    ],
  );
  return queryOne('SELECT * FROM football_fixtures WHERE provider = ? AND provider_fixture_id = ?', [provider.name, fx.providerId]);
}

async function insertNewEvents(fixtureRow, events) {
  if (!events?.length) return;
  const [{ maxMinute }] = await query('SELECT COALESCE(MAX(minute), -1) AS maxMinute FROM football_events WHERE fixture_id = ?', [fixtureRow.id]);
  const fresh = events.filter((e) => (e.minute ?? 0) > maxMinute);
  for (const e of fresh) {
    await query('INSERT INTO football_events (fixture_id, minute, type, team, player_name, detail) VALUES (?, ?, ?, ?, ?, ?)', [
      fixtureRow.id, e.minute, e.type, e.team, e.playerName || null, e.detail || null,
    ]);
  }
}

async function syncUpcomingFixtures(provider, competitions) {
  const from = new Date();
  const to = new Date(Date.now() + config.football.fixtureWindowDays * 86400000);
  for (const comp of competitions) {
    try {
      const fixtures = await provider.listUpcomingFixtures(comp.code, from.toISOString(), to.toISOString());
      for (const fx of fixtures) await upsertFixture(provider, comp, fx);
    } catch (err) {
      await logSystemError(`football-sync:fixtures:${comp.code}`, err);
    }
  }
}

/** Fixtures worth an individual refresh right now: imminent, live, or recently kicked off but not yet marked final. */
async function fixturesNeedingRefresh() {
  return query(
    `SELECT * FROM football_fixtures
     WHERE status IN ('SCHEDULED','LIVE') AND kickoff_at <= NOW() + INTERVAL 2 HOUR
     ORDER BY kickoff_at ASC LIMIT 40`,
  );
}

async function refreshFixture(provider, row) {
  let fx;
  try {
    fx = await provider.getFixture(row.provider_fixture_id);
  } catch (err) {
    await logSystemError(`football-sync:refresh:${row.provider_fixture_id}`, err);
    return;
  }
  if (!fx) return;
  const updated = await upsertFixture(provider, { id: row.competition_id }, fx);
  await insertNewEvents(updated, fx.events);

  if (['POSTPONED', 'CANCELLED'].includes(updated.status)) {
    await voidMatchesForFixture(updated.id, updated.status === 'POSTPONED' ? 'the football match was postponed' : 'the football match was cancelled', { toStatus: 'CANCELLED' });
  } else if (updated.status === 'ABANDONED') {
    await voidMatchesForFixture(updated.id, 'the football match was abandoned before full time', { toStatus: 'VOID' });
  } else if (updated.status === 'FINISHED') {
    await settleMatchesForFixture(updated.id);
  }
}

/** Kickoff has its own natural, unambiguous cutoff — enforce it here for anything that slipped through. */
async function transitionAndExpireAtKickoff() {
  // MATCHED football matches: kickoff has arrived, the "competition" begins.
  await query(
    `UPDATE matches m JOIN football_challenges fc ON fc.match_id = m.id JOIN football_fixtures fx ON fx.id = fc.fixture_id
     SET m.status = 'IN_PROGRESS', m.started_at = NOW()
     WHERE m.category = 'FOOTBALL' AND m.status = 'MATCHED' AND fx.kickoff_at <= NOW()`,
  );
  emitAll('config:update', {}); // cheap nudge so open clients refetch queue/fixture state

  // WAITING football matches that never found an opponent before kickoff.
  const stillWaiting = await query(
    `SELECT m.id, m.stake, m.pool, m.fee_percent FROM matches m JOIN football_challenges fc ON fc.match_id = m.id JOIN football_fixtures fx ON fx.id = fc.fixture_id
     WHERE m.category = 'FOOTBALL' AND m.status = 'WAITING' AND fx.kickoff_at <= NOW() LIMIT 50`,
  );
  for (const row of stillWaiting) {
    await withTransaction(async (tx) => {
      const m = await tx.one('SELECT * FROM matches WHERE id = ? FOR UPDATE', [row.id]);
      if (m && m.status === 'WAITING') await cancelMatchTx(tx, m, 'kickoff arrived before an opponent was found');
    }).catch((err) => logSystemError('football-sync:waiting-timeout', err));
  }

  // Pending direct challenges for a fixture that has now kicked off.
  const staleChallenges = await query(
    `SELECT c.id, c.challenger_id, c.opponent_id FROM challenges c JOIN football_fixtures fx ON fx.id = c.fixture_id
     WHERE c.status = 'PENDING' AND fx.kickoff_at <= NOW() LIMIT 50`,
  );
  for (const c of staleChallenges) {
    await withTransaction(async (tx) => {
      const upd = await tx.q(`UPDATE challenges SET status = 'EXPIRED' WHERE id = ? AND status = 'PENDING'`, [c.id]);
      if (upd.affectedRows === 1) {
        await notify(tx, c.challenger_id, { type: 'CHALLENGE_EXPIRED', title: 'Challenge expired', message: 'Your football challenge expired because the match kicked off before your opponent responded.', link: '/challenges' });
      }
    }).catch((err) => logSystemError('football-sync:challenge-expiry', err));
  }
}

// A provider outage must never silently settle a competition incorrectly.
// If a fixture still hasn't produced a final result long after it should
// have (kickoff + this grace period), stop waiting and void — full refund,
// no fee — rather than leave players' stakes in limbo forever.
const UNRESOLVED_GRACE_HOURS = 4;

export async function voidUnresolvedFixtures() {
  // Deliberately not filtered by fixture status: a fixture can be FINISHED
  // and still be "unresolved" for a stats-dependent challenge type whose
  // required numbers never arrived (settleFootballMatch waits rather than
  // guesses) — that must eventually void too, not just a fixture stuck
  // SCHEDULED/LIVE forever.
  const stuck = await query(
    `SELECT DISTINCT fc.fixture_id AS id FROM matches m JOIN football_challenges fc ON fc.match_id = m.id JOIN football_fixtures fx ON fx.id = fc.fixture_id
     WHERE m.category = 'FOOTBALL' AND m.status = 'IN_PROGRESS' AND m.settled_at IS NULL
       AND fx.kickoff_at <= NOW() - INTERVAL ${UNRESOLVED_GRACE_HOURS} HOUR`,
  );
  for (const { id } of stuck) {
    await voidMatchesForFixture(id, 'the result could not be verified in time', { toStatus: 'VOID' }).catch((err) => logSystemError('football-sync:unresolved', err));
  }
}

export async function runFootballSync() {
  const provider = getFootballProvider();
  const competitions = await upsertCompetitions(provider);
  if (competitions.length) await syncUpcomingFixtures(provider, competitions);
  const toRefresh = await fixturesNeedingRefresh();
  for (const row of toRefresh) await refreshFixture(provider, row);
  await transitionAndExpireAtKickoff();
  await voidUnresolvedFixtures();
}

export function startFootballSync(intervalSeconds) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runFootballSync();
    } catch (err) {
      await logSystemError('football-sync', err);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, intervalSeconds * 1000);
  tick();
  return handle;
}
