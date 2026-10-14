export type FreeFootballPick = 'HOME' | 'DRAW' | 'AWAY';
export interface CommunityPicks {
  counts: Record<FreeFootballPick, number>;
  total: number;
  percentages: Record<FreeFootballPick, number | null>;
  mine: { pick: FreeFootballPick; submittedAt: string } | null;
  notice: string;
}
export interface FootballForecast {
  fixture: { id: number; homeTeam: string; awayTeam: string; kickoffAt: string; status: string };
  open: boolean;
  serverNow: string;
  community: CommunityPicks;
  model: {
    status: 'READY' | 'UNAVAILABLE';
    reason?: string;
    version: string;
    methodologyUrl: string;
    percentages?: Record<FreeFootballPick, number>;
    quality?: {
      label: string;
      leagueMatches: number;
      homeTeamMatches: number;
      awayTeamMatches: number;
      homeVenueMatches: number;
      awayVenueMatches: number;
    };
    calculatedAt?: string;
    dataCutoff?: string;
    dataThrough?: string;
    explanations?: string[];
    markets?: { over25: number | null; btts: number | null };
    notice?: string;
  };
}
export interface FreePredictionHistory {
  summary: { total: number; settled: number; correct: number; accuracy: number | null };
  page: number;
  hasMore: boolean;
  predictions: Array<{
    id: number;
    fixtureId: number;
    homeTeam: string;
    awayTeam: string;
    kickoffAt: string;
    pick: FreeFootballPick;
    actualResult: FreeFootballPick | 'VOID' | null;
    correct: boolean | null;
    homeScore: number | null;
    awayScore: number | null;
    status: string;
    submittedAt: string;
    updatedAt: string;
    settledAt: string | null;
  }>;
}
export interface FreePredictionRankings {
  minimum: number;
  method: string;
  rankings: Array<{
    rank: number;
    username: string;
    settled: number;
    correct: number;
    accuracy: number;
  }>;
}
export interface PredictionMetrics {
  count: number;
  logLoss: number | null;
  brier: number | null;
  ece: number | null;
  accuracy: number | null;
}
export interface PredictionMethodology {
  version: string;
  method: string;
  cutoff: string;
  validation: string;
  sources: string[];
  reference: string;
  limitations: string;
  reports: Array<{
    competition_code: string;
    data_cutoff: string;
    evaluation: {
      validated: boolean;
      primary: { model: PredictionMetrics; baseline: PredictionMetrics };
      skipped: number;
      from: string | null;
      to: string | null;
    };
  }>;
}
