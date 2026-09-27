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
import { createMatchTx, joinLockedMatch, getMatchView, recordLockIn, ACTIVE_STATUSES } from '../services/matchService.js';
import { assertPending } from '../services/challengeService.js';
import { getFootballProvider } from './providerRegistry.js';
import { recordAudit } from '../services/auditService.js';
import { acceptanceDeadline } from '../timers.js';

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
          WHERE fc2.fixture_id = fx.id AND m.status = 'WAITING' AND m.acceptance_deadline > NOW(3)) AS open_count
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
  const rows = await query(`${FIXTURE_SELECT} WHERE ${where.join(' AND ')} ORDER BY fx.kickoff_at ASC LIMIT 150`, params);
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
// Open Challenges — publicly discoverable 1v1s waiting for a second player
// ---------------------------------------------------------------------------

const OPEN_CHALLENGE_SELECT = `
  SELECT m.id AS match_id, m.code, m.stake, m.created_at, m.created_by, m.acceptance_deadline, fx.kickoff_at,
         u.username AS creator_username, u.avatar_color AS creator_color,
         fc.fixture_id, fc.creator_pick, ct.slug AS type_slug, ct.name AS type_name, ct.question_template, ct.pick_type,
         comp.name AS competition_name, comp.code AS competition_code,
         ht.name AS home_name, ht.short_name AS home_short, at.name AS away_name, at.short_name AS away_short
  FROM matches m
  JOIN football_challenges fc ON fc.match_id = m.id
  JOIN users u ON u.id = m.created_by
  JOIN football_challenge_types ct ON ct.id = fc.challenge_type_id
  JOIN football_fixtures fx ON fx.id = fc.fixture_id
  JOIN football_competitions comp ON comp.id = fx.competition_id
  JOIN football_teams ht ON ht.id = fx.home_team_id
  JOIN football_teams at ON at.id = fx.away_team_id
  WHERE m.category = 'FOOTBALL' AND m.status = 'WAITING' AND m.source = 'MATCHMAKING'
    AND fx.status = 'SCHEDULED' AND fx.kickoff_at > NOW()`;

function mapOpenChallenge(r) {
  const pickLabel = (pick) => (pick === 'HOME' ? (r.home_short || r.home_name) : pick === 'AWAY' ? (r.away_short || r.away_name) : pick);
  return {
    matchId: r.match_id,
    code: r.code,
    stake: Number(r.stake),
    createdAt: r.created_at,
    acceptanceDeadline: r.acceptance_deadline,
    kickoffAt: r.kickoff_at,
    creator: { username: r.creator_username, avatarColor: r.creator_color },
    fixtureId: r.fixture_id,
    competition: { name: r.competition_name, code: r.competition_code },
    homeTeam: r.home_name, awayTeam: r.away_name,
    challengeType: { slug: r.type_slug, name: r.type_name, question: fillQuestion(r.question_template, r.home_short, r.away_short), pickType: r.pick_type },
    creatorPick: r.creator_pick,
    creatorPickLabel: pickLabel(r.creator_pick),
  };
}

/** Every open (WAITING, not yet matched) football challenge — visible to any player except its own creator, who instead sees it under "My Challenges". */
export async function listOpenChallenges(viewerId, { fixtureId = null } = {}) {
  // Only challenges whose acceptance timer is still running — an expired one
  // disappears immediately, even before the sweeper has formally closed it.
  const extra = fixtureId ? ' AND fc.fixture_id = ?' : '';
  const params = fixtureId ? [new Date(), viewerId, fixtureId] : [new Date(), viewerId];
  const rows = await query(`${OPEN_CHALLENGE_SELECT} AND m.acceptance_deadline > ? AND m.created_by <> ?${extra} ORDER BY m.acceptance_deadline ASC LIMIT 100`, params);
  return rows.map(mapOpenChallenge);
}

/**
 * Join a specific publicly-listed open challenge — this IS the explicit
 * "take the opposing side" action (there is only one side left once the
 * creator has picked), so no separate pick input is required here, unlike
 * a direct-by-username challenge. Race-safe: the row lock means if two
 * players hit this at once, only the first commits; the second sees the
 * row is no longer WAITING and gets a clear "already taken" error — the
 * match can never end up with more than 2 players.
 */
