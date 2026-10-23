// Pure calendar and chronology rules shared by settlement and tests.
export const OUTCOMES = ["WIN", "DRAW", "LOSS"];
export const ACHIEVEMENTS = [
  [
    "first_prediction",
    "First Prediction",
    "Submit your first prediction.",
    (s) => s.submitted > 0,
  ],
  [
    "first_correct",
    "First Correct Prediction",
    "Make one correct prediction.",
    (s) => s.correct > 0,
  ],
  ...[3, 5, 10].map((n) => [
    `winning_${n}`,
    `${n} Correct Predictions in a Row`,
    `Reach a winning streak of ${n} days.`,
    (s) => s.bestWinningStreak >= n,
  ]),
  ...[7, 30].map((n) => [
    `participation_${n}`,
    `${n}-Day Participation Streak`,
    `Participate on ${n} consecutive eligible days.`,
    (s) => s.bestParticipationStreak >= n,
  ]),
  ...[50, 100].map((n) => [
    `correct_${n}`,
    `${n} Correct Predictions`,
    `Make ${n} verified correct predictions.`,
    (s) => s.correct >= n,
  ]),
];
export function challengeDay(date = new Date(), timezone = "Africa/Gaborone") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return ["year", "month", "day"]
    .map((k) => parts.find((p) => p.type === k).value)
    .join("-");
}
export function periodBounds(period, day) {
  const date = new Date(`${day}T12:00:00Z`);
  const iso = (d) => d.toISOString().slice(0, 10);
  if (period === "all") return ["1000-01-01", "9999-12-31"];
  if (period === "daily") return [day, day];
  if (period === "monthly")
    return [
      day.slice(0, 7) + "-01",
      iso(
        new Date(
          Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 12),
        ),
      ),
    ];
  if (period !== "weekly") throw new Error("Invalid ranking period");
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  const start = iso(date);
  date.setUTCDate(date.getUTCDate() + 6);
  return [start, iso(date)];
}
export function verifiedOutcome(f, c, now = new Date()) {
  if (
    f.is_simulated ||
    f.provider === "mock" ||
    f.home_team_id !== c.home_team_id ||
    f.away_team_id !== c.away_team_id
  )
    return {
      outcome: "VOID",
      reason: "Fixture identity changed or simulated fixture.",
    };
  if (["POSTPONED", "CANCELLED", "ABANDONED"].includes(f.status))
    return { outcome: "VOID", reason: `Match ${f.status.toLowerCase()}.` };
  if (
    f.status !== "FINISHED" ||
    new Date(f.kickoff_at) > now ||
    !f.last_synced_at ||
    !f.research_eligible ||
    f.score_duration !== "REGULAR" ||
    !Number.isSafeInteger(f.home_score) ||
    !Number.isSafeInteger(f.away_score) ||
    f.home_score < 0 ||
    f.away_score < 0
  )
    return null;
  const delta =
    (f.home_score - f.away_score) *
    (c.reference_team_id === f.home_team_id ? 1 : -1);
  return {
    outcome: delta > 0 ? "WIN" : delta < 0 ? "LOSS" : "DRAW",
    reason: "Verified provider final result (regular time).",
  };
}
export function calculateStats(
  challenges,
  predictions,
  today = challengeDay(),
) {
  const picks = new Map(predictions.map((p) => [p.challenge_id, p]));
  const stats = {
    winningStreak: 0,
    bestWinningStreak: 0,
    participationStreak: 0,
    bestParticipationStreak: 0,
    correct: 0,
    incorrect: 0,
    eligible: 0,
    accuracy: null,
    last7Accuracy: null,
    last30Accuracy: null,
    lastResolvedDate: null,
    submitted: predictions.length,
    history: [],
  };
  const results = [];
  const days = new Map();
  for (const c of [...challenges].sort(
    (a, b) =>
      a.challenge_date.localeCompare(b.challenge_date) || a.slot - b.slot,
  )) {
    if (c.actual_result === "VOID") continue;
    if (!days.has(c.challenge_date)) days.set(c.challenge_date, []);
    days.get(c.challenge_date).push(c);
    const p = picks.get(c.id);
    if (OUTCOMES.includes(c.actual_result) && p) {
      const correct = p.pick === c.actual_result;
      stats[correct ? "correct" : "incorrect"]++;
      results.push(Number(correct));
      stats.lastResolvedDate = c.challenge_date;
    }
  }
  let blocked = false;
  for (const [day, rows] of days) {
    if (day > today) continue; // Published future days cannot earn streak days early.
    // A pending day is a barrier: later results must not prematurely extend or reset a streak.
    const pending = rows.some((c) => !c.actual_result);
    const participated = rows.every((c) => picks.has(c.id));
    if (participated || !pending) {
      stats.participationStreak = participated
        ? stats.participationStreak + 1
        : 0;
      stats.bestParticipationStreak = Math.max(
        stats.bestParticipationStreak,
        stats.participationStreak,
      );
    }
    if (pending) blocked = true;
    if (!blocked) {
      stats.winningStreak = rows.every(
        (c) => picks.get(c.id)?.pick === c.actual_result,
      )
        ? stats.winningStreak + 1
        : 0;
      stats.bestWinningStreak = Math.max(
        stats.bestWinningStreak,
        stats.winningStreak,
      );
    }
    stats.history.push({
      date: day,
      winningStreak: stats.winningStreak,
      participationStreak: stats.participationStreak,
      pending: blocked,
    });
  }
  stats.eligible = stats.correct + stats.incorrect;
  const accuracy = (a) =>
    a.length
      ? Math.round((a.reduce((s, n) => s + n, 0) / a.length) * 1000) / 10
      : null;
  stats.accuracy = accuracy(results);
  stats.last7Accuracy = accuracy(results.slice(-7));
  stats.last30Accuracy = accuracy(results.slice(-30));
  return stats;
}
