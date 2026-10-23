import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
process.env.NODE_ENV = "test";
process.env.DB_NAME = process.env.DB_NAME_TEST || "rivalis_test";
const { migrate } = await import("../scripts/migrate.js");
const { seed } = await import("../scripts/seed.js");
const { pool, query, queryOne, withTransaction } = await import("../src/db.js");
const { createApp } = await import("../src/app.js");
const {
  publishDailyChallenge,
  submitDailyPrediction,
  settleDailyChallenge,
  dailyOverview,
  dailyHistory,
  dailyLeaderboard,
  setDailyReminders,
  sweepDailyPredictions,
} = await import("../src/football/dailyPredictionService.js");
const { challengeDay } =
  await import("../src/football/dailyPredictionRules.js");
let user,
  peer,
  admin,
  competition,
  teams = [],
  seq = 0,
  auth,
  adminAuth;
const app = createApp();
before(async () => {
  await migrate({ fresh: true, log: () => {} });
  await seed({ log: () => {} });
  user = (await queryOne("SELECT id FROM users WHERE username='player'")).id;
  admin = (await queryOne("SELECT id FROM users WHERE role='ADMIN' LIMIT 1"))
    .id;
  peer = (
    await query(
      "INSERT INTO users(first_name,last_name,phone,username,email,password_hash) VALUES('Daily','Peer','0','daily-peer','daily-peer@test.invalid','test-only')",
    )
  ).insertId;
  competition = (
    await query(
      "INSERT INTO football_competitions(provider,provider_competition_id,code,name) VALUES('football-data','daily-test','PL','Test league')",
    )
  ).insertId;
  for (let i = 0; i < 3; i++)
    teams.push(
      (
        await query(
          "INSERT INTO football_teams(provider,provider_team_id,name) VALUES('football-data',?,?)",
          ["daily-" + i, "Daily Team " + i],
        )
      ).insertId,
    );
  auth =
    "Bearer " +
    (
      await request(app)
        .post("/api/auth/login")
        .send({ identifier: "player", password: "Player123!" })
        .expect(200)
    ).body.token;
  // Service-level admin identity is covered independently of the seeded admin password.
  const { signToken } = await import("../src/middleware/auth.js");
  const sid = "daily-admin-test-session";
  const expires = new Date(Date.now() + 3600000);
  await query("INSERT INTO sessions(id,user_id,expires_at) VALUES (?,?,?)", [
    sid,
    admin,
    expires,
  ]);
  adminAuth = "Bearer " + signToken(sid, admin, expires);
});
after(async () => pool.end());
async function fixture(extra = {}) {
  const n = ++seq;
  const time = new Date(Date.now() + n * 86400000);
  const r = await query(
    `INSERT INTO football_fixtures(provider,provider_fixture_id,competition_id,home_team_id,away_team_id,kickoff_at,status,is_simulated,last_synced_at,research_eligible,score_duration) VALUES('football-data',?,?,?,?,?,'SCHEDULED',0,UTC_TIMESTAMP(),1,'REGULAR')`,
    ["daily-test-" + n, competition, teams[0], teams[1], time],
  );
  if (Object.keys(extra).length)
    await query("UPDATE football_fixtures SET ? WHERE id=?", [
      extra,
      r.insertId,
    ]);
  return r.insertId;
}
async function challenge(extra = {}) {
  const fixtureId = await fixture(extra);
  return {
    ...(await publishDailyChallenge(admin, {
      fixtureId,
      referenceTeamId: teams[0],
    })),
    fixtureId,
  };
}
async function final(c, home = 2, away = 0) {
  await query(
    "UPDATE daily_predictions SET submitted_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 4 HOUR),updated_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 4 HOUR) WHERE challenge_id=?",
    [c.id],
  );
  await query(
    "UPDATE football_fixtures SET kickoff_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 3 HOUR),status='FINISHED',home_score=?,away_score=?,last_synced_at=UTC_TIMESTAMP() WHERE id=?",
    [home, away, c.fixtureId],
  );
}
test("public dashboard has no community selections before submission; private endpoints require auth and admin", async () => {
  await request(app).get("/api/daily-predictions").expect(200);
  assert.equal((await dailyLeaderboard("daily")).rankings.length, 0);
  await request(app).get("/api/daily-predictions/history").expect(401);
  await request(app)
    .put("/api/daily-predictions/1/prediction")
    .send({ pick: "WIN" })
    .expect(401);
  await request(app)
    .get("/api/daily-predictions/admin/fixtures")
    .set("Authorization", auth)
    .expect(403);
  await request(app)
    .get("/api/daily-predictions/admin/fixtures")
    .set("Authorization", adminAuth)
    .expect(200);
});
test("creation validates real upcoming recent fixtures and reference team; date/slot uniqueness", async () => {
  for (const extra of [
    { provider: "mock" },
    { is_simulated: 1 },
    { status: "FINISHED" },
    { kickoff_at: new Date(Date.now() - 10000) },
    { last_synced_at: new Date(Date.now() - 7 * 3600000) },
  ]) {
    const id = await fixture(extra);
    await assert.rejects(
      publishDailyChallenge(admin, {
        fixtureId: id,
        referenceTeamId: teams[0],
      }),
      { code: "INVALID_FIXTURE" },
    );
  }
  const id = await fixture();
  await assert.rejects(
    publishDailyChallenge(admin, { fixtureId: id, referenceTeamId: teams[2] }),
    { code: "INVALID_REFERENCE" },
  );
  const c = await publishDailyChallenge(admin, {
    fixtureId: id,
    referenceTeamId: teams[1],
  });
  assert.ok(c.id);
  await assert.rejects(
    publishDailyChallenge(admin, { fixtureId: id, referenceTeamId: teams[1] }),
    { code: "DUPLICATE_CHALLENGE" },
  );
  const another = await fixture();
  const f = await queryOne(
    "SELECT kickoff_at FROM football_fixtures WHERE id=?",
    [id],
  );
  await query("UPDATE football_fixtures SET kickoff_at=? WHERE id=?", [
    f.kickoff_at,
    another,
  ]);
  await assert.rejects(
    publishDailyChallenge(admin, {
      fixtureId: another,
      referenceTeamId: teams[0],
    }),
    { code: "DUPLICATE_CHALLENGE" },
  );
});
test("one mutable prediction per user and race; community counts update without exposing private picks", async () => {
  const c = await challenge();
  await request(app)
    .put(`/api/daily-predictions/${c.id}/prediction`)
    .set("Authorization", auth)
    .send({ pick: "WIN" })
    .expect(200);
  await request(app)
    .put(`/api/daily-predictions/${c.id}/prediction`)
    .set("Authorization", auth)
    .send({ pick: "INVALID" })
    .expect(400);
  for (const pick of ["WIN", "DRAW", "LOSS"])
    await submitDailyPrediction(user, c.id, pick);
  await Promise.all(
    Array.from({ length: 8 }, () => submitDailyPrediction(user, c.id, "WIN")),
  );
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) n FROM daily_predictions WHERE user_id=? AND challenge_id=?",
        [user, c.id],
      )
    ).n,
    1,
  );
  await assert.rejects(submitDailyPrediction(user, c.id, "HOME"), {
    code: "INVALID_OUTCOME",
  });
  await assert.rejects(
    publishDailyChallenge(admin, {
      fixtureId: c.fixtureId,
      referenceTeamId: teams[1],
      challengeId: c.id,
    }),
    { code: "CHALLENGE_IMMUTABLE" },
  );
  // Bring this test challenge into the current dashboard calendar without changing any production data.
  await query(
    "UPDATE daily_prediction_challenges SET challenge_date=? WHERE id=?",
    [challengeDay(), c.id],
  );
  let view = await dailyOverview(user);
  assert.equal(view.challenges[0].community.total, 1);
  assert.equal(view.challenges[0].community.selections[0].percentage, 100);
  await submitDailyPrediction(user, c.id, "DRAW");
  view = await dailyOverview(user);
  assert.equal(view.challenges[0].community.selections[1].percentage, 100);
  assert.equal((await dailyOverview(peer)).challenges[0].community, undefined);
  assert.equal((await dailyOverview()).challenges[0].community, undefined);
  const before = await query("SELECT * FROM wallets WHERE user_id=?", [user]);
  await submitDailyPrediction(user, c.id, "WIN");
  assert.deepEqual(
    await query("SELECT * FROM wallets WHERE user_id=?", [user]),
    before,
  );
});
test("backend refuses actual kickoff, published cutoff, live, completed and permanently locked predictions", async () => {
  for (const change of [
    { status: "LIVE" },
    { status: "FINISHED" },
    { kickoff_at: new Date(Date.now() - 1000) },
  ]) {
    const c = await challenge();
    await query("UPDATE football_fixtures SET ? WHERE id=?", [
      change,
      c.fixtureId,
    ]);
    await assert.rejects(submitDailyPrediction(user, c.id, "WIN"), {
      code: "PREDICTIONS_LOCKED",
    });
  }
  const c = await challenge();
  await query(
    "UPDATE daily_prediction_challenges SET cutoff_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE id=?",
    [c.id],
  );
  await assert.rejects(submitDailyPrediction(user, c.id, "WIN"), {
    code: "PREDICTIONS_LOCKED",
  });
  await query(
    "UPDATE daily_prediction_challenges SET locked_at=UTC_TIMESTAMP(),status='LOCKED',cutoff_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 3 DAY) WHERE id=?",
    [c.id],
  );
  await assert.rejects(submitDailyPrediction(user, c.id, "WIN"), {
    code: "PREDICTIONS_LOCKED",
  });
});
test("verified settlement is idempotent; achievements, audit and opt-in notifications do not duplicate", async () => {
  const c = await challenge();
  await setDailyReminders(user, true);
  await submitDailyPrediction(user, c.id, "WIN");
  await final(c);
  assert.equal((await settleDailyChallenge(c.id)).result, "WIN");
  const stats = await queryOne(
    "SELECT details FROM daily_prediction_stats WHERE user_id=?",
    [user],
  );
  const notices = await queryOne(
    "SELECT COUNT(*) n FROM notifications WHERE user_id=?",
    [user],
  );
  await Promise.all([settleDailyChallenge(c.id), settleDailyChallenge(c.id)]);
  assert.deepEqual(
    await queryOne(
      "SELECT details FROM daily_prediction_stats WHERE user_id=?",
      [user],
    ),
    stats,
  );
  assert.equal(
    (
      await queryOne("SELECT COUNT(*) n FROM notifications WHERE user_id=?", [
        user,
      ])
    ).n,
    notices.n,
  );
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) n FROM daily_prediction_audit WHERE challenge_id=?",
        [c.id],
      )
    ).n,
    2,
  );
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) n FROM daily_prediction_achievements WHERE user_id=? AND code='first_correct' AND active=1",
        [user],
      )
    ).n,
    1,
  );
});
test("official correction requires admin reconciliation and recomputes stored statistics", async () => {
  const c = await challenge();
  await submitDailyPrediction(peer, c.id, "WIN");
  await final(c);
  await settleDailyChallenge(c.id);
  await final(c, 0, 2);
  await settleDailyChallenge(c.id);
  assert.equal(
    (
      await queryOne(
        "SELECT actual_result FROM daily_prediction_challenges WHERE id=?",
        [c.id],
      )
    ).actual_result,
    "WIN",
  );
  await request(app)
    .post(`/api/daily-predictions/admin/challenges/${c.id}/reconcile`)
    .set("Authorization", auth)
    .send({ reason: "Official score corrected" })
    .expect(403);
  await assert.rejects(
    settleDailyChallenge(c.id, {
      actorId: admin,
      reconcile: true,
      reason: "short",
    }),
    { code: "REASON_REQUIRED" },
  );
  await settleDailyChallenge(c.id, {
    actorId: admin,
    reconcile: true,
    reason: "Official full-time score corrected",
  });
  const stats = await dailyOverview(peer);
  assert.equal(stats.stats.correct, 0);
  assert.equal(stats.stats.incorrect, 1);
  assert.equal(
    stats.achievements.some((a) => a.code === "first_correct"),
    false,
  );
});
test("outages and missing verification do not settle; postponement voids without accuracy failure", async () => {
  const c = await challenge();
  await submitDailyPrediction(peer, c.id, "DRAW");
  await final(c);
  await query("UPDATE football_fixtures SET research_eligible=0 WHERE id=?", [
    c.fixtureId,
  ]);
  assert.equal((await settleDailyChallenge(c.id)).awaitingVerification, true);
  assert.equal(
    (
      await queryOne(
        "SELECT actual_result FROM daily_prediction_challenges WHERE id=?",
        [c.id],
      )
    ).actual_result,
    null,
  );
  await query("UPDATE football_fixtures SET status='POSTPONED' WHERE id=?", [
    c.fixtureId,
  ]);
  assert.equal((await settleDailyChallenge(c.id)).result, "VOID");
  assert.equal(
    (await dailyHistory(peer, { filter: "void" })).predictions[0].actualResult,
    "VOID",
  );
});
test("transaction failures roll back prediction and achievements atomically", async () => {
  const c = await challenge();
  await query(
    "CREATE TRIGGER daily_test_failure BEFORE UPDATE ON daily_prediction_stats FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test transaction failure'",
  );
  try {
    await assert.rejects(submitDailyPrediction(user, c.id, "WIN"));
    assert.equal(
      await queryOne(
        "SELECT id FROM daily_predictions WHERE user_id=? AND challenge_id=?",
        [user, c.id],
      ),
      null,
    );
  } finally {
    await query("DROP TRIGGER daily_test_failure");
  }
});
test("daily weekly monthly all rankings share ranks and use actual points, pagination and own position", async () => {
  const c = await challenge();
  await submitDailyPrediction(user, c.id, "WIN");
  await submitDailyPrediction(peer, c.id, "WIN");
  await final(c);
  await settleDailyChallenge(c.id);
  await query(
    "UPDATE daily_prediction_challenges SET challenge_date=DATE_SUB(?,INTERVAL 1 DAY) WHERE challenge_date=?",
    [challengeDay(), challengeDay()],
  );
  await query(
    "UPDATE daily_prediction_challenges SET challenge_date=? WHERE id=?",
    [challengeDay(), c.id],
  );
  for (const period of ["daily", "weekly", "monthly", "all"]) {
    const b = await dailyLeaderboard(period, peer, { page: 1, pageSize: 1 });
    assert.equal(b.rankings.length, 1);
    assert.ok(b.mine);
    assert.equal(b.mine.points, b.mine.correct);
  }
  const b = await dailyLeaderboard("daily", peer);
  assert.equal(b.rankings[0].rank, b.rankings[1].rank);
  assert.equal(b.rankings[0].points, 1);
  const h = await dailyHistory(peer, { filter: "correct", pageSize: 1 });
  assert.equal(h.predictions.length, 1);
  assert.equal(h.predictions[0].points, 1);
  await assert.rejects(dailyLeaderboard("invalid"), { code: "INVALID_PERIOD" });
  await request(app)
    .get("/api/daily-predictions/history?page=-1")
    .set("Authorization", auth)
    .expect(400);
});
test("batched settlement supports one thousand real test participants without duplicate scoring", async () => {
  const c = await challenge();
  const rows = Array.from({ length: 1000 }, (_, i) => [
    "Load",
    "Test",
    "0",
    `daily-load-${i}`,
    `daily-load-${i}@test.invalid`,
    "test-only",
  ]);
  await query(
    "INSERT INTO users(first_name,last_name,phone,username,email,password_hash) VALUES ?",
    [rows],
  );
  const users = await query(
    "SELECT id FROM users WHERE username LIKE 'daily-load-%'",
  );
  await query(
    "INSERT INTO daily_predictions(user_id,challenge_id,pick) VALUES ?",
    [users.map((u) => [u.id, c.id, "WIN"])],
  );
  await final(c);
  await settleDailyChallenge(c.id);
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) n FROM daily_prediction_stats WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'daily-load-%')",
      )
    ).n,
    1000,
  );
  await settleDailyChallenge(c.id);
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) n FROM daily_predictions WHERE challenge_id=?",
        [c.id],
      )
    ).n,
    1000,
  );
});
test("administrator can permanently void an unavailable challenge with an audit reason", async () => {
  const c = await challenge();
  await submitDailyPrediction(user, c.id, "WIN");
  await request(app)
    .post(`/api/daily-predictions/admin/challenges/${c.id}/void`)
    .set("Authorization", auth)
    .send({ reason: "Result unavailable permanently" })
    .expect(403);
  await request(app)
    .post(`/api/daily-predictions/admin/challenges/${c.id}/void`)
    .set("Authorization", adminAuth)
    .send({ reason: "Result unavailable permanently" })
    .expect(200);
  assert.equal(
    (
      await queryOne(
        "SELECT actual_result FROM daily_prediction_challenges WHERE id=?",
        [c.id],
      )
    ).actual_result,
    "VOID",
  );
});
test("sweeper uses cached real fixtures and does not duplicate dates across repeated runs", async () => {
  const fixtureId = await fixture({
    kickoff_at: new Date(Date.now() + 86400000),
  });
  await Promise.all([sweepDailyPredictions(), sweepDailyPredictions()]);
  assert.ok(
    await queryOne(
      "SELECT id FROM daily_prediction_challenges WHERE fixture_id=?",
      [fixtureId],
    ),
  );
  const before = await queryOne(
    "SELECT COUNT(*) n FROM daily_prediction_challenges",
  );
  await sweepDailyPredictions();
  assert.equal(
    (await queryOne("SELECT COUNT(*) n FROM daily_prediction_challenges")).n,
    before.n,
  );
});

