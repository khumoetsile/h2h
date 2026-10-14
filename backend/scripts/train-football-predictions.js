import { pool, query } from "../src/db.js";
import { MODEL_LEAGUES } from "../src/football/footballPredictionModel.js";
import {
  trainCompetitionModel,
  modelPredictionForFixture,
} from "../src/football/footballPredictionService.js";
import { reconcilePredictionResults } from "../src/football/communityPredictionService.js";
const args = Object.fromEntries(
  process.argv.slice(2).map((s) => {
    const [k, v] = s.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const leagues = (args.leagues || MODEL_LEAGUES.join(",")).split(",");
if (leagues.some((c) => !MODEL_LEAGUES.includes(c)))
  throw new Error("Use supported league codes.");
const connection = await pool.getConnection();
let failed = false;
try {
  const [[lock]] = await connection.query(
    "SELECT GET_LOCK('h2h-football-models',0) AS acquired",
  );
  if (!lock.acquired) {
    console.log("Prediction training is already running.");
  } else {
    for (const code of leagues) {
      try {
        console.log(JSON.stringify(await trainCompetitionModel(code)));
      } catch (err) {
        console.error(`${code}: ${err.message}`);
        failed = true;
      }
    }
    const fixtures = await query(
      "SELECT id FROM football_fixtures WHERE is_simulated=0 AND provider<>'mock' AND status='SCHEDULED' AND kickoff_at>UTC_TIMESTAMP() AND kickoff_at<DATE_ADD(UTC_TIMESTAMP(),INTERVAL 21 DAY) ORDER BY kickoff_at LIMIT 200",
    );
    let ready = 0;
    for (const f of fixtures) {
      const p = await modelPredictionForFixture(f.id);
      if (p.status === "READY") ready++;
    }
    await reconcilePredictionResults();
    console.log(JSON.stringify({ upcoming: fixtures.length, recorded: ready }));
  }
} finally {
  await connection
    .query("SELECT RELEASE_LOCK('h2h-football-models')")
    .catch(() => {});
  connection.release();
  await pool.end();
}
process.exitCode = failed ? 1 : 0;
