export type ArenaPick = 'WIN' | 'DRAW' | 'LOSS';
export type ArenaStatus =
  'DRAFT' | 'OPEN' | 'LOCKED' | 'LIVE' | 'SETTLING' | 'COMPLETED' | 'CANCELLED';
export interface Arena {
  id: number;
  name: string;
  description: string | null;
  status: ArenaStatus;
  entryFee: number;
  feePercent: number;
  prizePercentages: number[];
  deadline: string;
  lockedAt: string | null;
  completedAt: string | null;
  participants: number;
  fixtureCount: number;
  grossPool: number;
  platformFee: number;
  prizePool: number;
  prizes: number[];
  cancellationReason: string | null;
  mine: boolean;
  isDemo: true;
}
export interface ArenaFixture {
  id: number;
  fixtureId: number;
  homeTeamId: number;
  awayTeamId: number;
  referenceTeamId: number;
  homeTeam: string;
  awayTeam: string;
  referenceTeam: string;
  competition: string;
  kickoffAt: string;
  originalKickoffAt: string;
  status: string;
  result: ArenaPick | 'VOID' | null;
  reason: string | null;
  homeScore: number | null;
  awayScore: number | null;
}
export interface ArenaPrediction {
  arenaFixtureId: number;
  pick: ArenaPick;
}
export interface ArenaDetail {
  arena: Arena;
  fixtures: ArenaFixture[];
  myEntry: {
    id: number;
    points: number;
    rank: number | null;
    payout: number;
    joinedAt: string;
    predictions: ArenaPrediction[];
  } | null;
  settlement: {
    kind: 'PAYOUT' | 'REFUND';
    gross_cents: number;
    fee_cents: number;
    paid_cents: number;
    created_at: string;
    audit: unknown;
  } | null;
  serverNow: string;
  rules: {
    minimumPlayers: number;
    pointsPerCorrect: number;
    ties: string;
    voids: string;
    reschedules: string;
    visibility: string;
    demoOnly: true;
  };
}
export interface ArenaRanking {
  entryId: number;
  username: string;
  points: number;
  correct: number;
  incorrect: number;
  remaining: number;
  position: number;
  prizeEligible: boolean;
  payout: number;
  projectedPayout?: number;
  mine: boolean;
}
export interface ArenaLeaderboard {
  rows: ArenaRanking[];
  myRank: ArenaRanking | null;
  hasMore: boolean;
  page: number;
  provisional: boolean;
}
export interface ArenaFixtureOption {
  id: number;
  homeTeamId: number;
  awayTeamId: number;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  kickoffAt: string;
  referenceTeamId?: number;
}
