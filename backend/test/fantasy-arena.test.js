import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
process.env.NODE_ENV = "test";
process.env.DB_NAME = process.env.DB_NAME_TEST || "rivalis_test";
const { migrate } = await import("../scripts/migrate.js");
const { seed } = await import("../scripts/seed.js");
const { query, queryOne, pool } = await import("../src/db.js");
const svc = await import("../src/football/fantasyArenaService.js");
const { createWallet, demoDeposit } =
  await import("../src/services/walletService.js");
const { withTransaction } = await import("../src/db.js");
const { createApp } = await import("../src/app.js");
let admin,
  competition,
  teams = [],
  users = [],
  sequence = 0;
before(async () => {
  await migrate({ fresh: true, log: () => {} });
  await seed({ log: () => {} });
  admin = (await queryOne("SELECT id FROM users WHERE role='ADMIN' LIMIT 1"))
    .id;
  const hash = (
    await queryOne("SELECT password_hash FROM users WHERE username='player'")
  ).password_hash;
  for (let i = 0; i < 7; i++) {
    const u = await query(
      "INSERT INTO users(first_name,last_name,phone,username,email,password_hash,role,status,is_bot) VALUES('Arena','Test','0000',?,?,?,'PLAYER','ACTIVE',0)",
      ["arena-player-" + i, `arena-${i}@test.local`, hash],
    );
    users.push(u.insertId);
    await withTransaction((tx) => createWallet(tx, u.insertId));
    await demoDeposit(u.insertId, 200, { silent: true });
  }
  competition = (
    await query(
      "INSERT INTO football_competitions(provider,provider_competition_id,code,name,country) VALUES('football-data','arena-test','PL','Arena test league','England')",
    )
  ).insertId;
  for (let i = 0; i < 4; i++)
    teams.push(
      (
        await query(
          "INSERT INTO football_teams(provider,provider_team_id,name) VALUES('football-data',?,?)",
          ["arena-team-" + i, "Arena Team " + i],
        )
      ).insertId,
    );
});
after(() => pool.end());
test('automatic arenas publish real major-club slips once despite concurrent sweepers, without changing manual entries',async()=>{
  const {ensureAutomaticArenas}=await import('../src/football/automaticArenaService.js');
  const big=(await query("INSERT INTO football_teams(provider,provider_team_id,name) VALUES('football-data','65','Manchester City FC')")).insertId;
  for(let i=0;i<5;i++) await query(`INSERT INTO football_fixtures(provider,provider_fixture_id,competition_id,home_team_id,away_team_id,kickoff_at,status,is_simulated,last_synced_at)
    VALUES('football-data',?,?,?, ?,DATE_ADD(DATE_ADD(UTC_DATE(),INTERVAL 3 DAY),INTERVAL 14 HOUR),'SCHEDULED',0,UTC_TIMESTAMP())`,['auto-'+i,competition,big,teams[i%4]]);
  const outcomes=await Promise.all([ensureAutomaticArenas(),ensureAutomaticArenas()]);
  assert.equal(outcomes.flat().length,1);assert.deepEqual(await ensureAutomaticArenas(),[]);
  const row=await queryOne('SELECT * FROM fantasy_arenas WHERE automatic_key IS NOT NULL');
  assert.equal(row.status,'OPEN');assert.equal(row.entry_cents,2000);assert.equal(row.participant_count,0);
  assert.equal((await svc.arenaDetail(row.id)).fixtures.length,5);
  const audit=await queryOne("SELECT actor_type FROM audit_events WHERE entity_type='ARENA' AND entity_id=? AND action='ARENA_PUBLISHED'",[String(row.id)]);
  assert.equal(audit.actor_type,'SYSTEM');
  await query('UPDATE football_fixtures SET last_synced_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY) WHERE provider_fixture_id LIKE ?',['auto-%']);
  assert.deepEqual(await ensureAutomaticArenas(),[]);
});
test("more than 100 players join without a participant cap, leaderboard pages stay bounded and tied settlements reconcile", async () => {
  const { id, d } = await setup(1, { entryFee: 0.01 });
  const playerHash = (
    await queryOne("SELECT password_hash FROM users WHERE username='player'")
  ).password_hash;
  const ids = [];
  for (let i = 0; i < 101; i++) {
    const u = await query(
      "INSERT INTO users(first_name,last_name,phone,username,email,password_hash,role,status,is_bot) VALUES('Load','Test','0000',?,?,?,'PLAYER','ACTIVE',0)",
      ["arena-load-" + i, `arena-load-${i}@test.local`, playerHash],
    );
    ids.push(u.insertId);
    await withTransaction((tx) => createWallet(tx, u.insertId));
    await demoDeposit(u.insertId, 1, { silent: true });
  }
  for (let i = 0; i < ids.length; i += 10)
    await Promise.all(
      ids.slice(i, i + 10).map((u) => svc.joinArena(u, id, slip(d, ["DRAW"]))),
    );
  assert.equal((await svc.arenaDetail(id)).arena.participants, 101);
  const page = await svc.arenaLeaderboard(id, {
    page: 4,
    pageSize: 25,
    userId: ids[100],
  });
  assert.equal(page.rows.length, 25);
  assert.equal(page.hasMore, true);
  assert.equal(page.myRank.position, 1);
  assert.equal(
    (await svc.arenaLeaderboard(id, { page: 5, pageSize: 25 })).rows.length,
    1,
  );
  await close(id);
  await finish(d, [[0, 0]]);
  const total = await queryOne(
    "SELECT SUM(payout_cents) AS paid,COUNT(*) AS n,MIN(final_rank) AS first,MAX(final_rank) AS last FROM fantasy_arena_entries WHERE arena_id=?",
    [id],
  );
  assert.equal(Number(total.paid), 91);
  assert.equal(total.n, 101);
  assert.equal(total.first, 1);
  assert.equal(total.last, 1);
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) AS n FROM fantasy_arena_settlements WHERE arena_id=?",
        [id],
      )
    ).n,
    1,
  );
});
test("an unverified final stays pending, and cancelled unpublished drafts stay private", async () => {
  const { id, d, input } = await setup(1);
  for (const u of users.slice(3, 6)) await svc.joinArena(u, id, slip(d));
  await close(id);
  await query(
    "UPDATE football_fixtures SET status='FINISHED',kickoff_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR),home_score=NULL,away_score=NULL WHERE id=?",
    [d.fixtures[0].fixtureId],
  );
  await svc.advanceArena(id);
  assert.equal((await svc.arenaDetail(id)).arena.status, "LIVE");
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) AS n FROM fantasy_arena_settlements WHERE arena_id=?",
        [id],
      )
    ).n,
    0,
  );
  await finish(d, [[1, 1]]);
  assert.equal((await svc.arenaDetail(id)).arena.status, "COMPLETED");
  const future = await setup(1);
  const { id: draft } = await svc.createArena(admin, {
    ...future.input,
    name: "Unpublished private draft",
  });
  await svc.cancelArena(admin, draft, "Draft withdrawn before publication.");
  await assert.rejects(svc.arenaDetail(draft), /not found/);
  assert.equal(
    (await svc.listArenas({ section: "completed" })).arenas.some(
      (a) => a.id === draft,
    ),
    false,
  );
});
async function setup(count = 2, options = {}) {
  const selected = [];
  for (let i = 0; i < count; i++) {
    const f = await query(
      "INSERT INTO football_fixtures(provider,provider_fixture_id,competition_id,home_team_id,away_team_id,kickoff_at,status,is_simulated,research_eligible,score_duration) VALUES('football-data',?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 2 DAY),'SCHEDULED',0,1,'REGULAR')",
      ["arena-" + ++sequence, competition, teams[i % 2], teams[2 + (i % 2)]],
    );
    selected.push({
      fixtureId: f.insertId,
      referenceTeamId: i % 2 ? teams[3] : teams[0],
    });
  }
  const input = {
    name: "Test Arena " + sequence,
    description: "Automated tests only",
    entryFee: 20,
    feePercent: 10,
    prizePercentages: [50, 30, 20],
    fixtures: selected,
    ...options,
  };
  const { id } = await svc.createArena(admin, input);
  await svc.publishArena(admin, id);
  const d = await svc.arenaDetail(id);
  return { id, d, input };
}
const slip = (d, picks = ["WIN", "WIN"]) =>
  d.fixtures.map((f, i) => ({
    arenaFixtureId: f.id,
    pick: picks[i % picks.length],
  }));