export async function joinOpenChallenge(userId, matchId) {
  const resultMatchId = await withTransaction(async (tx) => {
    const m = await tx.one(`SELECT * FROM matches WHERE id = ? FOR UPDATE`, [matchId]);
    if (!m || m.category !== 'FOOTBALL') throw notFound('Challenge not found.');
    if (m.created_by === userId) throw badRequest('CANNOT_JOIN_OWN_MATCH', "You can't join your own challenge.");
    if (m.status !== 'WAITING') {
      throw conflict('CHALLENGE_ALREADY_TAKEN', 'This challenge has already been taken by another player.');
    }
    const fc = await tx.one(`SELECT fc.*, ct.pick_type FROM football_challenges fc JOIN football_challenge_types ct ON ct.id = fc.challenge_type_id WHERE fc.match_id = ?`, [matchId]);
    if (!fc) throw notFound('Challenge not found.');
    const fixture = await tx.one('SELECT * FROM football_fixtures WHERE id = ?', [fc.fixture_id]);
    if (fixture.status !== 'SCHEDULED' || new Date(fixture.kickoff_at) <= new Date()) {
      throw conflict('CHALLENGE_CLOSED', 'This match has already kicked off, so this challenge is no longer available.');
    }
    const opponentPick = opposite(fc.pick_type, fc.creator_pick);
    await tx.q('UPDATE football_challenges SET opponent_pick = ? WHERE match_id = ?', [opponentPick, matchId]);
    // "Accept & Lock In": the joiner is locked in as part of joining; the
    // creator's lock-in timer starts. Throws CHALLENGE_EXPIRED if the
    // acceptance timer already ran out.
    await joinLockedMatch(tx, m, userId, { lockIn: true });
    await recordAudit(tx, {
      actorType: 'PLAYER', actorUserId: userId, action: 'CHALLENGE_ACCEPTED', entityType: 'MATCH', entityId: matchId, matchId,
      previousState: 'WAITING', newState: 'MATCHED', metadata: { fixtureId: fc.fixture_id, opponentPick, source: 'OPEN_CHALLENGE', lockedIn: true },
    });
    return matchId;
  });
  return getMatchView(resultMatchId, userId);
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

    const now = new Date();
    const own = await tx.one(
      `SELECT m.id FROM matches m JOIN football_challenges fc ON fc.match_id = m.id
       WHERE m.created_by = ? AND m.status = 'WAITING' AND m.acceptance_deadline > ? AND fc.fixture_id = ? AND fc.challenge_type_id = ? AND m.stake = ? LIMIT 1`,
      [userId, now, fixtureId, type.id, stake],
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
       WHERE m.status = 'WAITING' AND m.acceptance_deadline > ? AND fc.fixture_id = ? AND fc.challenge_type_id = ? AND m.stake = ? AND fc.creator_pick = ? AND m.created_by <> ?
       ORDER BY m.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [now, fixtureId, type.id, stake, oppositePick, userId],
    );
    if (candidate) {
      // An instant pairing: this player confirmed the lock-in terms before
      // searching, so they join already locked in.
      await tx.q('UPDATE football_challenges SET opponent_pick = ? WHERE match_id = ?', [pick, candidate.id]);
      await joinLockedMatch(tx, candidate, userId, { lockIn: true });
      return { matchId: candidate.id, matched: true };
    }

    // The creator locks in as they create it (they confirmed the lock-in
    // screen). When someone joins with Accept & Lock In, it's LOCKED at once.
    const { match } = await createMatchTx(tx, userId, gameId, stake, { source: 'MATCHMAKING', category: 'FOOTBALL', kickoffAt: fixture.kickoff_at, lockIn: true });
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
      pickType: c.pick_type,
      creatorPick: c.creator_pick,
      creatorPickLabel: c.creator_pick === 'HOME' ? c.home_short : c.creator_pick === 'AWAY' ? c.away_short : c.creator_pick,
      homePickLabel: c.home_short || c.home_name,
      awayPickLabel: c.away_short || c.away_name,
    },
  };
}

