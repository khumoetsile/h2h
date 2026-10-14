import { createHash } from "node:crypto";
import { summarizeResearch } from "./historyAnalytics.js";

export const MODEL_VERSION = "poisson-strength-v1";
export const MODEL_OPTIONS = Object.freeze({
  halfLifeDays: 180,
  priorMatches: 10,
  lookbackDays: 1095,
  embargoDays: 1,
  iterations: 25,
  minLeagueMatches: 200,
  minTeamMatches: 10,
  minVenueMatches: 4,
  minEffectiveMatches: 6,
});
export const MODEL_LEAGUES = ["PL", "BL1", "PD", "SA", "FL1"];
const dayMs = 86400000;
const round = (n) => Math.round(n * 1e6) / 1e6;
export const resultOf = (m) =>
  m.homeScore > m.awayScore
    ? "HOME"
    : m.homeScore === m.awayScore
      ? "DRAW"
      : "AWAY";
export function percentages(probabilities) {
  const keys = Object.keys(probabilities),
    total = keys.reduce((s, k) => s + probabilities[k], 0);
  if (!total) return Object.fromEntries(keys.map((k) => [k, null]));
  const parts = keys.map((k) => ({
    k,
    value: (probabilities[k] / total) * 1000,
  }));
  const result = Object.fromEntries(
    parts.map((p) => [p.k, Math.floor(p.value)]),
  );
  let remaining = 1000 - Object.values(result).reduce((s, v) => s + v, 0);
  for (const p of parts.sort((a, b) => (b.value % 1) - (a.value % 1))) {
    if (!remaining) break;
    result[p.k]++;
    remaining--;
  }
  return Object.fromEntries(keys.map((k) => [k, result[k] / 10]));
}
export function prepareModelMatches(rows) {
  const selected = new Map(),
    conflicted = new Set();
  for (const r of rows) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
      !Number.isFinite(Date.parse(r.date + "T00:00:00Z")) ||
      new Date(r.date + "T00:00:00Z").toISOString().slice(0, 10) !== r.date ||
      ![r.homeScore, r.awayScore].every(
        (n) => Number.isSafeInteger(n) && n >= 0 && n <= 12,
      ) ||
      r.homeTeamId === r.awayTeamId
    )
      continue;
    const key = `${r.code}:${r.date}:${r.homeTeamId}:${r.awayTeamId}`;
    const previous = selected.get(key);
    if (
      previous &&
      (previous.homeScore !== r.homeScore || previous.awayScore !== r.awayScore)
    )
      conflicted.add(key);
    else if (!previous) selected.set(key, r);
  }
  return [...selected.entries()]
    .filter(([k]) => !conflicted.has(k))
    .map(([, m]) => m)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        String(a.id).localeCompare(String(b.id)),
    );
}
export function fitGoalModel(rows, cutoffDate, options = MODEL_OPTIONS) {
  const cutoff = new Date(cutoffDate + "T00:00:00Z").getTime();
  if (!Number.isFinite(cutoff)) throw new Error("Invalid model cutoff.");
  // Date-only imports cannot prove that any same-day result was known at kickoff.
  const latestAllowed = new Date(cutoff - options.embargoDays * dayMs)
    .toISOString()
    .slice(0, 10);
  const matches = rows.filter(
    (m) =>
      m.date < latestAllowed &&
      cutoff - new Date(m.date + "T00:00:00Z").getTime() <=
        options.lookbackDays * dayMs,
  );
  if (matches.length < options.minLeagueMatches)
    return {
      status: "UNAVAILABLE",
      reason: "Not enough verified league results.",
      cutoffDate,
    };
  const teams = {};
  let weight = 0,
    homeGoals = 0,
    awayGoals = 0;
  const outcome = { HOME: 1, DRAW: 1, AWAY: 1 };
  let over = 0,
    btts = 0;
  const weighted = matches.map((m) => ({
    ...m,
    w: Math.exp(
      (-Math.LN2 * (cutoff - Date.parse(m.date + "T00:00:00Z"))) /
        dayMs /
        options.halfLifeDays,
    ),
  }));
  for (const m of weighted) {
    weight += m.w;
    homeGoals += m.w * m.homeScore;
    awayGoals += m.w * m.awayScore;
    outcome[resultOf(m)] += m.w;
    over += m.w * (m.homeScore + m.awayScore > 2.5);
    btts += m.w * (m.homeScore > 0 && m.awayScore > 0);
    for (const [id, home] of [
      [m.homeTeamId, true],
      [m.awayTeamId, false],
    ]) {
      const t = (teams[id] ||= {
        id,
        name: home ? m.homeName : m.awayName,
        attack: 1,
        defence: 1,
        count: 0,
        homeCount: 0,
        awayCount: 0,
        w: 0,
        w2: 0,
        goals: 0,
        conceded: 0,
        lastDate: m.date,
        records: [],
      });
      t.count++;
      home ? t.homeCount++ : t.awayCount++;
      t.w += m.w;
      t.w2 += m.w * m.w;
      t.goals += m.w * (home ? m.homeScore : m.awayScore);
      t.conceded += m.w * (home ? m.awayScore : m.homeScore);
      t.lastDate = m.date;
      t.records.push({
        date: m.date,
        home,
        teamScore: home ? m.homeScore : m.awayScore,
        opponentScore: home ? m.awayScore : m.homeScore,
      });
    }
  }
  if (weight < 60 || homeGoals <= 0 || awayGoals <= 0)
    return {
      status: "UNAVAILABLE",
      reason: "Too little recent league scoring evidence.",
      cutoffDate,
    };
  let muHome = homeGoals / weight,
    muAway = awayGoals / weight;
  const prior = (options.priorMatches * (muHome + muAway)) / 2;
  const all = Object.values(teams);
  for (let iteration = 0; iteration < options.iterations; iteration++) {
    const expectedFor = {},
      expectedAgainst = {};
    for (const m of weighted) {
      expectedFor[m.homeTeamId] =
        (expectedFor[m.homeTeamId] || 0) +
        m.w * muHome * teams[m.awayTeamId].defence;
      expectedFor[m.awayTeamId] =
        (expectedFor[m.awayTeamId] || 0) +
        m.w * muAway * teams[m.homeTeamId].defence;
    }
    for (const t of all)
      t.attack = (t.goals + prior) / (expectedFor[t.id] + prior);
    for (const m of weighted) {
      expectedAgainst[m.homeTeamId] =
        (expectedAgainst[m.homeTeamId] || 0) +
        m.w * muAway * teams[m.awayTeamId].attack;
      expectedAgainst[m.awayTeamId] =
        (expectedAgainst[m.awayTeamId] || 0) +
        m.w * muHome * teams[m.homeTeamId].attack;
    }
    for (const t of all)
      t.defence = (t.conceded + prior) / (expectedAgainst[t.id] + prior);
    const geoA = Math.exp(
        all.reduce((s, t) => s + Math.log(t.attack), 0) / all.length,
      ),
      geoD = Math.exp(
        all.reduce((s, t) => s + Math.log(t.defence), 0) / all.length,
      );
    for (const t of all) {
      t.attack /= geoA;
      t.defence /= geoD;
    }
    let expectedHome = 0,
      expectedAway = 0;
    for (const m of weighted) {
      expectedHome +=
        m.w * teams[m.homeTeamId].attack * teams[m.awayTeamId].defence;
      expectedAway +=
        m.w * teams[m.awayTeamId].attack * teams[m.homeTeamId].defence;
    }
    muHome = homeGoals / expectedHome;
    muAway = awayGoals / expectedAway;
  }
  for (const t of all) {
    t.effectiveCount = (t.w * t.w) / t.w2;
    const recent = t.records.slice().reverse();
    t.form = summarizeResearch(recent.slice(0, 10));
    t.homeForm = summarizeResearch(recent.filter((r) => r.home).slice(0, 10));
    t.awayForm = summarizeResearch(recent.filter((r) => !r.home).slice(0, 10));
    delete t.records;
  }
  const sum = Object.values(outcome).reduce((s, n) => s + n, 0);
  return {
    status: "READY",
    version: MODEL_VERSION,
    cutoffDate,
    lastMatchDate: matches.at(-1).date,
    count: matches.length,
    muHome,
    muAway,
    teams,
    options,
    baseline: Object.fromEntries(
      Object.entries(outcome).map(([k, n]) => [k, n / sum]),
    ),
    binaryBaseline: {
      over25: (over + 1) / (weight + 2),
      btts: (btts + 1) / (weight + 2),
    },
    dataHash: createHash("sha256")
      .update(
        JSON.stringify([
          MODEL_VERSION,
          cutoffDate,
          matches.map((m) => [
            m.id,
            m.date,
            m.homeTeamId,
            m.awayTeamId,
            m.homeScore,
            m.awayScore,
          ]),
        ]),
      )
      .digest("hex"),
  };
}
function poisson(lambda) {
  const p = [Math.exp(-lambda)];
  for (let i = 1; i <= 24; i++) p.push((p.at(-1) * lambda) / i);
  return p;
}
export function predictGoals(fit, homeId, awayId) {
  if (fit.status !== "READY")
    return { status: "UNAVAILABLE", reason: fit.reason };
  const h = fit.teams[homeId],
    a = fit.teams[awayId],
    o = fit.options;
  if (
    !h ||
    !a ||
    Math.min(h.count, a.count) < o.minTeamMatches ||
    h.homeCount < o.minVenueMatches ||
    a.awayCount < o.minVenueMatches ||
    Math.min(h.effectiveCount, a.effectiveCount) < o.minEffectiveMatches
  )
    return {
      status: "UNAVAILABLE",
      reason: "These teams need more verified league and venue results.",
    };
  const age = (date) => (Date.parse(fit.cutoffDate) - Date.parse(date)) / dayMs;
  if (
    age(fit.lastMatchDate) > 45 ||
    age(h.lastDate) > 150 ||
    age(a.lastDate) > 150
  )
    return {
      status: "UNAVAILABLE",
      reason: "Recent scoring data is too old for a useful estimate.",
    };
  const lambdaHome = fit.muHome * h.attack * a.defence,
    lambdaAway = fit.muAway * a.attack * h.defence;
  if (
    ![lambdaHome, lambdaAway].every(
      (n) => Number.isFinite(n) && n > 0 && n <= 5,
    )
  )
    return {
      status: "UNAVAILABLE",
      reason: "The scoring estimates are outside the validated model range.",
    };
  const hp = poisson(lambdaHome),
    ap = poisson(lambdaAway),
    p = { HOME: 0, DRAW: 0, AWAY: 0 };
  for (let i = 0; i < hp.length; i++)
    for (let j = 0; j < ap.length; j++)
      p[i > j ? "HOME" : i === j ? "DRAW" : "AWAY"] += hp[i] * ap[j];
  const total = Object.values(p).reduce((s, n) => s + n, 0);
  for (const k of Object.keys(p)) p[k] /= total;
  const lambda = lambdaHome + lambdaAway;
  return {
    status: "READY",
    probabilities: p,
    percentages: percentages(p),
    expectedGoals: { home: lambdaHome, away: lambdaAway },
    markets: {
      over25: 1 - Math.exp(-lambda) * (1 + lambda + (lambda * lambda) / 2),
      btts: (1 - Math.exp(-lambdaHome)) * (1 - Math.exp(-lambdaAway)),
    },
    quality: {
      label:
        Math.min(h.count, a.count) >= 30 &&
        Math.min(h.homeCount, a.awayCount) >= 10 &&
        Math.min(h.effectiveCount, a.effectiveCount) >= 20
          ? "Good coverage"
          : "Limited sample",
      leagueMatches: fit.count,
      homeTeamMatches: h.count,
      awayTeamMatches: a.count,
      homeVenueMatches: h.homeCount,
      awayVenueMatches: a.awayCount,
      effectiveHomeMatches: round(h.effectiveCount),
      effectiveAwayMatches: round(a.effectiveCount),
    },
    explanations: [
      `${h.name} won ${h.homeForm.wins} of its last ${h.homeForm.played} home matches.`,
      `${a.name} conceded in ${a.awayForm.played - a.awayForm.cleanSheets} of its last ${a.awayForm.played} away matches.`,
      `${h.name} averaged ${h.form.goalsForPerMatch.toFixed(2)} goals in its last ${h.form.played} league matches.`,
      `${a.name} averaged ${a.form.goalsAgainstPerMatch.toFixed(2)} goals conceded in its last ${a.form.played} league matches.`,
    ],
  };
}
export function evaluateProbabilities(records, binary = false) {
  if (!records.length)
    return {
      count: 0,
      logLoss: null,
      brier: null,
      ece: null,
      accuracy: null,
      calibration: [],
    };
  let logLoss = 0,
    brier = 0,
    correct = 0;
  const bins = Array.from({ length: 10 }, () => ({
    count: 0,
    sum: 0,
    actual: 0,
  }));
  for (const { probabilities: p, actual } of records) {
    const keys = Object.keys(p);
    logLoss -= Math.log(Math.max(1e-12, p[actual]));
    if (
      keys.reduce((best, k) => (p[k] > p[best] ? k : best), keys[0]) === actual
    )
      correct++;
    for (const k of keys) {
      const y = k === actual ? 1 : 0;
      brier += (p[k] - y) ** 2;
      const b = bins[Math.min(9, Math.floor(p[k] * 10))];
      b.count++;
      b.sum += p[k];
      b.actual += y;
    }
  }
  const n = records.length,
    points = bins
      .filter((b) => b.count)
      .map((b) => ({
        count: b.count,
        predicted: b.sum / b.count,
        observed: b.actual / b.count,
      }));
  const denom = n * (binary ? 2 : 3);
  return {
    count: n,
    logLoss: round(logLoss / n),
    brier: round(brier / n / (binary ? 2 : 1)),
    ece: round(
      points.reduce(
        (s, b) => s + b.count * Math.abs(b.predicted - b.observed),
        0,
      ) / denom,
    ),
    accuracy: round(correct / n),
    calibration: points.map((b) => ({
      ...b,
      predicted: round(b.predicted),
      observed: round(b.observed),
    })),
  };
}
export function chronologicalBacktest(rows, { limit = 400 } = {}) {
  const matches = prepareModelMatches(rows),
    test = matches.slice(-limit);
  let skipped = 0,
    lastDate,
    fit;
  const model = [],
    baseline = [],
    markets = {
      over25: { model: [], baseline: [] },
      btts: { model: [], baseline: [] },
    };
  for (const m of test) {
    if (m.date !== lastDate) {
      lastDate = m.date;
      fit = fitGoalModel(matches, m.date);
    }
    const p = predictGoals(fit, m.homeTeamId, m.awayTeamId);
    if (p.status !== "READY") {
      skipped++;
      continue;
    }
    model.push({ probabilities: p.probabilities, actual: resultOf(m) });
    baseline.push({ probabilities: fit.baseline, actual: resultOf(m) });
    for (const key of ["over25", "btts"]) {
      const y = (
        key === "over25"
          ? m.homeScore + m.awayScore > 2.5
          : m.homeScore > 0 && m.awayScore > 0
      )
        ? "YES"
        : "NO";
      markets[key].model.push({
        probabilities: { YES: p.markets[key], NO: 1 - p.markets[key] },
        actual: y,
      });
      markets[key].baseline.push({
        probabilities: {
          YES: fit.binaryBaseline[key],
          NO: 1 - fit.binaryBaseline[key],
        },
        actual: y,
      });
    }
  }
  const primary = {
    model: evaluateProbabilities(model),
    baseline: evaluateProbabilities(baseline),
  };
  const acceptable = (m) =>
    m.model.count >= 200 &&
    m.model.logLoss <= m.baseline.logLoss &&
    m.model.brier <= m.baseline.brier &&
    m.model.ece <= 0.1;
  const binary = Object.fromEntries(
    Object.entries(markets).map(([k, v]) => {
      const scores = {
        model: evaluateProbabilities(v.model, true),
        baseline: evaluateProbabilities(v.baseline, true),
      };
      return [k, { ...scores, validated: acceptable(scores) }];
    }),
  );
  return {
    version: MODEL_VERSION,
    method:
      "Date-strict rolling-origin evaluation, with a one-day embargo; no random split or same-day results.",
    from: test[0]?.date || null,
    to: test.at(-1)?.date || null,
    attempted: test.length,
    skipped,
    coverage: test.length ? model.length / test.length : 0,
    primary,
    validated: acceptable(primary) && model.length >= 0.7 * test.length,
    markets: binary,
    limitations:
      "Retrospectively corrected stored results; historical feed vintages are unavailable. Independent goal counts omit lineups, injuries and low-score correlation. Evaluation is not a guarantee of future accuracy.",
  };
}