async function balance(user) {
  return queryOne(
    "SELECT available_balance AS available,locked_balance AS locked FROM wallets WHERE user_id=?",
    [user],
  );
}
async function close(id) {
  await query(
    "UPDATE fantasy_arenas SET deadline=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE id=?",
    [id],
  );
  await svc.advanceArena(id);
}
async function finish(d, results) {
  for (let i = 0; i < d.fixtures.length; i++) {
    const scores = results[i];
    await query(
      "UPDATE football_fixtures SET status='FINISHED',kickoff_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR),home_score=?,away_score=? WHERE id=?",
      [...scores, d.fixtures[i].fixtureId],
    );
  }
  await svc.advanceArena(d.arena.id);
}
test("integer pools and tie groups conserve every cent without arbitrary rank tie-breakers", () => {
  const p = svc.arenaPool(100, 2000, 1000);
  assert.equal(Number(p.gross), 200000);
  assert.equal(p.fee, 20000);
  assert.equal(p.net, 180000);
  assert.deepEqual(p.amounts, [90000, 54000, 36000]);
  for (let n = 3; n < 40; n++) {
    const p = svc.arenaPool(n, 201, 1234, [3333, 3333, 3334]),
      a = svc.allocateArenaPrizes(
        Array.from({ length: n }, (_, i) => ({ id: i + 1, points: 1 })),
        p.amounts,
      );
    assert.equal(
      a.reduce((s, e) => s + e.payoutCents, 0),
      p.net,
    );
    assert.ok(a.every((e) => e.rank === 1));
    assert.ok(
      Math.max(...a.map((e) => e.payoutCents)) -
        Math.min(...a.map((e) => e.payoutCents)) <=
        1,
    );
  }
  const a = svc.allocateArenaPrizes(
    [
      { id: 1, points: 4 },
      { id: 2, points: 4 },
      { id: 3, points: 3 },
    ],
    [50, 30, 20],
  );
  assert.deepEqual(
    a.map((e) => [e.rank, e.payoutCents]),
    [
      [1, 40],
      [1, 40],
      [3, 20],
    ],
  );
});
test("admin validation, publishing, reference teams and shared order; drafts are private and published rules freeze", async () => {
  const app = createApp(),
    body = {
      name: "Test draft",
      entryFee: 20,
      feePercent: 10,
      prizePercentages: [50, 30, 20],
      fixtures: [{ fixtureId: 1 }],
    };
  await request(app).post("/api/admin/arenas").send(body).expect(401);
  const { id, d, input } = await setup(3);
  assert.equal(d.fixtures.length, 3);
  assert.equal(d.fixtures[1].referenceTeamId, teams[3]);
  assert.deepEqual(
    d.fixtures.map((f) => f.fixtureId),
    input.fixtures.map((f) => f.fixtureId),
  );
  await assert.rejects(svc.updateArena(admin, id, input), /Published/);
  await assert.rejects(svc.publishArena(admin, id), /drafts/);
  const { id: draft } = await svc.createArena(admin, {
    ...input,
    name: "Private draft",
  });
  await request(app)
    .get("/api/arenas/" + draft)
    .expect(404);
  const login = await request(app)
    .post("/api/auth/login")
    .send({ identifier: "admin", password: "Admin123!" })
    .expect(200);
  await request(app)
    .post("/api/admin/arenas")
    .set("Authorization", "Bearer " + login.body.token)
    .send({ ...input, prizePercentages: [50, 30, 19] })
    .expect(400);
  await request(app)
    .post("/api/admin/arenas")
    .set("Authorization", "Bearer " + login.body.token)
    .send({ ...input, entryFee: 1.001 })
    .expect(400);
  await assert.rejects(
    svc.createArena(admin, {
      ...input,
      fixtures: [
        { fixtureId: d.fixtures[0].fixtureId, referenceTeamId: teams[1] },
      ],
    }),
    /team playing/,
  );
});
test("complete slips, duplicate requests and concurrent entries debit one escrow per player; private picks stay private", async () => {
  const { id, d } = await setup(),
    before = await balance(users[0]);
  await assert.rejects(
    svc.joinArena(users[0], id, slip(d).slice(0, 1)),
    /every match/,
  );
  assert.deepEqual(await balance(users[0]), before);
  await assert.rejects(
    svc.joinArena(users[0], id, slip(d, ["OTHER"])),
    /every match/,
  );
  await Promise.all([
    svc.joinArena(users[0], id, slip(d)),
    svc.joinArena(users[0], id, slip(d)),
  ]);
  await Promise.all([
    svc.joinArena(users[1], id, slip(d)),
    svc.joinArena(users[2], id, slip(d)),
  ]);
  const after = await balance(users[0]);
  assert.equal(Number(after.available), Number(before.available) - 20);
  assert.equal(Number(after.locked), Number(before.locked) + 20);
  const current = await svc.arenaDetail(id, users[0]);
  assert.equal(current.arena.participants, 3);
  assert.equal(current.arena.grossPool, 60);
  assert.equal(current.arena.prizePool, 54);
  assert.equal(current.myEntry.predictions.length, 2);
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) AS n FROM transactions WHERE arena_id=? AND type='ARENA_ENTRY'",
        [id],
      )
    ).n,
    3,
  );
  await assert.rejects(
    svc.participantSlip(id, current.myEntry.id, users[1]),
    /private/,
  );
  assert.equal(
    (await svc.participantSlip(id, current.myEntry.id, users[0])).predictions
      .length,
    2,
  );
  await svc.editArenaSlip(users[0], id, slip(d, ["DRAW", "LOSS"]));
  assert.equal(
    (await svc.arenaDetail(id, users[0])).myEntry.predictions[0].pick,
    "DRAW",
  );
  assert.deepEqual(await balance(users[0]), after);
  await close(id);
  await assert.rejects(svc.joinArena(users[3], id, slip(d)), /closed/);
  await assert.rejects(svc.editArenaSlip(users[0], id, slip(d)), /locked/);
  assert.equal(
    (await svc.participantSlip(id, current.myEntry.id, users[1])).predictions
      .length,
    2,
  );
});
test("insufficient funds roll back entries and wallet ledger", async () => {
  const { id, d } = await setup(1, { entryFee: 1000 }),
    b = await balance(users[6]);
  await assert.rejects(svc.joinArena(users[6], id, slip(d)), /Insufficient/);
  assert.deepEqual(await balance(users[6]), b);
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) AS n FROM fantasy_arena_entries WHERE arena_id=?",
        [id],
      )
    ).n,
    0,
  );
});
test("a request waiting for a wallet lock cannot confirm after kickoff; no deduction survives", async () => {
  const { id, d } = await setup(1);
  const b = await balance(users[6]);
  await query(
    "UPDATE fantasy_arenas SET deadline=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 2 SECOND) WHERE id=?",
    [id],
  );
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  await conn.query("SELECT id FROM wallets WHERE user_id=? FOR UPDATE", [
    users[6],
  ]);
  const pending = svc.joinArena(users[6], id, slip(d));
  const rejection = assert.rejects(pending, /closed/);
  await new Promise((r) => setTimeout(r, 2500));
  await conn.commit();
  conn.release();
  await rejection;
  assert.deepEqual(await balance(users[6]), b);
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) AS n FROM fantasy_arena_entries WHERE arena_id=?",
        [id],
      )
    ).n,
    0,
  );
});
test("too few participants cancel and refund in full exactly once, with no platform fee", async () => {
  const { id, d } = await setup(1),
    b = await balance(users[6]);
  await svc.joinArena(users[6], id, slip(d));
  await close(id);
  await svc.advanceArena(id);
  assert.deepEqual(await balance(users[6]), b);
  const a = await svc.arenaDetail(id, users[6]);
  assert.equal(a.arena.status, "CANCELLED");
  assert.equal(a.arena.platformFee, 0);
  assert.equal(a.arena.prizePool, 0);
  assert.equal(a.settlement.kind, "REFUND");
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) AS n FROM transactions WHERE arena_id=? AND type='ARENA_REFUND'",
        [id],
      )
    ).n,
    1,
  );
});
test("reference-team scoring, draws, provisional ranks and final idempotent tied payouts", async () => {
  const { id, d } = await setup(2);
  const before = await Promise.all(users.slice(3, 6).map(balance));
  await svc.joinArena(users[3], id, slip(d, ["WIN", "DRAW"]));
  await svc.joinArena(users[4], id, slip(d, ["WIN", "DRAW"]));
  await svc.joinArena(users[5], id, slip(d, ["LOSS", "DRAW"]));
  await close(id);
  await query(
    "UPDATE football_fixtures SET status='FINISHED',kickoff_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR),home_score=2,away_score=0 WHERE id=?",
    [d.fixtures[0].fixtureId],
  );
  await svc.advanceArena(id);
  const live = await svc.arenaLeaderboard(id, { userId: users[3] });
  assert.equal(live.provisional, true);
  assert.equal(live.myRank.points, 1);
  assert.equal(live.myRank.remaining, 1);
  await finish(d, [
    [2, 0],
    [1, 1],
  ]);
  await Promise.all([svc.advanceArena(id), svc.advanceArena(id)]);
  const final = await svc.arenaDetail(id, users[3]);
  assert.equal(final.arena.status, "COMPLETED");
  const ranks = await svc.arenaLeaderboard(id);
  assert.deepEqual(
    ranks.rows.map((e) => e.position),
    [1, 1, 3],
  );
  assert.deepEqual(
    ranks.rows.map((e) => e.points),
    [2, 2, 1],
  );
  assert.equal(
    ranks.rows.reduce((s, e) => s + e.payout, 0),
    54,
  );
  assert.equal(Number(final.settlement.fee_cents), 600);
  for (let i = 0; i < 3; i++) {
    const b = await balance(users[i + 3]),
      e = ranks.rows.find((e) => e.username === "arena-player-" + (i + 3));
    assert.equal(
      Number(b.available),
      Number(before[i].available) - 20 + e.payout,
    );
    assert.equal(Number(b.locked), Number(before[i].locked));
  }
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) AS n FROM fantasy_arena_settlements WHERE arena_id=?",
        [id],
      )
    ).n,
    1,
  );
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) AS n FROM transactions WHERE arena_id=? AND type='ARENA_REWARD'",
        [id],
      )
    ).n,
    3,
  );
  assert.equal(
    svc.referenceOutcome({
      home_score: 3,
      away_score: 1,
      home_team_id: teams[0],
      reference_team_id: teams[2],
    }),
    "LOSS",
  );
});
test("void, postponed and unresolved fixtures: no premature settlement; all void fully refunds", async () => {
  const { id, d } = await setup(2),
    before = await Promise.all(users.slice(3, 6).map(balance));
  for (const u of users.slice(3, 6)) await svc.joinArena(u, id, slip(d));
  await close(id);
  await query("UPDATE football_fixtures SET status='POSTPONED' WHERE id=?", [
    d.fixtures[0].fixtureId,
  ]);
  await query("UPDATE football_fixtures SET status='ABANDONED' WHERE id=?", [
    d.fixtures[1].fixtureId,
  ]);
  await svc.advanceArena(id);
  assert.equal((await svc.arenaDetail(id)).arena.status, "LIVE");
  await query(
    "UPDATE fantasy_arena_fixtures SET resolution_deadline=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE arena_id=?",
    [id],
  );
  await svc.advanceArena(id);
  const a = await svc.arenaDetail(id);
  assert.equal(a.arena.status, "CANCELLED");
  assert.equal(a.settlement.kind, "REFUND");
  for (let i = 0; i < 3; i++)
    assert.deepEqual(await balance(users[i + 3]), before[i]);
});
test("earlier kickoffs lock immediately; later kickoffs never extend or reopen published entries", async () => {
  const { id, d } = await setup(1),
    original = new Date(d.arena.deadline).getTime();
  await query(
    "UPDATE football_fixtures SET kickoff_at=DATE_ADD(kickoff_at,INTERVAL 1 DAY) WHERE id=?",
    [d.fixtures[0].fixtureId],
  );
  await svc.advanceArena(id);
  assert.equal(
    new Date((await svc.arenaDetail(id)).arena.deadline).getTime(),
    original,
  );
  for (const u of users.slice(3, 6)) await svc.joinArena(u, id, slip(d));
  await query(
    "UPDATE football_fixtures SET kickoff_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE id=?",
    [d.fixtures[0].fixtureId],
  );
  await svc.advanceArena(id);
  assert.equal((await svc.arenaDetail(id)).arena.status, "LIVE");
  await query(
    "UPDATE football_fixtures SET kickoff_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 3 DAY) WHERE id=?",
    [d.fixtures[0].fixtureId],
  );
  await assert.rejects(svc.joinArena(users[6], id, slip(d)), /closed/);
});
test("cancelled open arenas refund and auditable ledger links remain separate from 1v1 matches", async () => {
  const { id, d } = await setup(1),
    b = await balance(users[6]);
  await svc.joinArena(users[6], id, slip(d));
  await svc.cancelArena(admin, id, "Cancelled by administrator for testing.");
  await svc.cancelArena(admin, id, "Safe duplicate cancel.");
  assert.deepEqual(await balance(users[6]), b);
  const tx = await query(
    "SELECT match_id,arena_id FROM transactions WHERE arena_id=?",
    [id],
  );
  assert.equal(tx.length, 2);
  assert.ok(tx.every((t) => t.match_id === null && t.arena_id === id));
  assert.ok(
    (
      await queryOne(
        "SELECT COUNT(*) AS n FROM audit_events WHERE entity_type='ARENA' AND entity_id=?",
        [String(id)],
      )
    ).n >= 3,
  );
});