export async function createFootballChallenge(challengerId, { opponent, fixtureId, challengeTypeSlug, pick, stake, message }) {
  await validateStakeAmount(stake);
  const id = await withTransaction(async (tx) => {
    const { type, fixture } = await loadEligibleTypeAndFixture(tx.q, fixtureId, challengeTypeSlug);
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
    const gameId = await footballGameId(tx.q);
    const me = await tx.one('SELECT username FROM users WHERE id = ?', [challengerId]);
    // The opponent gets the standard acceptance window — never past kickoff.
    const res = await tx.q(
      `INSERT INTO challenges (challenger_id, opponent_id, game_id, fixture_id, challenge_type_id, creator_pick, stake, message, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [challengerId, opp.id, gameId, fixtureId, type.id, pick, stake, message ? String(message).slice(0, 140) : null, acceptanceDeadline(new Date(), fixture.kickoff_at)],
    );
    await notify(tx, opp.id, {
      type: 'CHALLENGE_RECEIVED',
      title: `${me.username} challenged you`,
      message: `${me.username} challenged you on a football match for ${formatMoney(stake)} DEMO.`,
      link: '/challenges',
    });
    tx.afterCommit(() => emitToUser(opp.id, 'challenge:update', { id: res.insertId }));
    await recordAudit(tx, {
      actorType: 'PLAYER', actorUserId: challengerId, action: 'CHALLENGE_CREATED', entityType: 'CHALLENGE', entityId: res.insertId,
      challengeId: res.insertId, newState: 'PENDING', metadata: { opponentId: opp.id, fixtureId, challengeTypeSlug, pick, stake, football: true },
    });
    return res.insertId;
  });
  return getFootballChallenge(id, challengerId);
}

const CHALLENGE_SELECT = `
  SELECT c.*, cu.username AS challenger_username, cu.avatar_color AS challenger_color,
         ou.username AS opponent_username, ou.avatar_color AS opponent_color, m.code AS match_code,
         ct.question_template, ct.pick_type, comp.name AS competition_name, fx.kickoff_at,
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

/**
 * Accept a direct football challenge. The opponent's pick is NOT derived —
 * it must come from the opponent's own request, and the backend
 * independently validates it (against the challenge type's allowed picks,
 * and against the creator's pick — the two sides can never match). This is
 * what makes the challenge genuinely player-vs-player rather than one
 * player's pick simply being echoed back as the "opponent's" side.
 */
export async function acceptFootballChallenge(userId, id, { pick: opponentPick } = {}) {
  const matchId = await withTransaction(async (tx) => {
    const c = await tx.one('SELECT * FROM challenges WHERE id = ? FOR UPDATE', [id]);
    if (!c) throw notFound('Challenge not found.');
    if (c.opponent_id !== userId) throw forbidden('Only the challenged player can accept.');
    assertPending(c);
    const fixture = await tx.one('SELECT * FROM football_fixtures WHERE id = ? FOR UPDATE', [c.fixture_id]);
    if (fixture.status !== 'SCHEDULED' || new Date(fixture.kickoff_at) <= new Date()) {
      throw conflict('CHALLENGE_CLOSED', 'This match has already kicked off, so this challenge is no longer available.');
    }
    const type = await tx.one('SELECT * FROM football_challenge_types WHERE id = ?', [c.challenge_type_id]);
    // The frontend is never trusted here: re-validate the pick server-side
    // even though the client should already prevent both of these.
    if (!opponentPick) throw badRequest('PICK_REQUIRED', 'Choose your side before accepting.');
    validatePick(type, opponentPick);
    if (opponentPick === c.creator_pick) {
      throw conflict('SAME_SIDE_NOT_ALLOWED', 'You must take the opposing side to accept this challenge — the challenger already picked that one.');
    }
    const [challenger, me] = await Promise.all([
      tx.one('SELECT * FROM users WHERE id = ?', [c.challenger_id]),
      tx.one('SELECT username FROM users WHERE id = ?', [userId]),
    ]);
    if (challenger.status !== 'ACTIVE') throw conflict('OPPONENT_UNAVAILABLE', 'The challenger is no longer available.');
    for (const uid of [c.challenger_id, userId].sort((a, b) => a - b)) await tx.q('SELECT id FROM wallets WHERE user_id = ? FOR UPDATE', [uid]);
    const cw = await tx.one('SELECT available_balance FROM wallets WHERE user_id = ?', [c.challenger_id]);
    if (toCents(cw.available_balance) < toCents(c.stake)) throw conflict('OPPONENT_INSUFFICIENT_BALANCE', `${challenger.username} no longer has enough demo funds for this challenge.`);
    const gameId = await footballGameId(tx.q);
    // The challenger locked in when they sent it (lock-in screen, fee
    // disclosed); the acceptor locks in now -> LOCKED straight away.
    const { match, game } = await createMatchTx(tx, c.challenger_id, gameId, c.stake, { source: 'CHALLENGE', status: 'MATCHED', category: 'FOOTBALL', kickoffAt: fixture.kickoff_at, lockIn: true });
    await lockStake(tx, userId, match, game.name);
    await tx.q('INSERT INTO match_players (match_id, user_id, slot, stake) VALUES (?, ?, 2, ?)', [match.id, userId, c.stake]);
    await tx.q(`UPDATE challenges SET status = 'ACCEPTED', responded_at = NOW(), match_id = ? WHERE id = ?`, [match.id, c.id]);
    await tx.q(
      `INSERT INTO football_challenges (match_id, fixture_id, challenge_type_id, creator_pick, opponent_pick, cutoff_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [match.id, c.fixture_id, c.challenge_type_id, c.creator_pick, opponentPick, fixture.kickoff_at],
    );
    await recordAudit(tx, {
      actorType: 'PLAYER', actorUserId: userId, action: 'CHALLENGE_ACCEPTED', entityType: 'CHALLENGE', entityId: c.id,
      challengeId: c.id, matchId: match.id, previousState: 'PENDING', newState: 'ACCEPTED',
      metadata: { fixtureId: c.fixture_id, opponentPick, creatorPick: c.creator_pick, lockedIn: true },
    });
    // "Accept & Lock In" — the accepting player is locked in now.
    await recordLockIn(tx, match.id, userId);
    await notify(tx, c.challenger_id, { type: 'CHALLENGE_ACCEPTED', title: 'Challenge accepted — locked in', message: `${me.username} accepted your football challenge. You're both locked in.`, link: `/match/${match.code}` });
    for (const uid of [c.challenger_id, userId]) tx.afterCommit(() => emitToUser(uid, 'challenge:update', { id: c.id }));
    return match.id;
  });
  return getMatchView(matchId, userId);
}
