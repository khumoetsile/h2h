import { query, queryOne, withTransaction } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";
import { percentages } from "./footballPredictionModel.js";
export const PREDICTION_RANKING_MINIMUM = 20;
const resultSql = `CASE WHEN f.is_simulated=1 OR f.status IN ('CANCELLED','ABANDONED') THEN 'VOID' WHEN f.status='FINISHED' AND f.kickoff_at>UTC_TIMESTAMP() THEN NULL WHEN f.status='FINISHED' AND f.research_eligible=1 AND f.score_duration='REGULAR' AND f.home_score IS NOT NULL AND f.away_score IS NOT NULL THEN CASE WHEN f.home_score>f.away_score THEN 'HOME' WHEN f.home_score=f.away_score THEN 'DRAW' ELSE 'AWAY' END WHEN f.status='FINISHED' THEN 'VOID' ELSE NULL END`;
export async function reconcilePredictionResults() {
  // Free results never call the wallet, PvP settlement, notification or fee services.
  for (const table of [
    "football_community_predictions",
    "football_model_predictions",
  ]) {
    const valid =
      table === "football_community_predictions"
        ? `p.updated_at<f.kickoff_at AND p.home_team_id=f.home_team_id AND p.away_team_id=f.away_team_id`
        : `p.predicted_at<f.kickoff_at AND p.home_team_id=f.home_team_id AND p.away_team_id=f.away_team_id AND p.kickoff_at=f.kickoff_at`;
    const outcome = `CASE WHEN NOT(${valid}) AND f.status IN ('FINISHED','LIVE') THEN 'VOID' ELSE ${resultSql} END`;
    await query(
      `UPDATE ${table} p JOIN football_fixtures f ON f.id=p.fixture_id SET p.actual_result=${outcome},p.settled_at=IF(${outcome} IS NULL,NULL,UTC_TIMESTAMP()) WHERE NOT(p.actual_result<=>${outcome})`,
    );
  }
}
export async function saveFreePrediction(userId, fixtureId, pick) {
  if (!["HOME", "DRAW", "AWAY"].includes(pick))
    throw badRequest("INVALID_PICK", "Choose a team win or draw.");
  return withTransaction(async (tx) => {
    const user = await tx.one("SELECT id,is_bot,status FROM users WHERE id=?", [
      userId,
    ]);
    if (!user || user.status !== "ACTIVE" || user.is_bot)
      throw forbidden("Free picks are for active human accounts.");
    const f = await tx.one(
      "SELECT f.* FROM football_fixtures f JOIN football_competitions c ON c.id=f.competition_id WHERE f.id=? AND c.is_enabled=1 FOR UPDATE",
      [fixtureId],
    );
    if (!f) throw notFound("Fixture not found.");
    const { server_now } = await tx.one(
      "SELECT UTC_TIMESTAMP(3) AS server_now",
    );
    if (f.is_simulated || f.provider === "mock")
      throw badRequest(
        "REAL_FIXTURE_REQUIRED",
        "Choose a real upcoming fixture.",
      );
    if (
      f.status !== "SCHEDULED" ||
      new Date(f.kickoff_at) <= new Date(server_now)
    )
      throw conflict(
        "PREDICTIONS_CLOSED",
        "Picks close when the match starts.",
      );
    const written = await tx.q(
      `INSERT INTO football_community_predictions(user_id,fixture_id,pick,home_team_id,away_team_id) SELECT ?,f.id,?,f.home_team_id,f.away_team_id FROM football_fixtures f WHERE f.id=? AND f.kickoff_at>UTC_TIMESTAMP(3) AND f.status='SCHEDULED' ON DUPLICATE KEY UPDATE pick=VALUES(pick),home_team_id=VALUES(home_team_id),away_team_id=VALUES(away_team_id),updated_at=UTC_TIMESTAMP()`,
      [userId, pick, fixtureId],
    );
    if (
      !written.affectedRows &&
      !(
        await tx.one(
          "SELECT kickoff_at>UTC_TIMESTAMP(3) AS still_open FROM football_fixtures WHERE id=?",
          [fixtureId],
        )
      ).still_open
    )
      throw conflict(
        "PREDICTIONS_CLOSED",
        "Picks close when the match starts.",
      );
    return { pick, saved: true, serverNow: server_now };
  });
}
export async function communityPicks(fixtureId, userId) {
  const rows = await query(
    `SELECT p.pick,COUNT(*) AS n FROM football_community_predictions p JOIN users u ON u.id=p.user_id JOIN football_fixtures f ON f.id=p.fixture_id WHERE p.fixture_id=? AND u.is_bot=0 AND p.home_team_id=f.home_team_id AND p.away_team_id=f.away_team_id GROUP BY p.pick`,
    [fixtureId],
  );
  const counts = { HOME: 0, DRAW: 0, AWAY: 0 };
  for (const r of rows) counts[r.pick] = Number(r.n);
  const mine = userId
    ? await queryOne(
        "SELECT p.pick,p.updated_at AS submittedAt FROM football_community_predictions p JOIN football_fixtures f ON f.id=p.fixture_id WHERE p.fixture_id=? AND p.user_id=? AND p.home_team_id=f.home_team_id AND p.away_team_id=f.away_team_id",
        [fixtureId, userId],
      )
    : null;
  return {
    counts,
    total: Object.values(counts).reduce((s, n) => s + n, 0),
    percentages: percentages(counts),
    mine,
    notice:
      "Community picks are opinions, not calibrated probabilities. Free, with no stake.",
  };
}
const joined = `FROM football_community_predictions p JOIN football_fixtures f ON f.id=p.fixture_id JOIN football_teams h ON h.id=f.home_team_id JOIN football_teams a ON a.id=f.away_team_id`;
export async function freePredictionHistory(
  userId,
  { page = 1, pageSize = 20 } = {},
) {
  await reconcilePredictionResults();
  const summary = await queryOne(
    `SELECT COUNT(*) AS total,SUM(actual_result IN ('HOME','DRAW','AWAY')) AS settled,SUM(actual_result=pick AND actual_result IN ('HOME','DRAW','AWAY')) AS correct FROM football_community_predictions WHERE user_id=?`,
    [userId],
  );
  const rows = await query(
    `SELECT p.*,f.status,f.home_score,f.away_score,f.kickoff_at,h.name AS home_name,a.name AS away_name ${joined} WHERE p.user_id=? ORDER BY p.updated_at DESC,p.id DESC LIMIT ? OFFSET ?`,
    [userId, pageSize, (page - 1) * pageSize],
  );
  const settled = Number(summary.settled || 0),
    correct = Number(summary.correct || 0);
  return {
    summary: {
      total: Number(summary.total),
      settled,
      correct,
      accuracy: settled ? Math.round((correct / settled) * 1000) / 10 : null,
    },
    page,
    pageSize,
    hasMore: page * pageSize < summary.total,
    predictions: rows.map((r) => ({
      id: r.id,
      fixtureId: r.fixture_id,
      homeTeam: r.home_name,
      awayTeam: r.away_name,
      kickoffAt: r.kickoff_at,
      pick: r.pick,
      actualResult: r.actual_result,
      correct:
        r.actual_result && r.actual_result !== "VOID"
          ? r.pick === r.actual_result
          : null,
      homeScore: r.home_score,
      awayScore: r.away_score,
      status: r.status,
      submittedAt: r.submitted_at,
      updatedAt: r.updated_at,
      settledAt: r.settled_at,
    })),
  };
}
export function rankingScore(correct, total) {
  if (!total) return 0;
  const z = 1.96,
    p = correct / total;
  return (
    (p +
      (z * z) / (2 * total) -
      z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) /
    (1 + (z * z) / total)
  );
}
export async function freePredictionRankings() {
  const rows = await query(
    `SELECT u.username,COUNT(*) AS settled,SUM(p.pick=p.actual_result) AS correct FROM football_community_predictions p JOIN users u ON u.id=p.user_id WHERE p.actual_result IN ('HOME','DRAW','AWAY') AND u.is_bot=0 AND u.status='ACTIVE' GROUP BY u.id,u.username HAVING COUNT(*)>=?`,
    [PREDICTION_RANKING_MINIMUM],
  );
  const ranked = rows
    .map((r) => ({
      username: r.username,
      settled: Number(r.settled),
      correct: Number(r.correct),
      accuracy: Math.round((Number(r.correct) / Number(r.settled)) * 1000) / 10,
      score: rankingScore(Number(r.correct), Number(r.settled)),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.accuracy - a.accuracy ||
        a.username.localeCompare(b.username),
    );
  return {
    minimum: PREDICTION_RANKING_MINIMUM,
    method:
      "Ranked by the 95% Wilson lower bound of accuracy, not prediction volume or wallet balance.",
    rankings: ranked
      .slice(0, 100)
      .map(({ score, ...r }, i) => ({ rank: i + 1, ...r })),
  };
}
