import { pool, query, queryOne, withTransaction } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";
import { notify } from "../services/notificationService.js";
import {
  OUTCOMES,
  ACHIEVEMENTS,
  challengeDay,
  periodBounds,
  verifiedOutcome,
  calculateStats,
} from "./dailyPredictionRules.js";
export const dailyTimezone =
  process.env.DAILY_PREDICTION_TIMEZONE || "Africa/Gaborone";
export const dailySlots = Number(process.env.DAILY_PREDICTION_COUNT || 1);
challengeDay(new Date(), dailyTimezone); // Fail startup on invalid timezone/configuration.
if (!Number.isSafeInteger(dailySlots) || dailySlots < 1 || dailySlots > 10)
  throw new Error("DAILY_PREDICTION_COUNT must be between 1 and 10");
const dateSql = "DATE_FORMAT(c.challenge_date,'%Y-%m-%d')";
const joined = `FROM daily_prediction_challenges c JOIN football_fixtures f ON f.id=c.fixture_id JOIN football_teams h ON h.id=c.home_team_id JOIN football_teams a ON a.id=c.away_team_id JOIN football_teams r ON r.id=c.reference_team_id`;
async function notice(tx, userId, key, title, message) {
  const pref = await tx.one(
    "SELECT reminders FROM daily_prediction_preferences WHERE user_id=?",
    [userId],
  );
  if (!pref?.reminders) return;
  const row = await tx.q(
    "INSERT IGNORE INTO daily_prediction_notices(user_id,notice_key) VALUES (?,?)",
    [userId, key],
  );
  if (row.affectedRows)
    await notify(tx, userId, {
      type: "DAILY_PREDICTION",
      title,
      message,
      link: "/daily-predictions",
    });
}
async function rebuildStats(tx, onlyUser = null) {
  // One history read and one participant read, never one query per participant.
  const challenges = await tx.q(
    `SELECT c.*,${dateSql} challenge_date FROM daily_prediction_challenges c ORDER BY c.challenge_date,c.slot`,
  );
  const predictions = await tx.q(
    `SELECT * FROM daily_predictions${onlyUser ? " WHERE user_id=?" : ""}`,
    onlyUser ? [onlyUser] : [],
  );
  const grouped = new Map();
  for (const p of predictions) {
    if (!grouped.has(p.user_id)) grouped.set(p.user_id, []);
    grouped.get(p.user_id).push(p);
  }
  if (onlyUser && !grouped.has(onlyUser)) grouped.set(onlyUser, []);
  const summary = [],
    awards = [];
  const priorStats = await tx.q(
    `SELECT user_id,winning_streak FROM daily_prediction_stats${onlyUser ? " WHERE user_id=?" : ""}`,
    onlyUser ? [onlyUser] : [],
  );
  const previousStreaks = new Map(
    priorStats.map((s) => [s.user_id, s.winning_streak]),
  );
  const previousAwards = await tx.q(
    `SELECT user_id,code,active FROM daily_prediction_achievements${onlyUser ? " WHERE user_id=?" : ""}`,
    onlyUser ? [onlyUser] : [],
  );
  const previous = new Map(
    previousAwards.map((a) => [`${a.user_id}:${a.code}`, a.active]),
  );
  const notices = [];
  for (const [userId, rows] of grouped) {
    const s = calculateStats(
      challenges,
      rows,
      challengeDay(new Date(), dailyTimezone),
    );
    summary.push([
      userId,
      s.winningStreak,
      s.participationStreak,
      JSON.stringify(s),
    ]);
    for (const [code, title, , qualifies] of ACHIEVEMENTS) {
      const active = Number(qualifies(s));
      if (active || previous.has(`${userId}:${code}`))
        awards.push([userId, code, active]);
      if (active && !previous.get(`${userId}:${code}`))
        notices.push({
          userId,
          key: `achievement:${code}`,
          title: "Achievement unlocked",
          message: title,
        });
    }
    if (s.winningStreak > (previousStreaks.get(userId) || 0))
      notices.push({
        userId,
        key: `streak:${s.lastResolvedDate}:${s.winningStreak}`,
        title: "Your winning streak increased",
        message: `You reached ${s.winningStreak} consecutive successful days.`,
      });
  }
  for (let i = 0; i < summary.length; i += 250)
    await tx.q(
      `INSERT INTO daily_prediction_stats(user_id,winning_streak,participation_streak,details) VALUES ? ON DUPLICATE KEY UPDATE winning_streak=VALUES(winning_streak),participation_streak=VALUES(participation_streak),details=VALUES(details),updated_at=UTC_TIMESTAMP(3)`,
      [summary.slice(i, i + 250)],
    );
  for (let i = 0; i < awards.length; i += 500)
    await tx.q(
      `INSERT INTO daily_prediction_achievements(user_id,code,active) VALUES ? ON DUPLICATE KEY UPDATE active=VALUES(active)`,
      [awards.slice(i, i + 500)],
    );
  const optedIn = new Set(
    (
      await tx.q(
        "SELECT user_id FROM daily_prediction_preferences WHERE reminders=1",
      )
    ).map((p) => p.user_id),
  );
  for (const n of notices)
    if (optedIn.has(n.userId))
      await notice(tx, n.userId, n.key, n.title, n.message);
}
export async function publishDailyChallenge(
  actorId,
  { fixtureId, referenceTeamId, slot = 1, challengeId = null },
) {
  if (
    !Number.isSafeInteger(fixtureId) ||
    !Number.isSafeInteger(referenceTeamId) ||
    !Number.isSafeInteger(slot) ||
    slot < 1 ||
    slot > dailySlots
  )
    throw badRequest(
      "INVALID_CHALLENGE",
      "Choose a fixture, reference team and configured slot.",
    );
  return withTransaction(async (tx) => {
    await tx.one("SELECT id FROM daily_prediction_state WHERE id=1 FOR UPDATE");
    const existing = challengeId
      ? await tx.one(
          "SELECT * FROM daily_prediction_challenges WHERE id=? FOR UPDATE",
          [challengeId],
        )
      : null;
    if (challengeId && !existing) throw notFound();
    if (
      existing &&
      (existing.status !== "OPEN" ||
        (await tx.one(
          "SELECT id FROM daily_predictions WHERE challenge_id=? LIMIT 1",
          [challengeId],
        )))
    )
      throw conflict(
        "CHALLENGE_IMMUTABLE",
        "A challenge with predictions or a locked challenge cannot be changed.",
      );
    const f = await tx.one(
      `SELECT f.*,c.is_enabled FROM football_fixtures f JOIN football_competitions c ON c.id=f.competition_id WHERE f.id=? FOR UPDATE`,
      [fixtureId],
    );
    const { now } = await tx.one("SELECT UTC_TIMESTAMP(3) now");
    if (
      !f ||
      f.is_simulated ||
      f.provider === "mock" ||
      !f.is_enabled ||
      f.status !== "SCHEDULED" ||
      new Date(f.kickoff_at) <= now ||
      !f.last_synced_at ||
      new Date(now) - new Date(f.last_synced_at) > 6 * 3600000
    )
      throw badRequest(
        "INVALID_FIXTURE",
        "Select a real upcoming fixture with recent provider coverage.",
      );
    if (![f.home_team_id, f.away_team_id].includes(referenceTeamId))
      throw badRequest(
        "INVALID_REFERENCE",
        "The reference team must play in this fixture.",
      );
    const day = challengeDay(new Date(f.kickoff_at), dailyTimezone);
    const values = [
      day,
      slot,
      dailyTimezone,
      fixtureId,
      referenceTeamId,
      f.home_team_id,
      f.away_team_id,
      f.kickoff_at,
    ];
    let id = challengeId;
    try {
      if (existing)
        await tx.q(
          "UPDATE daily_prediction_challenges SET challenge_date=?,slot=?,timezone=?,fixture_id=?,reference_team_id=?,home_team_id=?,away_team_id=?,cutoff_at=? WHERE id=?",
          [...values, id],
        );
      else
        id = (
          await tx.q(
            "INSERT INTO daily_prediction_challenges(challenge_date,slot,timezone,fixture_id,reference_team_id,home_team_id,away_team_id,cutoff_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)",
            [...values, actorId],
          )
        ).insertId;
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY")
        throw conflict(
          "DUPLICATE_CHALLENGE",
          "This date and slot or fixture already has a daily challenge.",
        );
      throw e;
    }
    await tx.q(
      "INSERT INTO daily_prediction_audit(challenge_id,revision,actor_id,evidence) VALUES (?,?,?,?)",
      [
        id,
        existing ? existing.revision + 1 : 1,
        actorId,
        JSON.stringify({
          action: existing ? "override" : "publish",
          fixtureId,
          referenceTeamId,
          day,
          slot,
        }),
      ],
    );
    await tx.q(
      "UPDATE daily_prediction_challenges SET revision=revision+1 WHERE id=?",
      [id],
    );
    return { id, challengeDate: day };
  });
}
export async function submitDailyPrediction(userId, challengeId, pick) {
  if (!OUTCOMES.includes(pick))
    throw badRequest("INVALID_OUTCOME", "Choose Win, Draw or Loss.");
  return withTransaction(async (tx) => {
    await tx.one("SELECT id FROM daily_prediction_state WHERE id=1 FOR UPDATE");
    const c = await tx.one(
      "SELECT * FROM daily_prediction_challenges WHERE id=? FOR UPDATE",
      [challengeId],
    );
    if (!c) throw notFound("Daily challenge not found.");
    const f = await tx.one(
      "SELECT * FROM football_fixtures WHERE id=? FOR UPDATE",
      [c.fixture_id],
    );
    const user = await tx.one("SELECT status,is_bot FROM users WHERE id=?", [
      userId,
    ]);
    if (!user || user.is_bot || user.status !== "ACTIVE") throw forbidden();
    const { now } = await tx.one("SELECT UTC_TIMESTAMP(3) now");
    if (
      c.status !== "OPEN" ||
      c.locked_at ||
      f.status !== "SCHEDULED" ||
      f.is_simulated ||
      f.provider === "mock" ||
      new Date(c.cutoff_at) <= now ||
      new Date(f.kickoff_at) <= now ||
      f.home_team_id !== c.home_team_id ||
      f.away_team_id !== c.away_team_id
    )
      throw conflict(
        "PREDICTIONS_LOCKED",
        "Predictions are locked for this match.",
      );
    // Keep the originally published cutoff if a provider later postpones kickoff.
    const result = await tx.q(
      `INSERT INTO daily_predictions(user_id,challenge_id,pick) SELECT ?,?,? FROM daily_prediction_challenges c JOIN football_fixtures f ON f.id=c.fixture_id WHERE c.id=? AND c.cutoff_at>UTC_TIMESTAMP(3) AND f.kickoff_at>UTC_TIMESTAMP(3) ON DUPLICATE KEY UPDATE pick=VALUES(pick),updated_at=UTC_TIMESTAMP(3)`,
      [userId, challengeId, pick, challengeId],
    );
    if (!result.affectedRows)
      throw conflict(
        "PREDICTIONS_LOCKED",
        "The prediction deadline has passed.",
      );
    await rebuildStats(tx, userId);
    return { saved: true, pick, serverNow: now };
  });
}
export async function settleDailyChallenge(
  id,
  {
    actorId = null,
    reason = null,
    reconcile = false,
    voidChallenge = false,
  } = {},
) {
  return withTransaction(async (tx) => {
    await tx.one("SELECT id FROM daily_prediction_state WHERE id=1 FOR UPDATE");
    const c = await tx.one(
      "SELECT * FROM daily_prediction_challenges WHERE id=? FOR UPDATE",
      [id],
    );
    if (!c) throw notFound();
    const f = await tx.one(
      "SELECT * FROM football_fixtures WHERE id=? FOR UPDATE",
      [c.fixture_id],
    );
    const { now } = await tx.one("SELECT UTC_TIMESTAMP(3) now");
    if (
      voidChallenge &&
      (!actorId || typeof reason !== "string" || reason.trim().length < 10)
    )
      throw badRequest(
        "REASON_REQUIRED",
        "An administrator must explain why this challenge is permanently void.",
      );
    let result = voidChallenge
      ? { outcome: "VOID", reason }
      : verifiedOutcome(f, c, now);
    if (c.actual_result && !reconcile && !voidChallenge)
      return { changed: false };
    if (reconcile && (typeof reason !== "string" || reason.trim().length < 10))
      throw badRequest(
        "REASON_REQUIRED",
        "Provide a reconciliation reason of at least 10 characters.",
      );
    if (!result) return { changed: false, awaitingVerification: true };
    // A corrected kickoff can reveal that cached schedule data admitted a late
    // selection. Fail closed rather than score a potentially informed pick.
    if (
      OUTCOMES.includes(result.outcome) &&
      (await tx.one(
        "SELECT id FROM daily_predictions WHERE challenge_id=? AND updated_at>=LEAST(?,?) LIMIT 1",
        [id, c.cutoff_at, f.kickoff_at],
      ))
    )
      result = {
        outcome: "VOID",
        reason:
          "Corrected kickoff invalidated prediction timing; challenge voided to protect participants.",
      };

    if (
      c.actual_result === result.outcome &&
      c.result_home_score === f.home_score &&
      c.result_away_score === f.away_score
    )
      return { changed: false };
    const revision = c.revision + 1;
    await tx.q(
      `UPDATE daily_prediction_challenges SET status=?,actual_result=?,result_home_score=?,result_away_score=?,reason=?,revision=?,settled_at=UTC_TIMESTAMP(3),locked_at=COALESCE(locked_at,UTC_TIMESTAMP(3)) WHERE id=?`,
      [
        result.outcome === "VOID" ? "VOID" : "RESOLVED",
        result.outcome,
        f.home_score,
        f.away_score,
        reason || result.reason,
        revision,
        id,
      ],
    );
    await tx.q(
      "INSERT INTO daily_prediction_audit(challenge_id,revision,actor_id,evidence) VALUES (?,?,?,?)",
      [
        id,
        revision,
        actorId,
        JSON.stringify({
          action: voidChallenge
            ? "admin-void"
            : reconcile
              ? "reconcile"
              : "settle",
          previous: c.actual_result,
          result: result.outcome,
          provider: f.provider,
          providerFixtureId: f.provider_fixture_id,
          lastSyncedAt: f.last_synced_at,
          scores: [f.home_score, f.away_score],
          duration: f.score_duration,
          reason: reason || result.reason,
        }),
      ],
    );
    await rebuildStats(tx);
    const participants = await tx.q(
      "SELECT p.user_id,p.pick FROM daily_predictions p JOIN daily_prediction_preferences pref ON pref.user_id=p.user_id AND pref.reminders=1 WHERE p.challenge_id=?",
      [id],
    );
    for (const p of participants)
      await notice(
        tx,
        p.user_id,
        `result:${id}:${revision}`,
        "Your prediction result is ready",
        result.outcome === "VOID"
          ? result.reason
          : `Your prediction was ${p.pick === result.outcome ? "correct" : "incorrect"}. View your streak and achievements.`,
      );
    return { changed: true, result: result.outcome };
  });
}
export async function sweepDailyPredictions() {
  const conn = await pool.getConnection();
  let acquired = false;
  try {
    const [[lock]] = await conn.query(
      "SELECT GET_LOCK('h2h-daily-predictions',0) acquired",
    );
    acquired = !!lock.acquired;
    if (!acquired) return;
    await query(
      `UPDATE daily_prediction_challenges c JOIN football_fixtures f ON f.id=c.fixture_id SET c.status='LOCKED',c.locked_at=COALESCE(c.locked_at,UTC_TIMESTAMP(3)) WHERE c.status='OPEN' AND (c.cutoff_at<=UTC_TIMESTAMP(3) OR f.kickoff_at<=UTC_TIMESTAMP(3) OR f.status<>'SCHEDULED')`,
    );
    // Advance pre-submitted participation only when its original day arrives.
    await withTransaction(async (tx) => {
      const state = await tx.one(
        "SELECT DATE_FORMAT(last_rollup_date,'%Y-%m-%d') lastDay FROM daily_prediction_state WHERE id=1 FOR UPDATE",
      );
      const today = challengeDay(new Date(), dailyTimezone);
      if (state.lastDay !== today) {
        await rebuildStats(tx);
        await tx.q(
          "UPDATE daily_prediction_state SET last_rollup_date=? WHERE id=1",
          [today],
        );
      }
    });
    const pending = await query(
      "SELECT id FROM daily_prediction_challenges WHERE actual_result IS NULL ORDER BY challenge_date,slot",
    );
    for (const c of pending) await settleDailyChallenge(c.id);
    const fixtures = await query(
      `SELECT f.* FROM football_fixtures f JOIN football_competitions c ON c.id=f.competition_id WHERE c.is_enabled=1 AND f.is_simulated=0 AND f.provider<>'mock' AND f.status='SCHEDULED' AND f.kickoff_at>DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 MINUTE) AND f.kickoff_at<DATE_ADD(UTC_TIMESTAMP(),INTERVAL 2 DAY) AND f.last_synced_at>DATE_SUB(UTC_TIMESTAMP(),INTERVAL 6 HOUR) ORDER BY c.sort_order,f.kickoff_at,f.id`,
    );
    const used = await query(
      `SELECT ${dateSql} day,slot FROM daily_prediction_challenges c WHERE c.challenge_date>=?`,
      [challengeDay(new Date(), dailyTimezone)],
    );
    const occupied = new Set(used.map((c) => `${c.day}:${c.slot}`));
    const existingFixtures = new Set(
      (await query("SELECT fixture_id FROM daily_prediction_challenges")).map(
        (c) => c.fixture_id,
      ),
    );
    for (const f of fixtures) {
      if (existingFixtures.has(f.id)) continue;
      const day = challengeDay(new Date(f.kickoff_at), dailyTimezone);
      for (let slot = 1; slot <= dailySlots; slot++)
        if (!occupied.has(`${day}:${slot}`)) {
          await publishDailyChallenge(null, {
            fixtureId: f.id,
            referenceTeamId: f.home_team_id,
            slot,
          });
          occupied.add(`${day}:${slot}`);
          break;
        }
    }
    const reminders = await query(
      `SELECT pref.user_id,c.id,c.cutoff_at,p.id prediction_id FROM daily_prediction_preferences pref JOIN daily_prediction_challenges c ON c.challenge_date=? AND c.status='OPEN' LEFT JOIN daily_predictions p ON p.user_id=pref.user_id AND p.challenge_id=c.id WHERE pref.reminders=1`,
      [challengeDay(new Date(), dailyTimezone)],
    );
    for (const r of reminders)
      if (!r.prediction_id)
        await withTransaction(async (tx) => {
          await notice(
            tx,
            r.user_id,
            `available:${r.id}`,
            "Daily Predictions is ready",
            "Choose Win, Draw or Loss before kickoff.",
          );
          if (new Date(r.cutoff_at) - Date.now() < 3600000)
            await notice(
              tx,
              r.user_id,
              `deadline:${r.id}`,
              "Prediction deadline approaching",
              "Less than one hour remains. Submit your daily prediction.",
            );
        });
  } finally {
    if (acquired)
      await conn
        .query("SELECT RELEASE_LOCK('h2h-daily-predictions')")
        .catch(() => {});
    conn.release();
  }
}
export async function dailyOverview(userId = null) {
  const today = challengeDay(new Date(), dailyTimezone);
  const challenges = await query(
    `SELECT c.*,${dateSql} challengeDate,h.name homeTeam,a.name awayTeam,r.name referenceTeam,f.status fixtureStatus,f.last_synced_at lastSyncedAt,f.kickoff_at kickoffAt,LEAST(c.cutoff_at,f.kickoff_at) cutoffAt,p.pick,p.submitted_at submittedAt,UTC_TIMESTAMP(3) serverNow ${joined} LEFT JOIN daily_predictions p ON p.challenge_id=c.id AND p.user_id=? WHERE c.challenge_date=? ORDER BY c.slot`,
    [userId, today],
  );
  for (const c of challenges) {
    c.fixtureId = c.fixture_id;
    c.canSubmit =
      c.status === "OPEN" &&
      c.fixtureStatus === "SCHEDULED" &&
      new Date(c.cutoffAt) > new Date(c.serverNow);
    c.providerUnavailable =
      !c.lastSyncedAt || Date.now() - new Date(c.lastSyncedAt) > 6 * 3600000;
    if (c.pick) {
      const counts = await query(
        "SELECT pick,COUNT(*) n FROM daily_predictions WHERE challenge_id=? GROUP BY pick",
        [c.id],
      );
      const total = counts.reduce((s, r) => s + Number(r.n), 0);
      c.community = {
        total,
        selections: OUTCOMES.map((pick) => ({
          pick,
          count: Number(counts.find((r) => r.pick === pick)?.n || 0),
          percentage: total
            ? Math.round(
                (Number(counts.find((r) => r.pick === pick)?.n || 0) / total) *
                  1000,
              ) / 10
            : null,
        })),
      };
    }
  }
  const row = userId
    ? await queryOne(
        "SELECT details FROM daily_prediction_stats WHERE user_id=?",
        [userId],
      )
    : null;
  const stats = row
    ? typeof row.details === "string"
      ? JSON.parse(row.details)
      : row.details
    : calculateStats([], []);
  const awards = userId
    ? await query(
        "SELECT code,awarded_at FROM daily_prediction_achievements WHERE user_id=? AND active=1",
        [userId],
      )
    : [];
  const achievements = awards.map((a) => {
    const [, title, description] = ACHIEVEMENTS.find((r) => r[0] === a.code);
    return { ...a, title, description };
  });
  const pref = userId
    ? await queryOne(
        "SELECT reminders FROM daily_prediction_preferences WHERE user_id=?",
        [userId],
      )
    : null;
  const weekly = userId
    ? await dailyLeaderboard("weekly", userId, { page: 1, pageSize: 5 })
    : null;
  return {
    today,
    timezone: dailyTimezone,
    challenges,
    stats,
    achievements,
    reminders: !!pref?.reminders,
    weeklyRank: weekly?.mine?.rank ?? null,
    serverNow: new Date().toISOString(),
  };
}
export async function dailyHistory(
  userId,
  { filter = "all", page = 1, pageSize = 20 } = {},
) {
  const filters = {
    all: "1=1",
    correct: "c.actual_result=p.pick",
    incorrect:
      "c.actual_result IN ('WIN','DRAW','LOSS') AND c.actual_result<>p.pick",
    pending: "c.actual_result IS NULL",
    void: "c.actual_result='VOID'",
  };
  if (!filters[filter])
    throw badRequest("INVALID_FILTER", "Invalid history filter.");
  const where = `p.user_id=? AND ${filters[filter]}`;
  const from = `${joined} JOIN daily_predictions p ON p.challenge_id=c.id`;
  const count = await queryOne(`SELECT COUNT(*) total ${from} WHERE ${where}`, [
    userId,
  ]);
  const rows = await query(
    `SELECT c.id,c.slot,${dateSql} challengeDate,c.actual_result actualResult,c.result_home_score homeScore,c.result_away_score awayScore,c.reason,h.name homeTeam,a.name awayTeam,r.name referenceTeam,p.pick,p.submitted_at submittedAt,c.status,IF(c.actual_result=p.pick,1,0) points ${from} WHERE ${where} ORDER BY c.challenge_date DESC,c.slot DESC LIMIT ? OFFSET ?`,
    [userId, pageSize, (page - 1) * pageSize],
  );
  return {
    predictions: rows,
    total: Number(count.total),
    page,
    pageSize,
    hasMore: page * pageSize < count.total,
  };
}
export async function dailyLeaderboard(
  period,
  userId = null,
  { page = 1, pageSize = 20 } = {},
) {
  let bounds;
  try {
    bounds = periodBounds(period, challengeDay(new Date(), dailyTimezone));
  } catch {
    throw badRequest("INVALID_PERIOD", "Choose daily, weekly, monthly or all.");
  }
  // Accuracy breaks ties only after five eligible predictions. DENSE_RANK shares exact ties.
  const cte = `WITH scores AS (SELECT u.id userId,u.username,COUNT(*) eligible,SUM(p.pick=c.actual_result) points,ROUND(SUM(p.pick=c.actual_result)/COUNT(*)*100,1) accuracy,IF(COUNT(*)>=5,SUM(p.pick=c.actual_result)/COUNT(*),0) tieAccuracy,COALESCE(s.winning_streak,0) winningStreak,COALESCE(s.participation_streak,0) participationStreak FROM daily_predictions p JOIN daily_prediction_challenges c ON c.id=p.challenge_id JOIN users u ON u.id=p.user_id LEFT JOIN daily_prediction_stats s ON s.user_id=u.id WHERE c.actual_result IN ('WIN','DRAW','LOSS') AND c.challenge_date BETWEEN ? AND ? AND u.is_bot=0 AND u.status='ACTIVE' GROUP BY u.id,u.username,s.winning_streak,s.participation_streak),ranked AS (SELECT *,DENSE_RANK() OVER(ORDER BY points DESC,tieAccuracy DESC) AS \`rank\` FROM scores)`;
  const rankings = await query(
    `${cte} SELECT *,points correct FROM ranked ORDER BY \`rank\`,username,userId LIMIT ? OFFSET ?`,
    [...bounds, pageSize, (page - 1) * pageSize],
  );
  const mine = userId
    ? await queryOne(
        `${cte} SELECT *,points correct FROM ranked WHERE userId=?`,
        [...bounds, userId],
      )
    : null;
  const total = await queryOne(
    `${cte} SELECT COUNT(*) total FROM ranked`,
    bounds,
  );
  return {
    period,
    rankings,
    mine,
    total: Number(total.total),
    page,
    pageSize,
    hasMore: page * pageSize < total.total,
    tiePolicy:
      "Points, then accuracy after 5 eligible predictions; equal scores share rank. Streaks shown are all-time current streaks.",
  };
}
export async function setDailyReminders(userId, enabled) {
  if (typeof enabled !== "boolean")
    throw badRequest("INVALID_PREFERENCE", "Reminders must be true or false.");
  await query(
    "INSERT INTO daily_prediction_preferences(user_id,reminders) VALUES (?,?) ON DUPLICATE KEY UPDATE reminders=VALUES(reminders)",
    [userId, Number(enabled)],
  );
  return { reminders: enabled };
}
export async function dailyAdminFixtures() {
  return query(
    `SELECT f.id,f.home_team_id homeTeamId,f.away_team_id awayTeamId,h.name homeTeam,a.name awayTeam,f.kickoff_at kickoffAt FROM football_fixtures f JOIN football_teams h ON h.id=f.home_team_id JOIN football_teams a ON a.id=f.away_team_id JOIN football_competitions c ON c.id=f.competition_id WHERE f.is_simulated=0 AND f.provider<>'mock' AND c.is_enabled=1 AND f.status='SCHEDULED' AND f.kickoff_at>UTC_TIMESTAMP() AND f.last_synced_at>DATE_SUB(UTC_TIMESTAMP(),INTERVAL 6 HOUR) ORDER BY f.kickoff_at LIMIT 100`,
  );
}
export async function dailyAdminChallenges() {
  return query(
    `SELECT c.*,${dateSql} challengeDate,h.name homeTeam,a.name awayTeam,r.name referenceTeam,(SELECT COUNT(*) FROM daily_predictions p WHERE p.challenge_id=c.id) participants ${joined} ORDER BY c.challenge_date DESC,c.slot LIMIT 100`,
  );
}