test("provider kickoff corrections never award an informed late selection", async () => {
  const c = await challenge();
  await submitDailyPrediction(user, c.id, "WIN");
  await final(c);
  await query(
    "UPDATE daily_predictions SET updated_at=UTC_TIMESTAMP() WHERE challenge_id=?",
    [c.id],
  );
  assert.equal((await settleDailyChallenge(c.id)).result, "VOID");
});
test("fixture sync keeps earlier cutoffs and never reopens a previously observed live match", async () => {
  const { syncDailyPredictionDeadline } =
    await import("../src/football/footballSyncService.js");
  const c = await challenge();
  const f = await queryOne(
    "SELECT provider_fixture_id,kickoff_at FROM football_fixtures WHERE id=?",
    [c.fixtureId],
  );
  const earlier = new Date(new Date(f.kickoff_at).getTime() - 3600000);
  await query("UPDATE football_fixtures SET kickoff_at=? WHERE id=?", [
    earlier,
    c.fixtureId,
  ]);
  await syncDailyPredictionDeadline("football-data", f.provider_fixture_id);
  assert.equal(
    new Date(
      (
        await queryOne(
          "SELECT cutoff_at FROM daily_prediction_challenges WHERE id=?",
          [c.id],
        )
      ).cutoff_at,
    ).getTime(),
    earlier.getTime(),
  );
  await query("UPDATE football_fixtures SET kickoff_at=? WHERE id=?", [
    f.kickoff_at,
    c.fixtureId,
  ]);
  await syncDailyPredictionDeadline("football-data", f.provider_fixture_id);
  assert.equal(
    new Date(
      (
        await queryOne(
          "SELECT cutoff_at FROM daily_prediction_challenges WHERE id=?",
          [c.id],
        )
      ).cutoff_at,
    ).getTime(),
    earlier.getTime(),
  );
  await query("UPDATE football_fixtures SET status='LIVE' WHERE id=?", [
    c.fixtureId,
  ]);
  await syncDailyPredictionDeadline("football-data", f.provider_fixture_id);
  await query("UPDATE football_fixtures SET status='SCHEDULED' WHERE id=?", [
    c.fixtureId,
  ]);
  await syncDailyPredictionDeadline("football-data", f.provider_fixture_id);
  assert.equal(
    (
      await queryOne(
        "SELECT status FROM daily_prediction_challenges WHERE id=?",
        [c.id],
      )
    ).status,
    "LOCKED",
  );
});
test("failed settlement rolls back result, revision, summaries and awards", async () => {
  const c = await challenge();
  await submitDailyPrediction(user, c.id, "WIN");
  await final(c);
  await query(
    "CREATE TRIGGER daily_settle_failure BEFORE UPDATE ON daily_prediction_stats FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test rollback'",
  );
  try {
    await assert.rejects(settleDailyChallenge(c.id));
    assert.equal(
      (
        await queryOne(
          "SELECT actual_result FROM daily_prediction_challenges WHERE id=?",
          [c.id],
        )
      ).actual_result,
      null,
    );
    assert.equal(
      (
        await queryOne(
          "SELECT COUNT(*) n FROM daily_prediction_audit WHERE challenge_id=?",
          [c.id],
        )
      ).n,
      1,
    );
  } finally {
    await query("DROP TRIGGER daily_settle_failure");
  }
  assert.equal((await settleDailyChallenge(c.id)).result, "WIN");
});
