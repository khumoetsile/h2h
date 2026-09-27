import { DisplayState, FootballMatchInfo, MatchView } from './models';
import { relevantStat } from './football-stat';

/** Player-facing label + chip style for every challenge state. One vocabulary everywhere: challenge, opponent, pick, lock in — never bookmaker terms. */
export const DISPLAY_STATE: Record<DisplayState, { label: string; chip: string; icon: string }> = {
  WAITING_FOR_OPPONENT: { label: 'Waiting for opponent', chip: 'chip chip-demo', icon: 'hourglass_top' },
  LOCKING_IN: { label: 'Lock in now', chip: 'chip chip-info', icon: 'lock_open' },
  LOCKED_IN: { label: 'Locked in', chip: 'chip chip-info', icon: 'lock' },
  IN_PROGRESS: { label: 'In progress', chip: 'chip chip-accent', icon: 'play_circle' },
  WON: { label: 'Won', chip: 'chip chip-win', icon: 'emoji_events' },
  LOST: { label: 'Lost', chip: 'chip chip-loss', icon: 'close' },
  DRAW: { label: 'Draw', chip: 'chip chip-info', icon: 'balance' },
  VOID: { label: 'Void', chip: 'chip', icon: 'block' },
  EXPIRED: { label: 'Expired', chip: 'chip', icon: 'timer_off' },
  TIMED_OUT: { label: 'Timed out', chip: 'chip chip-loss', icon: 'timer_off' },
  LEFT: { label: 'You left', chip: 'chip chip-loss', icon: 'logout' },
  OPPONENT_LEFT: { label: 'Opponent left', chip: 'chip', icon: 'person_off' },
  CANCELLED: { label: 'Cancelled', chip: 'chip', icon: 'undo' },
};

export const ACTIVE_STATES: DisplayState[] = ['WAITING_FOR_OPPONENT', 'LOCKING_IN', 'LOCKED_IN', 'IN_PROGRESS'];

/** Derive the same display state from a full MatchView (the list endpoint computes it server-side). */
export function viewDisplayState(m: MatchView): DisplayState {
  const me = m.players.find((p) => p.userId === m.viewerId);
  switch (m.status) {
    case 'WAITING': return 'WAITING_FOR_OPPONENT';
    case 'MATCHED': return 'LOCKING_IN';
    case 'READY': return 'LOCKED_IN';
    case 'IN_PROGRESS': return 'IN_PROGRESS';
    case 'COMPLETED': return m.isDraw ? 'DRAW' : me?.outcome === 'WIN' ? 'WON' : 'LOST';
    case 'VOID': return 'VOID';
    default:
      if (m.endReason === 'NO_OPPONENT') return 'EXPIRED';
      if (m.endReason === 'LOCK_IN_TIMEOUT' || m.endReason === 'GAME_TIMEOUT' || m.endReason === 'ACTION_TIMEOUT') return 'TIMED_OUT';
      if (m.endReason === 'ABANDONED') return m.abandonedBy === m.viewerId ? 'LEFT' : 'OPPONENT_LEFT';
      return 'CANCELLED';
  }
}

export function competitionName(c: { name: string; code: string } | string | null | undefined) {
  if (!c) return '';
  return typeof c === 'string' ? c : c.name;
}

/** This viewer's pick label and their opponent's, for a football match view. */
export function picksFor(m: MatchView) {
  const f = m.football;
  if (!f) return { mine: '', theirs: '' };
  const iCreated = m.createdBy === m.viewerId;
  return {
    mine: (iCreated ? f.creatorPickLabel : f.opponentPickLabel) ?? '',
    theirs: (iCreated ? f.opponentPickLabel : f.creatorPickLabel) ?? '',
  };
}

/**
 * Live (or final) state of the CHALLENGE — whose pick is currently ahead on
 * the thing the question is about. Pure PvP framing: "Your pick is ahead",
 * never prices or odds.
 */
export function challengeStanding(m: MatchView): { headline: string; tone: 'me' | 'them' | 'level' | 'none' } {
  const f = m.football;
  if (!f) return { headline: '', tone: 'none' };
  const { mine, theirs } = picksFor(m);
  const iCreated = m.createdBy === m.viewerId;
  const myPick = iCreated ? f.creatorPick : f.opponentPick;
  const slug = f.challengeType?.slug;
  const stat = relevantStat(f);
  const leaderFrom = (home: number | null | undefined, away: number | null | undefined) => {
    if (home == null || away == null) return null;
    if (home === away) return 'LEVEL';
    return home > away ? 'HOME' : 'AWAY';
  };
  let leader: string | null = null;
  let subject = '';
  if (stat) {
    leader = leaderFrom(stat.home, stat.away);
    subject = `on ${stat.label.toLowerCase()}`;
  } else if (slug === 'match_winner') {
    leader = leaderFrom(f.homeScore, f.awayScore);
    subject = '';
  } else if (slug === 'both_teams_score') {
    if (f.homeScore == null || f.awayScore == null) return { headline: '', tone: 'none' };
    leader = f.homeScore > 0 && f.awayScore > 0 ? 'YES' : 'NO';
    subject = '';
  } else if (slug === 'over_under_2_5') {
    if (f.homeScore == null || f.awayScore == null) return { headline: '', tone: 'none' };
    leader = f.homeScore + f.awayScore >= 3 ? 'YES' : 'NO';
  } else if (slug === 'first_to_score') {
    leader = f.firstGoalTeam && f.firstGoalTeam !== 'NONE' ? f.firstGoalTeam : null;
    if (!leader) return { headline: 'No goals yet.', tone: 'level' };
  }
  if (!leader) return { headline: '', tone: 'none' };
  if (leader === 'LEVEL') return { headline: `It's level${subject ? ' ' + subject : ''}.`, tone: 'level' };
  const team = leader === 'HOME' ? f.homeTeam : leader === 'AWAY' ? f.awayTeam : null;
  const ahead = leader === myPick;
  const who = ahead ? `Your pick (${mine})` : `Your opponent's pick (${theirs})`;
  if (team && subject) return { headline: `${team} ${m.status === 'COMPLETED' ? 'finished' : 'is currently'} ahead ${subject} — ${ahead ? 'your' : "your opponent's"} pick.`, tone: ahead ? 'me' : 'them' };
  return { headline: `${who} is currently ahead.`, tone: ahead ? 'me' : 'them' };
}

export function isLiveFootball(f: FootballMatchInfo | null | undefined) {
  return !!f && f.fixtureStatus === 'LIVE';
}
