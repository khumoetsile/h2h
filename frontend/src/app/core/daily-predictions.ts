export type DailyPick = 'WIN' | 'DRAW' | 'LOSS';
export interface DailyStats {
  winningStreak: number;
  bestWinningStreak: number;
  participationStreak: number;
  bestParticipationStreak: number;
  correct: number;
  incorrect: number;
  eligible: number;
  accuracy: number | null;
  last7Accuracy: number | null;
  last30Accuracy: number | null;
  history: { date: string; winningStreak: number; participationStreak: number; pending: boolean }[];
}
export interface DailyChallenge {
  id: number;
  fixtureId?: number;
  challengeDate: string;
  homeTeam: string;
  awayTeam: string;
  referenceTeam: string;
  kickoffAt: string;
  cutoffAt?: string;
  status: string;
  fixtureStatus: string;
  actual_result: DailyPick | 'VOID' | null;
  reason: string | null;
  pick: DailyPick | null;
  canSubmit: boolean;
  providerUnavailable: boolean;
  community?: {
    total: number;
    selections: { pick: DailyPick; percentage: number | null; count: number }[];
  };
}
export interface DailyOverview {
  today: string;
  timezone: string;
  challenges: DailyChallenge[];
  stats: DailyStats;
  achievements: { code: string; title: string; description: string }[];
  reminders: boolean;
  weeklyRank: number | null;
  serverNow: string;
}
export interface DailyHistoryRow {
  id: number;
  challengeDate: string;
  homeTeam: string;
  awayTeam: string;
  referenceTeam: string;
  pick: DailyPick;
  actualResult: DailyPick | 'VOID' | null;
  points: number;
  reason: string | null;
}
export interface DailyHistory {
  predictions: DailyHistoryRow[];
  page: number;
  hasMore: boolean;
}
export interface DailyRank {
  userId: number;
  username: string;
  rank: number;
  points: number;
  correct: number;
  accuracy: number;
  winningStreak: number;
  participationStreak: number;
}
export interface DailyLeaderboard {
  rankings: DailyRank[];
  mine: DailyRank | null;
  hasMore: boolean;
  tiePolicy: string;
}
export const dailyLabel = (pick: string | null | undefined) =>
  pick === 'WIN'
    ? 'Win'
    : pick === 'DRAW'
      ? 'Draw'
      : pick === 'LOSS'
        ? 'Loss'
        : pick === 'VOID'
          ? 'Void'
          : 'Awaiting verified result';
