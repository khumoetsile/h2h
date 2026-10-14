import { query, queryOne, withTransaction } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";
import { arenaMovement } from "../services/walletService.js";
import { recordAudit } from "../services/auditService.js";
import { emitAll } from "../realtime.js";
import { fromCents } from "../utils/money.js";
import { notify } from "../services/notificationService.js";
const terminal = (a) => ["COMPLETED", "CANCELLED"].includes(a.status);
const clock = (tx) => tx.one("SELECT UTC_TIMESTAMP(3) AS now");
const audit = (tx, a, action, metadata = {}, actorUserId = null) =>
  recordAudit(tx, {
    actorType: actorUserId ? "ADMIN" : "SYSTEM",
    actorUserId,
    action,
    entityType: "ARENA",
    entityId: a.id,
    metadata,
  });
function changed(tx, id, arena = null) {
  const snapshot = arena ? view(arena) : null;
  tx.arenaUpdates ||= new Map();
  const first = !tx.arenaUpdates.has(id);
  tx.arenaUpdates.set(id, { arenaId: id, arena: snapshot });
  if (first)
    tx.afterCommit(() => emitAll("arena:update", tx.arenaUpdates.get(id)));
}
export function arenaPool(
  count,
  entryCents,
  feeBps,
  shares = [5000, 3000, 2000],
) {
  const gross = BigInt(count) * BigInt(entryCents);
  if (gross > BigInt(Number.MAX_SAFE_INTEGER))
    throw conflict(
      "POOL_RANGE",
      "This prize pool exceeds the supported accounting range.",
    );
  const fee = Number((gross * BigInt(feeBps) + 5000n) / 10000n),
    net = Number(gross) - fee;
  const amounts = shares.map((b) => Number((BigInt(net) * BigInt(b)) / 10000n));
  let left = net - amounts.reduce((s, n) => s + n, 0);
  const remainder = shares
    .map((b, i) => ({ i, n: (BigInt(net) * BigInt(b)) % 10000n }))
    .sort((a, b) => (a.n === b.n ? a.i - b.i : a.n > b.n ? -1 : 1));
  for (const r of remainder) {
    if (!left) break;
    amounts[r.i]++;
    left--;
  }
  return { gross, fee, net, amounts };
}
export function allocateArenaPrizes(entries, amounts) {
  const sorted = entries
      .slice()
      .sort((a, b) => b.points - a.points || a.id - b.id),
    alloc = [];
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].points === sorted[start].points)
      end++;
    const pot = amounts
        .slice(start, Math.min(end, 3))
        .reduce((s, n) => s + n, 0),
      each = Math.floor(pot / (end - start)),
      extra = pot % (end - start);
    for (let i = start; i < end; i++)
      alloc.push({
        ...sorted[i],
        rank: start + 1,
        payoutCents: each + (i - start < extra ? 1 : 0),
      });
    start = end;
  }
  return alloc;
}
function poolFor(a, count = Number(a.participant_count)) {
  return arenaPool(count, a.entry_cents, a.fee_bps, [
    a.first_bps,
    a.second_bps,
    a.third_bps,
  ]);
}
function view(a) {
  const p =
    a.status === "CANCELLED"
      ? { gross: BigInt(a.gross_cents), fee: 0, net: 0, amounts: [0, 0, 0] }
      : poolFor(a);
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    status: a.status,
    entryFee: fromCents(a.entry_cents),
    feePercent: a.fee_bps / 100,
    prizePercentages: [a.first_bps, a.second_bps, a.third_bps].map(
      (n) => n / 100,
    ),
    deadline: a.deadline,
    lockedAt: a.locked_at,
    completedAt: a.completed_at,
    participants: Number(a.participant_count),
    fixtureCount: Number(a.fixture_count || 0),
    grossPool: fromCents(Number(p.gross)),
    platformFee: fromCents(p.fee),
    prizePool: fromCents(p.net),
    prizes: p.amounts.map(fromCents),
    cancellationReason: a.cancellation_reason,
    mine: !!a.mine,
    isDemo: true,
  };
}
const arenaRow = async (tx, id) => {
  const a = await tx.one("SELECT * FROM fantasy_arenas WHERE id=? FOR UPDATE", [
    id,
  ]);
  if (!a) throw notFound("Arena not found.");
  return a;
};
async function configured(tx, id, lock = false) {
  return tx.q(
    `SELECT af.*,c.is_enabled AS competition_enabled,f.status AS fixture_status,f.kickoff_at,f.is_simulated,f.provider,f.home_score,f.away_score,f.research_eligible,f.score_duration,f.home_team_id AS current_home,f.away_team_id AS current_away FROM fantasy_arena_fixtures af JOIN football_fixtures f ON f.id=af.fixture_id JOIN football_competitions c ON c.id=f.competition_id WHERE af.arena_id=? ORDER BY f.id ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
}
async function setPool(tx, a, count) {
  const p = poolFor(a, count);
  await tx.q(
    "UPDATE fantasy_arenas SET participant_count=?,gross_cents=?,fee_cents=?,net_cents=?,first_cents=?,second_cents=?,third_cents=? WHERE id=?",
    [count, String(p.gross), p.fee, p.net, ...p.amounts, a.id],
  );
  Object.assign(a, {
    participant_count: count,
    gross_cents: Number(p.gross),
    fee_cents: p.fee,
    net_cents: p.net,
    first_cents: p.amounts[0],
    second_cents: p.amounts[1],
    third_cents: p.amounts[2],
  });
}
async function cancelTx(tx, a, reason, actor = null) {
  if (terminal(a)) return;
  const entries = await tx.q(
    "SELECT user_id FROM fantasy_arena_entries WHERE arena_id=? ORDER BY user_id",
    [a.id],
  );
  for (const e of entries) {
    await arenaMovement(tx, e.user_id, a, "REFUND");
    await notify(tx, e.user_id, {
      type: "ARENA_REFUND",
      title: "Fantasy Arena refunded",
      message: `${a.name}: your P${fromCents(a.entry_cents).toFixed(2)} demo entry was returned in full. No fee charged.`,
      link: `/arena/${a.id}`,
    });
  }
  await tx.q(
    "INSERT INTO fantasy_arena_settlements(arena_id,kind,gross_cents,fee_cents,paid_cents,audit) VALUES(?,'REFUND',?,0,?,?)",
    [
      a.id,
      a.gross_cents,
      a.gross_cents,
      JSON.stringify({ reason, participants: entries.length }),
    ],
  );
  await tx.q(
    "UPDATE fantasy_arenas SET status='CANCELLED',fee_cents=0,net_cents=0,first_cents=0,second_cents=0,third_cents=0,cancellation_reason=?,completed_at=UTC_TIMESTAMP() WHERE id=?",
    [reason, a.id],
  );
  await audit(
    tx,
    a,
    "ARENA_CANCELLED",
    { reason, refundedCents: Number(a.gross_cents) },
    actor,
  );
  a.status = "CANCELLED";
  changed(tx, a.id);
}
async function lockTx(tx, a, fixtures, now) {
  if (a.status !== "OPEN") return;
  const invalid = fixtures.some(
    (f) =>
      f.is_simulated ||
      f.provider === "mock" ||
      f.home_team_id !== f.current_home ||
      f.away_team_id !== f.current_away ||
      ["CANCELLED", "ABANDONED", "POSTPONED", "SUSPENDED"].includes(
        f.fixture_status,
      ),
  );

  const deadline = new Date(
    Math.min(
      new Date(a.deadline).getTime(),
      ...fixtures.map((f) => new Date(f.kickoff_at).getTime()),
    ),
  );
  if (deadline.getTime() !== new Date(a.deadline).getTime()) {
    await tx.q("UPDATE fantasy_arenas SET deadline=? WHERE id=?", [
      deadline,
      a.id,
    ]);
    a.deadline = deadline;
  }
  if (
    new Date(now) < deadline &&
    !fixtures.some((f) => ["LIVE", "FINISHED"].includes(f.fixture_status))
  ) {
    if (invalid)
      await cancelTx(
        tx,
        a,
        "A fixture changed or became unavailable before locking.",
      );
    return;
  }
  const { n } = await tx.one(
    "SELECT COUNT(*) AS n FROM fantasy_arena_entries WHERE arena_id=?",
    [a.id],
  );
  await setPool(tx, a, Number(n));
  if (n < 3) {
    await cancelTx(tx, a, "Fewer than three players joined before closing.");
    return;
  }
  await tx.q(
    "UPDATE fantasy_arenas SET status='LOCKED',locked_at=UTC_TIMESTAMP() WHERE id=?",
    [a.id],
  );
  a.status = "LOCKED";
  await audit(tx, a, "ARENA_LOCKED", {
    participants: Number(n),
    netCents: a.net_cents,
    deadline: a.deadline,
  });
  changed(tx, a.id);
}
export async function createArena(adminId, input) {
  return withTransaction(async (tx) => {
    const r = await tx.q(
      "INSERT INTO fantasy_arenas(name,description,entry_cents,fee_bps,first_bps,second_bps,third_bps,created_by) VALUES(?,?,?,?,?,?,?,?)",
      [
        input.name,
        input.description || null,
        Math.round(input.entryFee * 100),
        Math.round(input.feePercent * 100),
        ...input.prizePercentages.map((n) => Math.round(n * 100)),
        adminId,
      ],
    );
    await replaceFixtures(tx, r.insertId, input.fixtures);
    await audit(
      tx,
      { id: r.insertId },
      "ARENA_CREATED",
      { fixtureCount: input.fixtures.length },
      adminId,
    );
    return { id: r.insertId };
  });
}
async function replaceFixtures(tx, id, selected) {
  const ids = selected.map((f) => f.fixtureId);
  if (new Set(ids).size !== ids.length)
    throw badRequest("DUPLICATE_FIXTURE", "Choose each match once.");
  const fixtures = await tx.q(
    "SELECT f.*,c.is_enabled FROM football_fixtures f JOIN football_competitions c ON c.id=f.competition_id WHERE f.id IN (?) ORDER BY f.id FOR UPDATE",
    [ids],
  );
  const { now } = await clock(tx);
  if (
    fixtures.length !== ids.length ||
    fixtures.some(
      (f) =>
        !f.is_enabled ||
        f.is_simulated ||
        f.provider === "mock" ||
        f.status !== "SCHEDULED" ||
        new Date(f.kickoff_at) <= new Date(now),
    )
  )
    throw badRequest("UPCOMING_REQUIRED", "Choose real upcoming matches.");
  await tx.q("DELETE FROM fantasy_arena_fixtures WHERE arena_id=?", [id]);
  for (let i = 0; i < selected.length; i++) {
    const f = fixtures.find((f) => f.id === selected[i].fixtureId),
      ref = selected[i].referenceTeamId || f.home_team_id;
    if (![f.home_team_id, f.away_team_id].includes(ref))
      throw badRequest(
        "REFERENCE_TEAM",
        "Choose a team playing in that match.",
      );
    await tx.q(
      "INSERT INTO fantasy_arena_fixtures(arena_id,fixture_id,position,reference_team_id,home_team_id,away_team_id,scheduled_kickoff,resolution_deadline) VALUES(?,?,?,?,?,?,?,DATE_ADD(?,INTERVAL 72 HOUR))",
      [
        id,
        f.id,
        i + 1,
        ref,
        f.home_team_id,
        f.away_team_id,
        f.kickoff_at,
        f.kickoff_at,
      ],
    );
  }
  await tx.q("UPDATE fantasy_arenas SET deadline=? WHERE id=?", [
    new Date(
      Math.min(...fixtures.map((f) => new Date(f.kickoff_at).getTime())),
    ),
    id,
  ]);
}
export async function updateArena(adminId, id, input) {
  return withTransaction(async (tx) => {
    const a = await arenaRow(tx, id);
    if (a.status !== "DRAFT" || a.participant_count)
      throw conflict(
        "RULES_FROZEN",
        "Published arena rules and matches cannot be changed.",
      );
    await replaceFixtures(tx, id, input.fixtures);
    await tx.q(
      "UPDATE fantasy_arenas SET name=?,description=?,entry_cents=?,fee_bps=?,first_bps=?,second_bps=?,third_bps=? WHERE id=?",
      [
        input.name,
        input.description || null,
        Math.round(input.entryFee * 100),
        Math.round(input.feePercent * 100),
        ...input.prizePercentages.map((n) => Math.round(n * 100)),
        id,
      ],
    );
    await audit(tx, a, "ARENA_UPDATED", {}, adminId);
    return { id };
  });
}
export async function publishArena(adminId, id) {
  return withTransaction(async (tx) => {
    const a = await arenaRow(tx, id);
    if (a.status !== "DRAFT")
      throw conflict("INVALID_STATE", "Only drafts can be published.");
    const f = await configured(tx, id, true),
      { now } = await clock(tx);
    if (
      !f.length ||
      f.some(
        (f) =>
          !f.competition_enabled ||
          f.is_simulated ||
          f.provider === "mock" ||
          f.fixture_status !== "SCHEDULED" ||
          f.home_team_id !== f.current_home ||
          f.away_team_id !== f.current_away ||
          new Date(f.kickoff_at) <= new Date(now),
      )
    )
      throw conflict(
        "FIXTURES_CHANGED",
        "Review the upcoming fixtures before publishing.",
      );
    await tx.q(
      "UPDATE fantasy_arena_fixtures af JOIN football_fixtures f ON f.id=af.fixture_id SET af.scheduled_kickoff=f.kickoff_at,af.resolution_deadline=DATE_ADD(f.kickoff_at,INTERVAL 72 HOUR) WHERE af.arena_id=?",
      [id],
    );
    await tx.q(
      "UPDATE fantasy_arenas SET status='OPEN',published_at=UTC_TIMESTAMP(),deadline=? WHERE id=?",
      [
        new Date(Math.min(...f.map((f) => new Date(f.kickoff_at).getTime()))),
        id,
      ],
    );
    await audit(tx, a, "ARENA_PUBLISHED", {}, adminId);
    changed(tx, id);
    return { id };
  });
}
export async function cancelArena(adminId, id, reason) {
  await advanceArena(id);
  return withTransaction(async (tx) => {
    const a = await arenaRow(tx, id);
    if (a.status === "CANCELLED") return { id };
    if (!["DRAFT", "OPEN"].includes(a.status))
      throw conflict(
        "INVALID_STATE",
        "An arena cannot be manually cancelled after locking.",
      );
    const f = await configured(tx, id, true),
      { now } = await clock(tx);
    await lockTx(tx, a, f, now);
    if (!["DRAFT", "OPEN", "CANCELLED"].includes(a.status))
      throw conflict("ARENA_CLOSED", "This arena has already locked.");
    await cancelTx(tx, a, reason, adminId);
    return { id };
  });
}
function validateSlip(fixtures, predictions) {
  if (
    predictions.length !== fixtures.length ||
    new Set(predictions.map((p) => p.arenaFixtureId)).size !==
      fixtures.length ||
    predictions.some(
      (p) =>
        !fixtures.some((f) => f.id === p.arenaFixtureId) ||
        !["WIN", "DRAW", "LOSS"].includes(p.pick),
    )
  )
    throw badRequest(
      "COMPLETE_SLIP",
      "Choose Win, Draw or Loss for every match.",
    );
}
export async function joinArena(userId, id, predictions) {
  await advanceArena(id);
  return withTransaction(async (tx) => {
    const a = await arenaRow(tx, id),
      user = await tx.one("SELECT role,is_bot,status FROM users WHERE id=?", [
        userId,
      ]);
    if (
      !user ||
      user.role !== "PLAYER" ||
      user.is_bot ||
      user.status !== "ACTIVE"
    )
      throw forbidden("Only active player accounts can enter.");
    const existing = await tx.one(
      "SELECT id FROM fantasy_arena_entries WHERE arena_id=? AND user_id=?",
      [id, userId],
    );
    if (existing) return { entryId: existing.id, alreadyJoined: true };
    const fixtures = await configured(tx, id, true),
      { now } = await clock(tx);
    if (
      a.status !== "OPEN" ||
      new Date(a.deadline) <= new Date(now) ||
      fixtures.some(
        (f) =>
          f.fixture_status !== "SCHEDULED" ||
          new Date(f.kickoff_at) <= new Date(now) ||
          f.home_team_id !== f.current_home ||
          f.away_team_id !== f.current_away,
      )
    )
      throw conflict("ARENA_CLOSED", "Entries are closed for this arena.");
    validateSlip(fixtures, predictions);
    await arenaMovement(tx, userId, a, "ENTRY");
    const e = await tx.q(
      "INSERT INTO fantasy_arena_entries(arena_id,user_id,remaining) SELECT id,?,? FROM fantasy_arenas WHERE id=? AND status='OPEN' AND deadline>UTC_TIMESTAMP(3)",
      [userId, fixtures.length, id],
    );
    if (!e.affectedRows)
      throw conflict(
        "ARENA_CLOSED",
        "Entries closed while confirming. Your demo funds were not charged.",
      );
    for (const p of predictions)
      await tx.q(
        "INSERT INTO fantasy_arena_predictions(entry_id,arena_fixture_id,pick) VALUES(?,?,?)",
        [e.insertId, p.arenaFixtureId, p.pick],
      );
    await setPool(tx, a, Number(a.participant_count) + 1);
    await recordAudit(tx, {
      actorType: "PLAYER",
      actorUserId: userId,
      action: "ARENA_ENTERED",
      entityType: "ARENA",
      entityId: id,
      metadata: { entryId: e.insertId, entryCents: a.entry_cents },
    });
    a.fixture_count = fixtures.length;
    changed(tx, id, a);
    return { entryId: e.insertId, alreadyJoined: false };
  });
}
export async function editArenaSlip(userId, id, predictions) {
  await advanceArena(id);
  return withTransaction(async (tx) => {
    const a = await arenaRow(tx, id),
      fixtures = await configured(tx, id, true),
      { now } = await clock(tx);
    if (
      a.status !== "OPEN" ||
      new Date(a.deadline) <= new Date(now) ||
      fixtures.some(
        (f) =>
          f.fixture_status !== "SCHEDULED" ||
          new Date(f.kickoff_at) <= new Date(now),
      )
    )
      throw conflict("ARENA_CLOSED", "Predictions are locked.");
    const e = await tx.one(
      "SELECT id FROM fantasy_arena_entries WHERE arena_id=? AND user_id=?",
      [id, userId],
    );
    if (!e) throw notFound("Your entry was not found.");
    validateSlip(fixtures, predictions);
    const r = await tx.q(
      "UPDATE fantasy_arena_entries SET updated_at=UTC_TIMESTAMP() WHERE id=? AND (SELECT deadline FROM fantasy_arenas WHERE id=?)>UTC_TIMESTAMP(3)",
      [e.id, id],
    );
    if (!r.affectedRows)
      throw conflict("ARENA_CLOSED", "Predictions are locked.");
    for (const p of predictions)
      await tx.q(
        "UPDATE fantasy_arena_predictions SET pick=? WHERE entry_id=? AND arena_fixture_id=?",
        [p.pick, e.id, p.arenaFixtureId],
      );
    await recordAudit(tx, {
      actorType: "PLAYER",
      actorUserId: userId,
      action: "ARENA_SLIP_CHANGED",
      entityType: "ARENA",
      entityId: id,
    });
    a.fixture_count = fixtures.length;
    changed(tx, id, a);
    return { saved: true };
  });
}
export function referenceOutcome(f) {
  if (f.home_score === f.away_score) return "DRAW";
  const homeWon = f.home_score > f.away_score;
  return homeWon === (f.reference_team_id === f.home_team_id) ? "WIN" : "LOSS";
}
export async function advanceArena(id) {
  return withTransaction(async (tx) => {
    const a = await arenaRow(tx, id);
    if (a.status === "DRAFT" || terminal(a)) return;
    const fixtures = await configured(tx, id, true),
      { now } = await clock(tx);
    await lockTx(tx, a, fixtures, now);
    if (a.status === "OPEN" || terminal(a)) return;
    if (a.status === "LOCKED") {
      await tx.q("UPDATE fantasy_arenas SET status='LIVE' WHERE id=?", [id]);
      a.status = "LIVE";
    }
    for (const f of fixtures) {
      let actual = null,
        reason = null;
      if (
        f.is_simulated ||
        f.provider === "mock" ||
        f.home_team_id !== f.current_home ||
        f.away_team_id !== f.current_away
      ) {
        actual = "VOID";
        reason = "Fixture identity is no longer valid.";
      } else if (["CANCELLED", "ABANDONED"].includes(f.fixture_status)) {
        actual = "VOID";
        reason = "Match cancelled or abandoned.";
      } else if (
        f.fixture_status === "FINISHED" &&
        new Date(f.kickoff_at) <= new Date(now)
      ) {
        actual =
          f.research_eligible &&
          f.score_duration === "REGULAR" &&
          Number.isInteger(f.home_score) &&
          f.home_score >= 0 &&
          Number.isInteger(f.away_score) &&
          f.away_score >= 0
            ? referenceOutcome(f)
            : null;
        if (
          !actual &&
          ["EXTRA_TIME", "PENALTIES", "PENALTY_SHOOTOUT"].includes(
            f.score_duration,
          )
        ) {
          actual = "VOID";
          reason = "A verified regulation-time result was not supplied.";
        } else if (
          !actual &&
          new Date(now) >= new Date(f.resolution_deadline)
        ) {
          actual = "VOID";
          reason =
            "No verified result within 72 hours of the original kickoff.";
        } else reason = actual ? "Verified final result." : null;
      } else if (new Date(now) >= new Date(f.resolution_deadline)) {
        actual = "VOID";
        reason = "No verified result within 72 hours of the original kickoff.";
      }
      if (actual !== f.actual_result) {
        await tx.q(
          "UPDATE fantasy_arena_fixtures SET actual_result=?,resolved_at=?,resolution_reason=? WHERE id=?",
          [actual, actual ? now : null, reason, f.id],
        );
        f.actual_result = actual;
        f.resolution_reason = reason;
        changed(tx, id);
      }
    }
    await tx.q(
      `UPDATE fantasy_arena_entries e JOIN (SELECT p.entry_id,SUM(CASE WHEN af.actual_result=p.pick THEN 1 ELSE 0 END) AS points,SUM(CASE WHEN af.actual_result IN ('WIN','DRAW','LOSS') AND af.actual_result<>p.pick THEN 1 ELSE 0 END) AS incorrect,SUM(af.actual_result IS NULL) AS remaining FROM fantasy_arena_predictions p JOIN fantasy_arena_fixtures af ON af.id=p.arena_fixture_id WHERE af.arena_id=? GROUP BY p.entry_id) s ON s.entry_id=e.id SET e.points=s.points,e.incorrect=s.incorrect,e.remaining=s.remaining`,
      [id],
    );
    if (fixtures.some((f) => !f.actual_result)) return;
    if (fixtures.every((f) => f.actual_result === "VOID")) {
      await cancelTx(tx, a, "All fixtures were voided.");
      return;
    }
    await tx.q("UPDATE fantasy_arenas SET status='SETTLING' WHERE id=?", [id]);
    const entries = await tx.q(
      "SELECT id,user_id,points FROM fantasy_arena_entries WHERE arena_id=? ORDER BY user_id",
      [id],
    );
    const allocated = allocateArenaPrizes(entries, [
      Number(a.first_cents),
      Number(a.second_cents),
      Number(a.third_cents),
    ]);
    const paid = allocated.reduce((s, e) => s + e.payoutCents, 0);
    if (paid !== Number(a.net_cents))
      throw conflict(
        "SETTLEMENT_MISMATCH",
        "Prize allocations did not reconcile.",
      );
    await tx.q(
      "INSERT INTO fantasy_arena_settlements(arena_id,kind,gross_cents,fee_cents,paid_cents,audit) VALUES(?,'PAYOUT',?,?,?,?)",
      [
        id,
        a.gross_cents,
        a.fee_cents,
        paid,
        JSON.stringify({
          participants: entries.length,
          fixtures: fixtures.map((f) => ({
            id: f.id,
            result: f.actual_result,
            reason: f.resolution_reason,
          })),
          prizes: [a.first_cents, a.second_cents, a.third_cents],
          tiePolicy:
            "Competition ranking; affected prize positions shared; remaining cents by entry ID.",
        }),
      ],
    );
    for (const e of allocated.slice().sort((a, b) => a.user_id - b.user_id)) {
      await arenaMovement(tx, e.user_id, a, "SETTLEMENT", e.payoutCents);
      await notify(tx, e.user_id, {
        type: "ARENA_RESULT",
        title: "Fantasy Arena complete",
        message: `${a.name}: ${e.points} points, rank ${e.rank}. ${e.payoutCents ? `P${fromCents(e.payoutCents).toFixed(2)} demo reward credited.` : "No prize this time."}`,
        link: `/arena/${id}`,
      });
      await tx.q(
        "UPDATE fantasy_arena_entries SET final_rank=?,payout_cents=? WHERE id=?",
        [e.rank, e.payoutCents, e.id],
      );
    }
    await tx.q(
      "UPDATE fantasy_arenas SET status='COMPLETED',completed_at=UTC_TIMESTAMP() WHERE id=?",
      [id],
    );
    await audit(tx, a, "ARENA_SETTLED", {
      participants: entries.length,
      feeCents: Number(a.fee_cents),
      paidCents: paid,
    });
    changed(tx, id);
  });
}
export async function sweepArenas() {
  const rows = await query(
    "SELECT id FROM fantasy_arenas WHERE status IN ('OPEN','LOCKED','LIVE','SETTLING') ORDER BY id",
  );
  for (const a of rows) {
    try {
      await advanceArena(a.id);
    } catch (err) {
      console.error("Arena lifecycle", a.id, err.message);
    }
  }
}
export async function listArenas({
  section = "open",
  userId = null,
  page = 1,
  pageSize = 20,
  admin = false,
} = {}) {
  const where = admin
    ? "1=1"
    : section === "mine"
      ? "EXISTS(SELECT 1 FROM fantasy_arena_entries e WHERE e.arena_id=a.id AND e.user_id=?)"
      : section === "completed"
        ? "a.status IN ('COMPLETED','CANCELLED')"
        : section === "live"
          ? "a.status IN ('LOCKED','LIVE','SETTLING')"
          : "a.status='OPEN' AND a.deadline>UTC_TIMESTAMP()";
  const publicWhere = admin
    ? where
    : `a.published_at IS NOT NULL AND (${where})`;
  const params = section === "mine" && !admin ? [userId || 0] : [];
  const total = await queryOne(
    `SELECT COUNT(*) AS n FROM fantasy_arenas a WHERE ${publicWhere}`,
    params,
  );
  const rows = await query(
    `SELECT a.*,(SELECT COUNT(*) FROM fantasy_arena_fixtures af WHERE af.arena_id=a.id) AS fixture_count,EXISTS(SELECT 1 FROM fantasy_arena_entries e WHERE e.arena_id=a.id AND e.user_id=?) AS mine FROM fantasy_arenas a WHERE ${publicWhere} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [userId || 0, ...params, pageSize, (page - 1) * pageSize],
  );
  return {
    arenas: rows.map(view),
    page,
    hasMore: page * pageSize < total.n,
    serverNow: new Date(),
  };
}
export async function arenaDetail(id, userId = null, admin = false) {
  await advanceArena(id);
  const a = await queryOne(
    "SELECT a.*,(SELECT COUNT(*) FROM fantasy_arena_fixtures af WHERE af.arena_id=a.id) AS fixture_count FROM fantasy_arenas a WHERE id=?",
    [id],
  );
  if (!a || (!a.published_at && !admin)) throw notFound("Arena not found.");
  const fixtures = await query(
    "SELECT af.*,f.status AS fixture_status,f.kickoff_at,f.home_score,f.away_score,h.name AS home_name,w.name AS away_name,r.name AS reference_name,c.name AS competition FROM fantasy_arena_fixtures af JOIN football_fixtures f ON f.id=af.fixture_id JOIN football_teams h ON h.id=af.home_team_id JOIN football_teams w ON w.id=af.away_team_id JOIN football_teams r ON r.id=af.reference_team_id JOIN football_competitions c ON c.id=f.competition_id WHERE af.arena_id=? ORDER BY af.position",
    [id],
  );
  const mine = userId
    ? await queryOne(
        "SELECT * FROM fantasy_arena_entries WHERE arena_id=? AND user_id=?",
        [id, userId],
      )
    : null;
  const picks = mine
    ? await query(
        "SELECT arena_fixture_id AS arenaFixtureId,pick FROM fantasy_arena_predictions WHERE entry_id=?",
        [mine.id],
      )
    : [];
  return {
    arena: { ...view(a), mine: !!mine },
    fixtures: fixtures.map((f) => ({
      id: f.id,
      fixtureId: f.fixture_id,
      homeTeamId: f.home_team_id,
      awayTeamId: f.away_team_id,
      homeTeam: f.home_name,
      awayTeam: f.away_name,
      referenceTeamId: f.reference_team_id,
      referenceTeam: f.reference_name,
      competition: f.competition,
      kickoffAt: f.kickoff_at,
      originalKickoffAt: f.scheduled_kickoff,
      status: f.fixture_status,
      result: f.actual_result,
      reason: f.resolution_reason,
      homeScore: f.home_score,
      awayScore: f.away_score,
    })),
    myEntry: mine
      ? {
          id: mine.id,
          points: mine.points,
          rank: mine.final_rank,
          payout: fromCents(mine.payout_cents),
          joinedAt: mine.joined_at,
          predictions: picks,
        }
      : null,
    settlement: terminal(a)
      ? await queryOne(
          "SELECT kind,gross_cents,fee_cents,paid_cents,created_at,audit FROM fantasy_arena_settlements WHERE arena_id=?",
          [id],
        )
      : null,
    serverNow: new Date(),
    rules: {
      minimumPlayers: 3,
      pointsPerCorrect: 1,
      ties: "Tied players share the affected top-three prize positions. Any leftover cents are assigned in entry order.",
      voids:
        "Cancelled or abandoned matches are void. Postponed or unresolved matches have 72 hours from original kickoff. All void: full refund.",
      reschedules:
        "An earlier kickoff closes entries earlier. Later kickoffs do not extend or reopen entries.",
      visibility: "Other players’ slips are revealed only after locking.",
      demoOnly: true,
    },
  };
}
export async function arenaLeaderboard(
  id,
  { page = 1, pageSize = 25, userId = null, admin = false } = {},
) {
  const a = await queryOne(
    "SELECT status,published_at FROM fantasy_arenas WHERE id=?",
    [id],
  );
  if (!a || (!admin && !a.published_at)) throw notFound("Arena not found.");
  const fields = `SELECT e.id,e.user_id,u.username,e.points,e.incorrect,e.remaining,e.payout_cents,e.final_rank,RANK() OVER(ORDER BY e.points DESC) AS position FROM fantasy_arena_entries e JOIN users u ON u.id=e.user_id WHERE e.arena_id=?`;
  const rows = await query(
    `SELECT * FROM (${fields}) ranked ORDER BY points DESC,id LIMIT ? OFFSET ?`,
    [id, pageSize, (page - 1) * pageSize],
  );
  const own = userId
    ? await queryOne(`SELECT * FROM (${fields}) ranked WHERE user_id=?`, [
        id,
        userId,
      ])
    : null;
  const { n } = await queryOne(
    "SELECT COUNT(*) AS n FROM fantasy_arena_entries WHERE arena_id=?",
    [id],
  );
  const map = (e) => ({
    entryId: e.id,
    username: e.username,
    points: e.points,
    correct: e.points,
    incorrect: e.incorrect,
    remaining: e.remaining,
    position: Number(e.final_rank || e.position),
    prizeEligible: Number(e.final_rank || e.position) <= 3,
    payout: fromCents(e.payout_cents),
    mine: e.user_id === userId,
  });
  return {
    rows: rows.map(map),
    myRank: own ? map(own) : null,
    hasMore: page * pageSize < n,
    page,
    provisional: !["COMPLETED", "CANCELLED"].includes(a.status),
  };
}
export async function participantSlip(
  id,
  entryId,
  userId = null,
  admin = false,
) {
  const a = await queryOne(
    "SELECT status,deadline,locked_at FROM fantasy_arenas WHERE id=?",
    [id],
  );
  const e = await queryOne(
    "SELECT id,user_id FROM fantasy_arena_entries WHERE arena_id=? AND id=?",
    [id, entryId],
  );
  if (!a || !e) throw notFound("Entry not found.");
  if (
    !admin &&
    e.user_id !== userId &&
    (a.status === "OPEN" ||
      a.status === "DRAFT" ||
      (a.status === "CANCELLED" && !a.locked_at))
  )
    throw forbidden(
      "Other players’ predictions are private until the arena locks.",
    );
  return {
    predictions: await query(
      "SELECT arena_fixture_id AS arenaFixtureId,pick FROM fantasy_arena_predictions WHERE entry_id=?",
      [entryId],
    ),
  };
}
export async function availableArenaFixtures(q = "") {
  return {
    fixtures: await query(
      "SELECT f.id,f.home_team_id AS homeTeamId,f.away_team_id AS awayTeamId,h.name AS homeTeam,a.name AS awayTeam,c.name AS competition,f.kickoff_at AS kickoffAt FROM football_fixtures f JOIN football_teams h ON h.id=f.home_team_id JOIN football_teams a ON a.id=f.away_team_id JOIN football_competitions c ON c.id=f.competition_id WHERE f.is_simulated=0 AND f.provider<>'mock' AND c.is_enabled=1 AND f.status='SCHEDULED' AND f.kickoff_at>UTC_TIMESTAMP() AND (h.name LIKE ? OR a.name LIKE ? OR c.name LIKE ?) ORDER BY f.kickoff_at LIMIT 100",
      Array(3).fill("%" + q.replace(/[\\%_]/g, "") + "%"),
    ),
  };
}
