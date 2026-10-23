import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateStats,
  verifiedOutcome,
  challengeDay,
  periodBounds,
  ACHIEVEMENTS,
} from "../src/football/dailyPredictionRules.js";
const c = (id, result = "WIN", extra = {}) => ({
  id,
  challenge_date: `2026-10-${String(id).padStart(2, "0")}`,
  slot: 1,
  status: result ? "RESOLVED" : "LOCKED",
  actual_result: result,
  ...extra,
});
const p = (id, pick = "WIN") => ({ challenge_id: id, pick });
test("first correct, consecutive successes, longest streak and incorrect reset", () => {
  const s = calculateStats(
    [c(1), c(2), c(3, "LOSS"), c(4)],
    [p(1), p(2), p(3), p(4)],
  );
  assert.equal(s.winningStreak, 1);
  assert.equal(s.bestWinningStreak, 2);
  assert.equal(s.participationStreak, 4);
  assert.equal(s.correct, 3);
  assert.equal(s.incorrect, 1);
  assert.equal(s.accuracy, 75);
});
test("missing an eligible challenge breaks both streaks but not accuracy denominator", () => {
  const s = calculateStats([c(1), c(2), c(3)], [p(1), p(3)]);
  assert.equal(s.winningStreak, 1);
  assert.equal(s.participationStreak, 1);
  assert.equal(s.eligible, 2);
});
test("void and unpublished days do not break streaks", () => {
  const s = calculateStats([c(1), c(2, "VOID"), c(4)], [p(1), p(4)]);
  assert.equal(s.winningStreak, 2);
  assert.equal(s.participationStreak, 2);
  assert.equal(s.eligible, 2);
});
test("out-of-order pending result is a barrier; resolving it replays challenge dates", () => {
  const rows = [c(3), c(1), c(2, null)];
  const picks = [p(1), p(2), p(3)];
  const s = calculateStats(rows, picks);
  assert.equal(s.winningStreak, 1);
  assert.equal(s.participationStreak, 3);
  rows[2].actual_result = "WIN";
  assert.equal(calculateStats(rows, picks).winningStreak, 3);
  rows[2].actual_result = "LOSS";
  assert.equal(calculateStats(rows, picks).winningStreak, 1);
});
test("unavailable day never resets a submitted pending prediction", () => {
  const s = calculateStats([c(1), c(2, null)], [p(1), p(2)]);
  assert.equal(s.winningStreak, 1);
  assert.equal(s.accuracy, 100);
});
test("missed unresolved challenge waits for verification before failure", () => {
  const s = calculateStats([c(1), c(2, null)], [p(1)]);
  assert.equal(s.winningStreak, 1);
  assert.equal(s.participationStreak, 1);
});
test("multiple challenges count one day and require all eligible picks", () => {
  const rows = [c(1), c(2, "WIN", { challenge_date: "2026-10-01", slot: 2 })];
  assert.equal(calculateStats(rows, [p(1), p(2)]).winningStreak, 1);
  assert.equal(calculateStats(rows, [p(1)]).winningStreak, 0);
});
test("accuracy excludes pending/void; last 7 and 30 use eligible predictions", () => {
  const rows = Array.from({ length: 31 }, (_, i) => c(i + 1));
  const picks = rows.map((r) => p(r.id, r.id > 24 ? "LOSS" : "WIN"));
  const s = calculateStats(
    [...rows, c(32, null), c(33, "VOID")],
    [...picks, p(32), p(33)],
  );
  assert.equal(s.eligible, 31);
  assert.equal(s.last7Accuracy, 0);
  assert.equal(s.last30Accuracy, 76.7);
  assert.equal(calculateStats([], []).accuracy, null);
});
test("calendar uses Botswana midnight and correct weekly/monthly boundaries", () => {
  assert.equal(challengeDay(new Date("2026-10-21T22:01:00Z")), "2026-10-22");
  assert.equal(challengeDay(new Date("2026-10-21T21:59:59Z")), "2026-10-21");
  assert.deepEqual(periodBounds("weekly", "2026-11-01"), [
    "2026-10-26",
    "2026-11-01",
  ]);
  assert.deepEqual(periodBounds("monthly", "2028-02-29"), [
    "2028-02-01",
    "2028-02-29",
  ]);
  assert.deepEqual(periodBounds("daily", "2026-10-21"), [
    "2026-10-21",
    "2026-10-21",
  ]);
  assert.throws(() => periodBounds("bad", "2026-10-21"));
});
const fixture = {
  status: "FINISHED",
  provider: "football-data",
  is_simulated: 0,
  home_team_id: 1,
  away_team_id: 2,
  home_score: 2,
  away_score: 1,
  kickoff_at: "2026-10-01T23:00:00Z",
  last_synced_at: "2026-10-02T01:00:00Z",
  score_duration: "REGULAR",
  research_eligible: 1,
};
const challenge = { home_team_id: 1, away_team_id: 2, reference_team_id: 1 };
test("verified reference team outcomes and after-midnight finish", () => {
  assert.equal(verifiedOutcome(fixture, challenge).outcome, "WIN");
  assert.equal(
    verifiedOutcome(fixture, { ...challenge, reference_team_id: 2 }).outcome,
    "LOSS",
  );
  assert.equal(
    verifiedOutcome({ ...fixture, away_score: 2 }, challenge).outcome,
    "DRAW",
  );
});
test("provider outage, missing scores, extra time and unverified fixtures remain pending", () => {
  for (const f of [
    { status: "LIVE" },
    { home_score: null },
    { score_duration: "EXTRA_TIME" },
    { research_eligible: 0 },
    { last_synced_at: null },
  ])
    assert.equal(verifiedOutcome({ ...fixture, ...f }, challenge), null);
});
test("postponed cancelled abandoned simulated or changed identities void safely", () => {
  for (const f of [
    { status: "POSTPONED" },
    { status: "CANCELLED" },
    { status: "ABANDONED" },
    { is_simulated: 1 },
    { provider: "mock" },
    { home_team_id: 3 },
  ])
    assert.equal(
      verifiedOutcome({ ...fixture, ...f }, challenge).outcome,
      "VOID",
    );
});
test("historical corrections rebuild totals, longest streak and qualifying achievements", () => {
  const rows = Array.from({ length: 5 }, (_, i) => c(i + 1));
  const picks = rows.map((r) => p(r.id));
  const before = calculateStats(rows, picks);
  assert.ok(ACHIEVEMENTS.find((a) => a[0] === "winning_5")[3](before));
  rows[2].actual_result = "LOSS";
  const after = calculateStats(rows, picks);
  assert.equal(after.correct, 4);
  assert.equal(after.bestWinningStreak, 2);
  assert.equal(after.winningStreak, 2);
  assert.equal(ACHIEVEMENTS.find((a) => a[0] === "winning_5")[3](after), false);
});
test("large history is deterministic and idempotent", () => {
  const rows = Array.from({ length: 500 }, (_, i) =>
    c(i + 1, "WIN", {
      challenge_date: new Date(Date.UTC(2025, 0, i + 1))
        .toISOString()
        .slice(0, 10),
    }),
  );
  const picks = rows.map((r) => p(r.id));
  const s = calculateStats(rows, picks);
  assert.equal(s.winningStreak, 500);
  assert.deepEqual(s, calculateStats([...rows].reverse(), picks));
});

test("future submissions cannot earn participation streak days before their challenge date", () => {
  const rows = [c(1), c(2, null, { status: "OPEN" })];
  const picks = [p(1), p(2)];
  assert.equal(
    calculateStats(rows, picks, "2026-10-01").participationStreak,
    1,
  );
  assert.equal(
    calculateStats(rows, picks, "2026-10-02").participationStreak,
    2,
  );
});
