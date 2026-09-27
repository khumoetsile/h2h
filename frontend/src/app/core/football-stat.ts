import { FootballMatchInfo } from './models';

/**
 * Which statistic actually decides a given football challenge type — e.g. a
 * "more shots" challenge is decided by shots, not the match score. Used to
 * show the real, relevant numbers on the lobby/result screens rather than
 * always defaulting to the goal score.
 */
export function relevantStat(f: FootballMatchInfo): { label: string; home: number | null; away: number | null } | null {
  const slug = f.challengeType?.slug;
  const s = f.stats;
  switch (slug) {
    case 'more_shots': return { label: 'Shots', home: s?.shots.home ?? null, away: s?.shots.away ?? null };
    case 'more_shots_on_target': return { label: 'Shots on target', home: s?.shotsOnTarget.home ?? null, away: s?.shotsOnTarget.away ?? null };
    case 'more_corners': return { label: 'Corners', home: s?.corners.home ?? null, away: s?.corners.away ?? null };
    case 'more_cards': return { label: 'Cards', home: s?.cards.home ?? null, away: s?.cards.away ?? null };
    case 'more_possession': return { label: 'Possession', home: s?.possession.home ?? null, away: s?.possession.away ?? null };
    default: return null; // match_winner / first_to_score / both_teams_score / over_under_2_5 are read from the score itself
  }
}
