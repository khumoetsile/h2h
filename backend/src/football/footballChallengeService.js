// Player-facing football challenge flows. Both matchmaking ("find an
// opponent who picked the other side") and direct challenges reuse the exact
// same match/wallet primitives as skill games (createMatchTx, lockStake,
// joinLockedMatch) — a football head-to-head is a normal Head2Head match
// underneath, just one whose outcome the system decides from a football
// fixture instead of gameplay input.
import { query, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { formatMoney, toCents } from '../utils/money.js';
import { getSettings } from '../services/settingsService.js';
import { notify } from '../services/notificationService.js';
import { emitToUser } from '../realtime.js';
import { lockStake } from '../services/walletService.js';
import { createMatchTx, joinLockedMatch, getMatchView, ACTIVE_STATUSES } from '../services/matchService.js';
import { getFootballProvider } from './providerRegistry.js';

const PICKS_BY_TYPE = { TEAM: ['HOME', 'AWAY'], YES_NO: ['YES', 'NO'] };
const opposite = (pickType, pick) => PICKS_BY_TYPE[pickType].find((p) => p !== pick);
const fillQuestion = (template, home, away) => template.replace('{home}', home).replace('{away}', away);

let footballGameIdCache = null;
async function footballGameId(runner = query) {
  if (footballGameIdCache) return footballGameIdCache;
  const rows = await runner('SELECT id FROM games WHERE slug = ?', ['football']);
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) throw new Error('Football pseudo-game row is missing — re-run the seed script.');
  footballGameIdCache = row.id;
  return footballGameIdCache;
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

export async function listCompetitions() {
  return query('SELECT id, code, name, country, emblem_url AS emblemUrl FROM football_competitions WHERE is_enabled = 1 ORDER BY sort_order, name');
}

function mapFixtureRow(r) {
  return {
    id: r.id,
    competition: { id: r.competition_id, code: r.competition_code, name: r.competition_name },
    homeTeam: { id: r.home_team_id, name: r.home_name, shortName: r.home_short, crestUrl: r.home_crest },
    awayTeam: { id: r.away_team_id, name: r.away_name, shortName: r.away_short, crestUrl: r.away_crest },
    kickoffAt: r.kickoff_at,
    status: r.status,
    minute: r.minute,
    homeScore: r.home_score,
    awayScore: r.away_score,
    isSimulated: !!r.is_simulated,
    openChallenges: Number(r.open_count || 0),
  };
}

const FIXTURE_SELECT = `
  SELECT fx.*, comp.code AS competition_code, comp.name AS competition_name,
         ht.name AS home_name, ht.short_name AS home_short, ht.crest_url AS home_crest,
         at.name AS away_name, at.short_name AS away_short, at.crest_url AS away_crest,
         (SELECT COUNT(*) FROM matches m JOIN football_challenges fc2 ON fc2.match_id = m.id
          WHERE fc2.fixture_id = fx.id AND m.status = 'WAITING') AS open_count
  FROM football_fixtures fx
  JOIN football_competitions comp ON comp.id = fx.competition_id
  JOIN football_teams ht ON ht.id = fx.home_team_id
  JOIN football_teams at ON at.id = fx.away_team_id`;

export async function listFixtures({ competitionId, status } = {}) {
  const where = ['comp.is_enabled = 1'];
  const params = [];
  if (competitionId) { where.push('fx.competition_id = ?'); params.push(competitionId); }
  if (status === 'live') where.push(`fx.status = 'LIVE'`);
  else if (status === 'upcoming') where.push(`fx.status = 'SCHEDULED'`);
  else where.push(`fx.status IN ('SCHEDULED','LIVE')`);
  const rows = await query(`${FIXTURE_SELECT} WHERE ${where.join(' AND ')} ORDER BY fx.kickoff_at ASC LIMIT 60`, params);
  return rows.map(mapFixtureRow);
}

export async function listChallengeTypes() {
  const caps = getFootballProvider().capabilities();
  const rows = await query('SELECT * FROM football_challenge_types WHERE is_enabled = 1 ORDER BY sort_order');
  return rows
    .filter((t) => !t.requires_stats || (caps.statistics && caps.events))
    .map((t) => ({ id: t.id, slug: t.slug, name: t.name, question: t.question_template, pickType: t.pick_type, settlementSummary: t.settlement_summary }));
}

export async function getFixtureDetail(fixtureId) {
  const row = (await query(`${FIXTURE_SELECT} WHERE fx.id = ?`, [fixtureId]))[0];
  if (!row) throw notFound('Fixture not found.');
  const settings = await getSettings();
  const types = (await listChallengeTypes()).map((t) => ({ ...t, question: fillQuestion(t.question, row.home_short, row.away_short) }));
  return { ...mapFixtureRow(row), challengeTypes: types, stakes: settings.stake_amounts };
}

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

async function loadEligibleTypeAndFixture(runner, fixtureId, challengeTypeSlug) {
  const fixture = await runner(`${FIXTURE_SELECT} WHERE fx.id = ?`, [fixtureId]).then((r) => r[0]);
  if (!fixture) throw notFound('Fixture not found.');
  const type = await runner('SELECT * FROM football_challenge_types WHERE slug = ? AND is_enabled = 1', [challengeTypeSlug]).then((r) => r[0]);
  if (!type) throw notFound('This challenge type is not available.');
  const caps = getFootballProvider().capabilities();
  if (type.requires_stats && !(caps.statistics && caps.events)) {
    throw conflict('CHALLENGE_TYPE_UNAVAILABLE', 'This challenge type needs match statistics our current data source does not provide yet.');
  }
  // The cutoff is strict and absolute: once the fixture is no longer
  // SCHEDULED (or kickoff has passed), nobody may create or accept a new
  // pick — by then live information could give one side an unfair edge.
  if (fixture.status !== 'SCHEDULED' || new Date(fixture.kickoff_at) <= new Date()) {
    throw conflict('CHALLENGE_CLOSED', 'This match has already kicked off, so new challenges are no longer available for it.');
  }
  return { fixture, type };
}

function validatePick(type, pick) {
  const allowed = PICKS_BY_TYPE[type.pick_type];
  if (!allowed.includes(pick)) throw badRequest('INVALID_PICK', `Choose one of: ${allowed.join(' or ')}.`);
}

async function validateStakeAmount(stake) {
  const settings = await getSettings();
  if (!settings.stake_amounts.some((s) => toCents(s) === toCents(stake))) {
    throw badRequest('INVALID_STAKE', `Invalid entry amount. Choose one of: ${settings.stake_amounts.map((s) => formatMoney(s)).join(', ')}.`);
  }
}

// ---------------------------------------------------------------------------
// Matchmaking ("find an opponent")
// ---------------------------------------------------------------------------

export async function findFootballOpponent(userId, { fixtureId, challengeTypeSlug, pick, stake }) {
  await validateStakeAmount(stake);
  return withTransaction(async (tx) => {
    const { fixture, type } = await loadEligibleTypeAndFixture(tx.q, fixtureId, challengeTypeSlug);
    validatePick(type, pick);
    const gameId = await footballGameId(tx.q);

    const own = await tx.one(
      `SELECT m.id FROM matches m JOIN football_challenges fc ON fc.match_id = m.id
       WHERE m.created_by = ? AND m.status = 'WAITING' AND fc.fixture_id = ? AND fc.challenge_type_id = ? AND m.stake = ? LIMIT 1`,
      [userId, fixtureId, type.id, stake],
    );
    if (own) return { matchId: own.id, matched: false, alreadyQueued: true };

    const [{ n }] = await tx.q(
      `SELECT COUNT(*) AS n FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.user_id = ? AND m.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`,
      [userId, ...ACTIVE_STATUSES],
    );
    if (n >= 5) throw conflict('TOO_MANY_ACTIVE_MATCHES', 'You already have several active matches. Finish or cancel one first.');

    const oppositePick = opposite(type.pick_type, pick);
    const candidate = await tx.one(
      `SELECT m.* FROM matches m JOIN football_challenges fc ON fc.match_id = m.id JOIN users u ON u.id = m.created_by AND u.status = 'ACTIVE'
       WHERE m.status = 'WAITING' AND fc.fixture_id = ? AND fc.challenge_type_id = ? AND m.stake = ? AND fc.creator_pick = ? AND m.created_by <> ?
       ORDER BY m.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [fixtureId, type.id, stake, oppositePick, userId],
    );
    if (candidate) {
      await joinLockedMatch(tx, candidate, userId);
      await tx.q('UPDATE football_challenges SET opponent_pick = ? WHERE match_id = ?', [pick, candidate.id]);
      return { matchId: candidate.id, matched: true };
    }

    const { match } = await createMatchTx(tx, userId, gameId, stake, { source: 'MATCHMAKING', category: 'FOOTBALL' });
    await tx.q(
      `INSERT INTO football_challenges (match_id, fixture_id, challenge_type_id, creator_pick, cutoff_at) VALUES (?, ?, ?, ?, ?)`,
      [match.id, fixtureId, type.id, pick, fixture.kickoff_at],
    );
    return { matchId: match.id, matched: false };
  });
}

// ---------------------------------------------------------------------------
// Direct challenge (pending, in the shared `challenges` table)
// ---------------------------------------------------------------------------

function mapFootballChallenge(c, viewerId) {
  return {
    id: c.id,
    status: c.status,
    direction: viewerId === c.challenger_id ? 'OUTGOING' : 'INCOMING',
    challenger: { userId: c.challenger_id, username: c.challenger_username, avatarColor: c.challenger_color },
    opponent: { userId: c.opponent_id, username: c.opponent_username, avatarColor: c.opponent_color },
    stake: Number(c.stake),
    potentialPrize: c.prize_preview,
    message: c.message,
    matchId: c.match_id,
    matchCode: c.match_code || null,
    expiresAt: c.expires_at,
    createdAt: c.created_at,
    football: {
      fixtureId: c.fixture_id,
      competition: c.competition_name,
      homeTeam: c.home_name, awayTeam: c.away_name,
      kickoffAt: c.kickoff_at,
      question: fillQuestion(c.question_template, c.home_short, c.away_short),
      creatorPick: c.creator_pick,
      creatorPickLabel: c.creator_pick === 'HOME' ? c.home_short : c.creator_pick === 'AWAY' ? c.away_short : c.creator_pick,
    },
  };
}

export async function createFootballChallenge(challengerId, { opponent, fixtureId, challengeTypeSlug, pick, stake, message }) {
  await validateStakeAmount(stake);
  const id = await withTransaction(async (tx) => {
    const { type } = await loadEligibleTypeAndFixture(tx.q, fixtureId, challengeTypeSlug);
    validatePick(type, pick);
    const handle = String(opponent || '').replace(/^@/, '').trim();
    const opp = typeof opponent === 'number' ? await tx.one('SELECT * FROM users WHERE id = ?', [opponent]) : await tx.one('SELECT * FROM users WHERE username = ?', [handle]);
    if (!opp) throw notFound('No player found with that username.');
    if (opp.id === challengerId) throw badRequest('CANNOT_CHALLENGE_SELF', "You can't challenge yourself.");
    if (opp.status !== 'ACTIVE' || opp.role !== 'PLAYER') throw conflict('OPPONENT_UNAVAILABLE', `${opp.username} is not available for challenges.`);
    const wallet = await tx.one('SELECT available_balance FROM wallets WHERE user_id = ?', [challengerId]);
    if (toCents(wallet.available_balance) < toCents(stake)) throw badRequest('INSUFFICIENT_BALANCE', `You need ${formatMoney(stake)} DEMO available to send this challenge.`);
    const dup = await tx.one(
      `SELECT id FROM challenges WHERE status = 'PENDING' AND expires_at > NOW() AND fixture_id = ? AND challenge_type_id = ?
       AND ((challenger_id = ? AND opponent_id = ?) OR (challenger_id = ? AND opponent_id = ?)) LIMIT 1 FOR UPDATE`,
      [fixtureId, type.id, challengerId, opp.id, opp.id, challengerId],
    );
    if (dup) throw conflict('DUPLICATE_CHALLENGE', `There is already a pending challenge for this match between you and ${opp.username}.`);
    const settings = await getSettings();
    const gameId = await footballGameId(tx.q);
    const me = await tx.one('SELECT username FROM users WHERE id = ?', [challengerId]);
    const res = await tx.q(
      `INSERT INTO challenges (challenger_id, opponent_id, game_id, fixture_id, challenge_type_id, creator_pick, stake, message, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW() + INTERVAL ? MINUTE)`,
      [challengerId, opp.id, gameId, fixtureId, type.id, pick, stake, message ? String(message).slice(0, 140) : null, settings.challenge_expiry_minutes],
    );
    await notify(tx, opp.id, {
      type: 'CHALLENGE_RECEIVED',
      title: `${me.username} challenged you`,
      message: `${me.username} challenged you on a football match for ${formatMoney(stake)} DEMO.`,
      link: '/challenges',
    });
    tx.afterCommit(() => emitToUser(opp.id, 'challenge:update', { id: res.insertId }));
    return res.insertId;
  });
  return getFootballChallenge(id, challengerId);
}

const CHALLENGE_SELECT = `
  SELECT c.*, cu.username AS challenger_username, cu.avatar_color AS challenger_color,
         ou.username AS opponent_username, ou.avatar_color AS opponent_color, m.code AS match_code,
         ct.question_template, comp.name AS competition_name, fx.kickoff_at,
         ht.name AS home_name, ht.short_name AS home_short, at.name AS away_name, at.short_name AS away_short
  FROM challenges c
  JOIN users cu ON cu.id = c.challenger_id
  JOIN users ou ON ou.id = c.opponent_id
  LEFT JOIN matches m ON m.id = c.match_id
  JOIN football_challenge_types ct ON ct.id = c.challenge_type_id
  JOIN football_fixtures fx ON fx.id = c.fixture_id
  JOIN football_competitions comp ON comp.id = fx.competition_id
  JOIN football_teams ht ON ht.id = fx.home_team_id
  JOIN football_teams at ON at.id = fx.away_team_id`;

async function withPrizePreview(rows) {
  const { platform_fee_percent: fee } = await getSettings();
  return rows.map((r) => ({ ...r, prize_preview: (toCents(r.stake) * 2 * (1 - fee / 100)) / 100 }));
}

export async function getFootballChallenge(id, viewerId) {
  const rows = await withPrizePreview(await query(`${CHALLENGE_SELECT} WHERE c.id = ?`, [id]));
  const c = rows[0];
  if (!c) throw notFound('Challenge not found.');
  if (c.challenger_id !== viewerId && c.opponent_id !== viewerId) throw forbidden('This challenge is not yours.');
  return mapFootballChallenge(c, viewerId);
}

export async function acceptFootballChallenge(userId, id) {
  const matchId = await withTransaction(async (tx) => {
    const c = await tx.one('SELECT * FROM challenges WHERE id = ? FOR UPDATE', [id]);
    if (!c) throw notFound('Challenge not found.');
    if (c.opponent_id !== userId) throw forbidden('Only the challenged player can accept.');
    if (c.status === 'PENDING' && new Date(c.expires_at) <= new Date()) throw conflict('CHALLENGE_EXPIRED', 'This challenge has expired.');
    if (c.status !== 'PENDING') throw conflict('CHALLENGE_CLOSED', `This challenge is already ${c.status.toLowerCase()}.`);
    const fixture = await tx.one('SELECT * FROM football_fixtures WHERE id = ? FOR UPDATE', [c.fixture_id]);
    if (fixture.status !== 'SCHEDULED' || new Date(fixture.kickoff_at) <= new Date()) {
      throw conflict('CHALLENGE_CLOSED', 'This match has already kicked off, so this challenge is no longer available.');
    }
    const type = await tx.one('SELECT * FROM football_challenge_types WHERE id = ?', [c.challenge_type_id]);
    const [challenger, me] = await Promise.all([
      tx.one('SELECT * FROM users WHERE id = ?', [c.challenger_id]),
      tx.one('SELECT username FROM users WHERE id = ?', [userId]),
    ]);
    if (challenger.status !== 'ACTIVE') throw conflict('OPPONENT_UNAVAILABLE', 'The challenger is no longer available.');
    for (const uid of [c.challenger_id, userId].sort((a, b) => a - b)) await tx.q('SELECT id FROM wallets WHERE user_id = ? FOR UPDATE', [uid]);
    const cw = await tx.one('SELECT available_balance FROM wallets WHERE user_id = ?', [c.challenger_id]);
    if (toCents(cw.available_balance) < toCents(c.stake)) throw conflict('OPPONENT_INSUFFICIENT_BALANCE', `${challenger.username} no longer has enough demo funds for this challenge.`);
    const gameId = await footballGameId(tx.q);
    const { match, game } = await createMatchTx(tx, c.challenger_id, gameId, c.stake, { source: 'CHALLENGE', status: 'MATCHED', category: 'FOOTBALL' });
    await lockStake(tx, userId, match, game.name);
    await tx.q('INSERT INTO match_players (match_id, user_id, slot, stake) VALUES (?, ?, 2, ?)', [match.id, userId, c.stake]);
    await tx.q('UPDATE matches SET matched_at = NOW() WHERE id = ?', [match.id]);
    await tx.q(`UPDATE challenges SET status = 'ACCEPTED', responded_at = NOW(), match_id = ? WHERE id = ?`, [match.id, c.id]);
    const opponentPick = opposite(type.pick_type, c.creator_pick);
    await tx.q(
      `INSERT INTO football_challenges (match_id, fixture_id, challenge_type_id, creator_pick, opponent_pick, cutoff_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [match.id, c.fixture_id, c.challenge_type_id, c.creator_pick, opponentPick, fixture.kickoff_at],
    );
    await notify(tx, c.challenger_id, { type: 'CHALLENGE_ACCEPTED', title: 'Challenge accepted', message: `${me.username} accepted your football challenge. Your match is ready.`, link: `/match/${match.code}` });
    for (const uid of [c.challenger_id, userId]) tx.afterCommit(() => emitToUser(uid, 'challenge:update', { id: c.id }));
    return match.id;
  });
  return getMatchView(matchId, userId);
}
