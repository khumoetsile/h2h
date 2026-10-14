import { query, queryOne, withTransaction } from "../db.js";
import { notFound } from "../utils/errors.js";
import {
  MODEL_VERSION,
  MODEL_LEAGUES,
  prepareModelMatches,
  fitGoalModel,
  predictGoals,
  chronologicalBacktest,
  evaluateProbabilities,
  percentages,
} from "./footballPredictionModel.js";
import { createHash } from "node:crypto";
const json = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const date = (v) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const fitCache = new Map();
export async function loadModelMatches(code) {
  const joins =
    "JOIN football_competitions c ON c.id=m.competition_id JOIN football_teams h ON h.id=m.home_team_id JOIN football_teams a ON a.id=m.away_team_id";
  const fields =
    "m.id,m.home_team_id,m.away_team_id,m.home_score,m.away_score,c.code,h.name AS home_name,a.name AS away_name";
  const [archive, synced] = await Promise.all([
    query(
      `SELECT ${fields},m.match_date AS played FROM football_history_matches m ${joins} WHERE c.code=? AND c.is_enabled=1 AND m.status='FINISHED' AND m.match_date<UTC_DATE() ORDER BY m.match_date DESC LIMIT 10000`,
      [code],
    ),
    query(
      `SELECT ${fields},m.kickoff_at AS played FROM football_fixtures m ${joins} WHERE c.code=? AND c.is_enabled=1 AND m.is_simulated=0 AND m.provider<>'mock' AND m.status='FINISHED' AND m.research_eligible=1 AND m.score_duration='REGULAR' AND m.kickoff_at<UTC_DATE() ORDER BY m.kickoff_at DESC LIMIT 10000`,
      [code],
    ),
  ]);
  const map = (r, source) => ({
    id: source + "-" + r.id,
    code: r.code,
    date: date(r.played),
    homeTeamId: r.home_team_id,
    awayTeamId: r.away_team_id,
    homeName: r.home_name,
    awayName: r.away_name,
    homeScore: r.home_score,
    awayScore: r.away_score,
  });
  return prepareModelMatches([
    ...archive.map((r) => map(r, "H")),
    ...synced.map((r) => map(r, "F")),
  ]);
}
export async function trainCompetitionModel(
  code,
  { cutoffDate = new Date().toISOString().slice(0, 10) } = {},
) {
  if (!MODEL_LEAGUES.includes(code))
    throw new Error("Unsupported prediction competition.");
  if (cutoffDate > new Date().toISOString().slice(0, 10))
    throw new Error("A model cutoff cannot be in the future.");
  const rows = (await loadModelMatches(code)).filter(
    (m) => m.date < cutoffDate,
  );
  const evaluation = chronologicalBacktest(rows);
  const fit = fitGoalModel(rows, cutoffDate);
  const hash =
    fit.dataHash ||
    createHash("sha256")
      .update(JSON.stringify([MODEL_VERSION, cutoffDate, rows]))
      .digest("hex");
  await query(
    `INSERT IGNORE INTO football_prediction_model_runs(competition_code,model_version,data_hash,data_cutoff,fit,evaluation) VALUES(?,?,?,?,?,?)`,
    [
      code,
      MODEL_VERSION,
      hash,
      cutoffDate + " 00:00:00",
      JSON.stringify(fit),
      JSON.stringify(evaluation),
    ],
  );
  fitCache.delete(code);
  return {
    code,
    fitStatus: fit.status,
    validated: evaluation.validated,
    evaluation,
  };
}
export async function predictionFixture(id) {
  const row = await queryOne(
    `SELECT f.*,c.code,c.name AS competition_name,h.name AS home_name,h.short_name AS home_short,h.crest_url AS home_crest,a.name AS away_name,a.short_name AS away_short,a.crest_url AS away_crest FROM football_fixtures f JOIN football_competitions c ON c.id=f.competition_id JOIN football_teams h ON h.id=f.home_team_id JOIN football_teams a ON a.id=f.away_team_id WHERE f.id=? AND c.is_enabled=1`,
    [id],
  );
  if (!row) throw notFound("This football fixture is not available.");
  return row;
}
const unavailable = (reason) => ({
  status: "UNAVAILABLE",
  reason,
  version: MODEL_VERSION,
  methodologyUrl: "/football/predictions/methodology",
});
async function latestRun(code) {
  const cached = fitCache.get(code);
  if (cached?.until > Date.now()) return cached.row;
  const row = await queryOne(
    "SELECT * FROM football_prediction_model_runs WHERE competition_code=? AND model_version=? AND data_cutoff<=UTC_TIMESTAMP() ORDER BY data_cutoff DESC,created_at DESC,id DESC LIMIT 1",
    [code, MODEL_VERSION],
  );
  if (row) {
    row.fit = json(row.fit);
    row.evaluation = json(row.evaluation);
    fitCache.set(code, { row, until: Date.now() + 60000 });
  }
  return row;
}
function snapshotView(row) {
  const details = json(row.details),
    p = {
      HOME: Number(row.home_probability),
      DRAW: Number(row.draw_probability),
      AWAY: Number(row.away_probability),
    };
  return {
    status: "READY",
    snapshotId: row.id,
    version: row.model_version,
    calculatedAt: row.predicted_at,
    dataCutoff: row.data_cutoff,
    probabilities: p,
    percentages: percentages(p),
    ...details,
    actualResult: row.actual_result,
    methodologyUrl: "/football/predictions/methodology",
  };
}
export async function modelPredictionForFixture(id) {
  const f = await predictionFixture(id);
  if (f.is_simulated || f.provider === "mock")
    return unavailable(
      "Statistical estimates require real fixtures and verified history.",
    );
  const existing = await queryOne(
    `SELECT * FROM football_model_predictions WHERE fixture_id=? AND predicted_at<? AND kickoff_at=? AND home_team_id=? AND away_team_id=? ORDER BY predicted_at DESC,id DESC LIMIT 1`,
    [id, f.kickoff_at, f.kickoff_at, f.home_team_id, f.away_team_id],
  );
  const open = f.status === "SCHEDULED" && new Date(f.kickoff_at) > new Date();
  if (!open)
    return existing
      ? snapshotView(existing)
      : unavailable("No pre-match model estimate was recorded.");
  if (!MODEL_LEAGUES.includes(f.code))
    return unavailable(
      "This competition needs more comparable league data for a validated model.",
    );
  const run = await latestRun(f.code);
  if (!run)
    return unavailable(
      "The league model is awaiting its first validation run.",
    );
  if (!run.evaluation.validated)
    return unavailable(
      "The model has not passed this competition’s backtesting checks.",
    );
  if (Date.now() - new Date(run.data_cutoff).getTime() > 7 * 86400000)
    return unavailable("The league model needs a fresh calculation.");
  if (new Date(run.data_cutoff) >= new Date(f.kickoff_at))
    return unavailable("A suitable pre-match data cutoff is unavailable.");
  if (existing?.model_run_id === run.id) return snapshotView(existing);
  const p = predictGoals(run.fit, f.home_team_id, f.away_team_id);
  if (p.status !== "READY") return unavailable(p.reason);
  const details = {
    quality: p.quality,
    explanations: p.explanations,
    dataThrough: run.fit.lastMatchDate,
    expectedGoals: p.expectedGoals,
    markets: Object.fromEntries(
      Object.entries(p.markets).map(([k, v]) => [
        k,
        run.evaluation.markets[k].validated ? v : null,
      ]),
    ),
    validation: {
      count: run.evaluation.primary.model.count,
      logLoss: run.evaluation.primary.model.logLoss,
      brier: run.evaluation.primary.model.brier,
      ece: run.evaluation.primary.model.ece,
    },
    notice:
      "Statistical estimates, not guaranteed results or betting advice. 90-minute results only.",
  };
  await withTransaction(async (tx) => {
    const current = await tx.one(
      "SELECT * FROM football_fixtures WHERE id=? FOR UPDATE",
      [id],
    );
    const { server_now } = await tx.one(
      "SELECT UTC_TIMESTAMP(3) AS server_now",
    );
    if (
      current.status !== "SCHEDULED" ||
      new Date(current.kickoff_at) <= new Date(server_now) ||
      current.home_team_id !== f.home_team_id ||
      current.away_team_id !== f.away_team_id ||
      new Date(current.kickoff_at).getTime() !==
        new Date(f.kickoff_at).getTime()
    )
      return;
    await tx.q(
      `INSERT IGNORE INTO football_model_predictions(fixture_id,model_run_id,model_version,data_cutoff,kickoff_at,home_team_id,away_team_id,home_probability,draw_probability,away_probability,details) SELECT f.id,?,?,?,f.kickoff_at,f.home_team_id,f.away_team_id,?,?,?,? FROM football_fixtures f WHERE f.id=? AND f.kickoff_at>UTC_TIMESTAMP(3) AND f.status='SCHEDULED'`,
      [
        run.id,
        MODEL_VERSION,
        run.data_cutoff,
        p.probabilities.HOME,
        p.probabilities.DRAW,
        p.probabilities.AWAY,
        JSON.stringify(details),
        id,
      ],
    );
  });
  const row = await queryOne(
    "SELECT * FROM football_model_predictions WHERE fixture_id=? AND model_run_id=? AND kickoff_at=? AND home_team_id=? AND away_team_id=?",
    [id, run.id, f.kickoff_at, f.home_team_id, f.away_team_id],
  );
  return row
    ? snapshotView(row)
    : unavailable(
        "This match has started. Picks and new estimates are closed.",
      );
}
export async function modelMethodology() {
  const reports = await query(
    `SELECT r.competition_code,r.model_version,r.data_cutoff,r.created_at,r.evaluation FROM football_prediction_model_runs r WHERE r.model_version=? AND r.id=(SELECT r2.id FROM football_prediction_model_runs r2 WHERE r2.competition_code=r.competition_code AND r2.model_version=r.model_version ORDER BY r2.data_cutoff DESC,r2.created_at DESC,r2.id DESC LIMIT 1)`,
    [MODEL_VERSION],
  );
  return {
    version: MODEL_VERSION,
    method:
      "Recency-weighted independent Poisson goals, opponent-adjusted attack/defence strengths and league-specific home advantage. Ten prior matches shrink sparse teams towards the league mean.",
    cutoff:
      "Only verified results from dates strictly before the data cutoff; same-day and previous-day results are excluded because historical records may contain dates without kickoff times.",
    validation:
      "Up to 400 chronological rolling-origin forecasts per league, compared with a smoothed league-frequency baseline. Publication requires at least 200 evaluations covering 70% of attempted matches, no worse log loss or Brier score, and calibration error at most 0.10. Goal markets are validated separately.",
    sources: [
      "OpenFootball CC0 historical scores",
      "API-Football stored FT scores",
      "Verified football-data.org regulation-time results",
    ],
    reference: "https://doi.org/10.1111/1467-9876.00065",
    limitations:
      "This is an independent Poisson baseline, not a reproduction of Dixon–Coles. It omits lineups, injuries and low-score correlation. Backtests use corrected stored results rather than historical feed vintages. Coverage and validation are not guarantees.",
    reports: reports.map((r) => ({ ...r, evaluation: json(r.evaluation) })),
  };
}
export async function modelAccuracyReport() {
  const rows = await query(
    `SELECT p.* FROM football_model_predictions p JOIN football_fixtures f ON f.id=p.fixture_id WHERE p.actual_result IN ('HOME','DRAW','AWAY') AND p.predicted_at<f.kickoff_at AND p.id=(SELECT p2.id FROM football_model_predictions p2 WHERE p2.fixture_id=p.fixture_id AND p2.model_version=p.model_version AND p2.predicted_at<f.kickoff_at ORDER BY p2.predicted_at DESC,p2.id DESC LIMIT 1)`,
  );
  const versions = [...new Set(rows.map((r) => r.model_version))];
  return {
    versions: versions.map((version) => ({
      version,
      ...evaluateProbabilities(
        rows
          .filter((r) => r.model_version === version)
          .map((r) => ({
            probabilities: {
              HOME: Number(r.home_probability),
              DRAW: Number(r.draw_probability),
              AWAY: Number(r.away_probability),
            },
            actual: r.actual_result,
          })),
      ),
    })),
    notice:
      "Latest eligible pre-match snapshot per fixture and version. Voided or unverifiable results are excluded.",
  };
}
