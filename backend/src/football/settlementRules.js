// Every football challenge type has an explicit, deterministic settlement
// rule here — nothing is ever decided ad hoc. Each resolver takes the FINAL
// fixture row (already loaded from our own database, never client-supplied)
// plus each player's pick, and returns exactly one of:
//   { outcome: 'WIN', winnerPick }   — one player picked correctly
//   { outcome: 'DRAW', reason }      — a genuine tie; full refund, no fee
//   { outcome: 'VOID', reason }      — cannot be fairly resolved; full refund, no fee
//
// A resolver is only ever invoked once the fixture is FINISHED and, for
// stats-dependent types, once statsAvailable is true — see footballSettlementService.

function teamResult(homeVal, awayVal) {
  if (homeVal == null || awayVal == null) return { outcome: 'VOID', reason: 'Required match data was not available.' };
  if (homeVal === awayVal) return { outcome: 'DRAW', reason: 'It was an exact tie.' };
  return { outcome: 'WIN', winnerPick: homeVal > awayVal ? 'HOME' : 'AWAY' };
}

export const SETTLEMENT_RULES = {
  match_winner: (fx) => {
    const r = teamResult(fx.home_score, fx.away_score);
    return r.outcome === 'DRAW' ? { outcome: 'DRAW', reason: 'The match ended in a draw.' } : r;
  },

  more_shots: (fx) => teamResult(fx.home_shots, fx.away_shots),
  more_corners: (fx) => teamResult(fx.home_corners, fx.away_corners),
  more_cards: (fx) => teamResult(fx.home_cards, fx.away_cards),
  more_possession: (fx) => teamResult(fx.home_possession, fx.away_possession),
  more_shots_on_target: (fx) => teamResult(fx.home_shots_on_target, fx.away_shots_on_target),

  first_to_score: (fx) => {
    if (!fx.first_goal_team) return { outcome: 'VOID', reason: 'Required match data was not available.' };
    if (fx.first_goal_team === 'NONE') return { outcome: 'VOID', reason: 'Neither team scored.' };
    return { outcome: 'WIN', winnerPick: fx.first_goal_team };
  },

  both_teams_score: (fx) => {
    if (fx.home_score == null || fx.away_score == null) return { outcome: 'VOID', reason: 'Required match data was not available.' };
    const yes = fx.home_score > 0 && fx.away_score > 0;
    return { outcome: 'WIN', winnerPick: yes ? 'YES' : 'NO' };
  },

  over_under_2_5: (fx) => {
    if (fx.home_score == null || fx.away_score == null) return { outcome: 'VOID', reason: 'Required match data was not available.' };
    const over = fx.home_score + fx.away_score >= 3;
    return { outcome: 'WIN', winnerPick: over ? 'YES' : 'NO' };
  },
};

/** Resolve a challenge type against a finished fixture. Throws if the slug is unknown. */
export function resolveOutcome(slug, fixture) {
  const rule = SETTLEMENT_RULES[slug];
  if (!rule) throw new Error(`No settlement rule registered for football challenge type "${slug}"`);
  return rule(fixture);
}
