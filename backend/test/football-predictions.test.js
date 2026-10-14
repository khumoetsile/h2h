import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
process.env.NODE_ENV = "test";
process.env.DB_NAME = process.env.DB_NAME_TEST || "rivalis_test";
const { migrate } = await import("../scripts/migrate.js");
const { seed } = await import("../scripts/seed.js");
const { pool, query, queryOne } = await import("../src/db.js");
const { createApp } = await import("../src/app.js");
const {
  fitGoalModel,
  predictGoals,
  chronologicalBacktest,
  prepareModelMatches,
  percentages,
  MODEL_VERSION,
} = await import("../src/football/footballPredictionModel.js");
const {
  saveFreePrediction,
  communityPicks,
  freePredictionHistory,
  reconcilePredictionResults,
  freePredictionRankings,
  rankingScore,
} = await import("../src/football/communityPredictionService.js");
const { modelPredictionForFixture } =
  await import("../src/football/footballPredictionService.js");
let user,
  peer,
  competition,
  teams = [];
before(async () => {
  await migrate({ fresh: true, log: () => {} });
  await seed({ log: () => {} });
  user = (await queryOne("SELECT id FROM users WHERE username='player'")).id;
  peer = (
    await query(
      "INSERT INTO users(first_name,last_name,phone,username,email,password_hash,role,status,is_bot) VALUES('Test','Peer','0000','prediction-peer','peer@prediction.test','test-only','PLAYER','ACTIVE',0)",
    )
  ).insertId;
  competition = (
    await query(
      "INSERT INTO football_competitions(provider,provider_competition_id,code,name,country) VALUES('football-data','prediction-test','PL','Premier League','England')",
    )
  ).insertId;
  for (let i = 0; i < 6; i++)
    teams.push(
      (
        await query(
          "INSERT INTO football_teams(provider,provider_team_id,name,short_name) VALUES('football-data',?,?,?)",
          ["prediction-" + i, "Prediction Club " + i, "Club " + i],
        )
      ).insertId,
    );
});
after(async () => pool.end());
test("public forecasts never expose another user’s selection; saving and private history require authentication", async () => {
  const app = createApp(),
    id = await fixture();
  await saveFreePrediction(user, id, "HOME");
  const publicView = await request(app)
    .get(`/api/football/fixtures/${id}/predictions`)
    .expect(200);
  assert.equal(publicView.body.community.mine, null);
  assert.equal(publicView.body.community.total, 1);
  await request(app)
    .put(`/api/football/fixtures/${id}/prediction`)
    .send({ pick: "AWAY" })
    .expect(401);
  await request(app).get("/api/football/predictions/mine").expect(401);
  await request(app)
    .get("/api/admin/football/predictions/evaluation")
    .expect(401);
  const login = await request(app)
    .post("/api/auth/login")
    .send({ identifier: "player", password: "Player123!" })
    .expect(200);
  const auth = "Bearer " + login.body.token;
  await request(app)
    .put(`/api/football/fixtures/${id}/prediction`)
    .set("Authorization", auth)
    .send({ pick: "OTHER" })
    .expect(400);
  await request(app)
    .get("/api/admin/football/predictions/evaluation")
    .set("Authorization", auth)
    .expect(403);
});
let sequence = 0;
async function fixture({
  status = "SCHEDULED",
  days = 1,
  home = teams[0],
  away = teams[1],
  scores = [null, null],
} = {}) {
  const r = await query(
    `INSERT INTO football_fixtures(provider,provider_fixture_id,competition_id,home_team_id,away_team_id,kickoff_at,status,home_score,away_score,is_simulated,research_eligible,score_duration) VALUES('football-data',?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? DAY),?,?,?,0,1,'REGULAR')`,
    [
      "prediction-" + ++sequence,
      competition,
      home,
      away,
      days,
      status,
      ...scores,
    ],
  );
  return r.insertId;
}
function records() {
  let state = 713;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state + 1) / 4294967297;
  };
  const goals = (lambda) => {
    let p = 1,
      k = 0;
    do {
      k++;
      p *= random();
    } while (p > Math.exp(-lambda));
    return k - 1;
  };
  const out = [];
  const now = Date.parse(new Date().toISOString().slice(0, 10));
  for (let round = 0; round < 120; round++)
    for (let pair = 0; pair < 3; pair++) {
      const h = (round + pair) % 6,
        a = (h + 1 + (round % 4)) % 6;
      out.push({
        id: `T-${round}-${pair}`,
        code: "PL",
        date: new Date(now - (360 - round * 3) * 86400000)
          .toISOString()
          .slice(0, 10),
        homeTeamId: teams[h] || h + 1,
        awayTeamId: teams[a] || a + 1,
        homeName: "Club " + h,
        awayName: "Club " + a,
        homeScore: goals(1.5 + h * 0.12),
        awayScore: goals(1.0 + a * 0.1),
      });
    }
  return out;
}
test("goal model probabilities sum to one and displayed percentages sum to 100; observed results are not copied as forecasts", () => {
  const data = records(),
    cutoff = new Date().toISOString().slice(0, 10),
    fit = fitGoalModel(data, cutoff),
    p = predictGoals(fit, teams[0], teams[1]);
  assert.equal(p.status, "READY");
  assert.ok(
    Math.abs(Object.values(p.probabilities).reduce((a, b) => a + b, 0) - 1) <
      1e-12,
  );
  assert.ok(
    Math.abs(Object.values(p.percentages).reduce((a, b) => a + b, 0) - 100) <
      1e-9,
  );
  assert.ok(p.markets.over25 > 0 && p.markets.over25 < 1);
  assert.ok(p.markets.btts > 0 && p.markets.btts < 1);
});
test("future and embargo-day results cannot change a historical fit; sparse/new teams abstain", () => {
  const data = records(),
    cutoff = new Date().toISOString().slice(0, 10),
    before = fitGoalModel(data, cutoff);
  const future = [
    { ...data[0], id: "future", date: "2099-01-01", homeScore: 12 },
    { ...data[0], id: "same-day", date: cutoff, homeScore: 12 },
    {
      ...data[0],
      id: "embargo",
      date: new Date(Date.parse(cutoff) - 86400000).toISOString().slice(0, 10),
      homeScore: 12,
    },
  ];
  const after = fitGoalModel([...data, ...future], cutoff);
  assert.equal(before.dataHash, after.dataHash);
  assert.equal(before.muHome, after.muHome);
  assert.equal(predictGoals(before, 999999, teams[1]).status, "UNAVAILABLE");
  assert.equal(fitGoalModel(data.slice(0, 5), cutoff).status, "UNAVAILABLE");
  const bad = [data[0], { ...data[0], id: "conflicting", awayScore: 12 }];
  assert.equal(prepareModelMatches(bad).length, 0);
});
test("chronological validation reports baselines, calibration and conditional coverage; no numbers are endorsed by a small backtest", () => {
  const report = chronologicalBacktest(records(), { limit: 40 });
  assert.equal(report.attempted, 40);
  assert.equal(report.validated, false);
  assert.ok(report.primary.model.count > 0);
  assert.ok(report.primary.baseline.logLoss > 0);
  assert.ok(report.primary.model.calibration.length);
  assert.ok(report.primary.model.ece >= 0 && report.primary.model.brier >= 0);
  assert.ok(report.coverage <= 1);
});
test("duplicate/racing free picks remain one active opinion; changes preserve wallet and PvP counts", async () => {
  const id = await fixture(),
    wallet = await queryOne("SELECT * FROM wallets WHERE user_id=?", [user]),
    matches = await queryOne("SELECT COUNT(*) AS n FROM matches");
  await Promise.all(
    ["HOME", "DRAW", "AWAY", "HOME"].map((p) =>
      saveFreePrediction(user, id, p),
    ),
  );
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) AS n FROM football_community_predictions WHERE fixture_id=?",
        [id],
      )
    ).n,
    1,
  );
  await saveFreePrediction(user, id, "DRAW");
  await saveFreePrediction(peer, id, "HOME");
  const votes = await communityPicks(id, user);
  assert.equal(votes.total, 2);
  assert.equal(votes.mine.pick, "DRAW");
  assert.deepEqual(votes.percentages, { HOME: 50, DRAW: 50, AWAY: 0 });
  assert.deepEqual(
    await queryOne("SELECT * FROM wallets WHERE user_id=?", [user]),
    wallet,
  );
  assert.equal(
    (await queryOne("SELECT COUNT(*) AS n FROM matches")).n,
    matches.n,
  );
  assert.equal(
    Object.values(percentages({ HOME: 0, DRAW: 0, AWAY: 0 })).every(
      (v) => v === null,
    ),
    true,
  );
});
test("kickoff and lifecycle restrictions are server enforced; a request waiting on a row lock cannot vote late", async () => {
  for (const status of [
    "LIVE",
    "FINISHED",
    "POSTPONED",
    "CANCELLED",
    "ABANDONED",
  ]) {
    const id = await fixture({ status });
    await assert.rejects(
      () => saveFreePrediction(user, id, "HOME"),
      (e) => e.code === "PREDICTIONS_CLOSED",
    );
  }
  const past = await fixture({ days: -1 });
  await assert.rejects(
    () => saveFreePrediction(user, past, "HOME"),
    (e) => e.code === "PREDICTIONS_CLOSED",
  );
  const id = await fixture();
  await query(
    "UPDATE football_fixtures SET kickoff_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 2 SECOND) WHERE id=?",
    [id],
  );
  const lock = await pool.getConnection();
  await lock.beginTransaction();
  await lock.query("SELECT id FROM football_fixtures WHERE id=? FOR UPDATE", [
    id,
  ]);
  const request = saveFreePrediction(user, id, "HOME").then(
    () => null,
    (e) => e,
  );
  await new Promise((r) => setTimeout(r, 2500));
  await lock.commit();
  lock.release();
  assert.equal((await request).code, "PREDICTIONS_CLOSED");
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) AS n FROM football_community_predictions WHERE fixture_id=?",
        [id],
      )
    ).n,
    0,
  );
});
test("verified prediction accuracy excludes cancellations, postponements and extra time; rankings require 20 results", async () => {
  for (let i = 0; i < 20; i++) {
    const id = await fixture({ status: "FINISHED", days: -1, scores: [2, 1] });
    await query(
      "INSERT INTO football_community_predictions(user_id,fixture_id,pick,home_team_id,away_team_id,submitted_at,updated_at) VALUES(?,?,'HOME',?,?,DATE_SUB(UTC_TIMESTAMP(),INTERVAL 2 DAY),DATE_SUB(UTC_TIMESTAMP(),INTERVAL 2 DAY))",
      [user, id, teams[0], teams[1]],
    );
  }
  for (const status of ["CANCELLED", "ABANDONED", "POSTPONED", "FINISHED"]) {
    const id = await fixture({ status, days: -1, scores: [2, 1] });
    if (status === "FINISHED")
      await query(
        "UPDATE football_fixtures SET score_duration='EXTRA_TIME' WHERE id=?",
        [id],
      );
    await query(
      "INSERT INTO football_community_predictions(user_id,fixture_id,pick,home_team_id,away_team_id,updated_at) VALUES(?,?,'AWAY',?,?,DATE_SUB(UTC_TIMESTAMP(),INTERVAL 2 DAY))",
      [user, id, teams[0], teams[1]],
    );
  }
  await reconcilePredictionResults();
  const history = await freePredictionHistory(user);
  assert.equal(history.summary.settled, 20);
  assert.equal(history.summary.correct, 20);
  assert.equal(history.summary.accuracy, 100);
  const rankings = await freePredictionRankings();
  assert.equal(rankings.minimum, 20);
  assert.equal(rankings.rankings[0].username, "player");
  assert.equal(rankings.rankings[0].settled, 20);
  assert.equal(
    rankings.rankings.some((r) => r.username === "prediction-peer"),
    false,
  );
  assert.ok(rankingScore(20, 20) > rankingScore(10, 10));
});
test("model snapshots are unique per input run and immutable after kickoff/lifecycle changes", async () => {
  const fit = fitGoalModel(records(), new Date().toISOString().slice(0, 10));
  const evaluation = {
    validated: true,
    primary: { model: { count: 400, logLoss: 1, brier: 0.6, ece: 0.05 } },
    markets: { over25: { validated: false }, btts: { validated: false } },
  };
  await query(
    "INSERT INTO football_prediction_model_runs(competition_code,model_version,data_hash,data_cutoff,fit,evaluation) VALUES(?,?,?,?,?,?)",
    [
      "PL",
      MODEL_VERSION,
      fit.dataHash,
      fit.cutoffDate + " 00:00:00",
      JSON.stringify(fit),
      JSON.stringify(evaluation),
    ],
  );
  const id = await fixture();
  const first = await modelPredictionForFixture(id);
  assert.equal(first.status, "READY");
  assert.equal(first.markets.over25, null);
  const again = await modelPredictionForFixture(id);
  assert.equal(again.snapshotId, first.snapshotId);
  await query(
    "UPDATE football_fixtures SET status='FINISHED',home_score=9,away_score=0 WHERE id=?",
    [id],
  );
  const after = await modelPredictionForFixture(id);
  assert.deepEqual(after.percentages, first.percentages);
  assert.equal(after.snapshotId, first.snapshotId);
  assert.equal(
    new Date(after.calculatedAt).getTime(),
    new Date(first.calculatedAt).getTime(),
  );
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) AS n FROM football_model_predictions WHERE fixture_id=?",
        [id],
      )
    ).n,
    1,
  );
});
