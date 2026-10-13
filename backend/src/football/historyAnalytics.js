export function summarizeResearch(results) {
  const s = { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, bothTeamsScored: 0, over15: 0, over25: 0, over35: 0, cleanSheets: 0, opponentCleanSheets: 0 };
  for (const r of results) {
    const a = r.teamScore, b = r.opponentScore;
    if (![a, b].every(n => Number.isSafeInteger(n) && n >= 0)) continue;
    s.played++; s.wins += a > b ? 1 : 0; s.draws += a === b ? 1 : 0; s.losses += a < b ? 1 : 0;
    s.goalsFor += a; s.goalsAgainst += b; s.bothTeamsScored += a > 0 && b > 0 ? 1 : 0;
    s.over15 += a + b > 1.5 ? 1 : 0; s.over25 += a + b > 2.5 ? 1 : 0; s.over35 += a + b > 3.5 ? 1 : 0;
    s.cleanSheets += b === 0 ? 1 : 0; s.opponentCleanSheets += a === 0 ? 1 : 0;
  }
  const pct = n => s.played ? Math.round(n / s.played * 100) : null;
  const avg = n => s.played ? Math.round(n / s.played * 100) / 100 : null;
  return { ...s, homeWins: s.wins, awayWins: s.losses, winPct: pct(s.wins), drawPct: pct(s.draws), lossPct: pct(s.losses), averageGoals: avg(s.goalsFor + s.goalsAgainst), goalsForPerMatch: avg(s.goalsFor), goalsAgainstPerMatch: avg(s.goalsAgainst), bothTeamsScoredPct: pct(s.bothTeamsScored), over15Pct: pct(s.over15), over25Pct: pct(s.over25), over35Pct: pct(s.over35), cleanSheetsPct: pct(s.cleanSheets) };
}
export function quickInsights(meetings, formA, formB, teamA, teamB) {
  const insights = [];
  const add = (key, numerator, denominator, text) => { if (denominator >= 3) insights.push({ key, numerator, denominator, text }); };
  const h = summarizeResearch(meetings.slice(0, 10));
  add('btts', h.bothTeamsScored, h.played, `Both teams scored in ${h.bothTeamsScored} of the last ${h.played} meetings.`);
  add('goals', h.over25, h.played, `${h.over25} of the last ${h.played} meetings had over 2.5 goals.`);
  const a = formA.home, b = formB.summary;
  add('home', a.wins, a.played, `${teamA.shortName || teamA.name} won ${a.wins} of its last ${a.played} home matches.`);
  add('clean', b.cleanSheets, b.played, `${teamB.shortName || teamB.name} kept ${b.cleanSheets} clean sheets in its last ${b.played} matches.`);
  return insights.slice(0, 4);
}
