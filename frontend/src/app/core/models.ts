export type Role = 'PLAYER' | 'ADMIN';

export interface User {
  id: number;
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  phone: string;
  role: Role;
  status: 'ACTIVE' | 'DISABLED';
  bio: string | null;
  avatarColor: string;
  isBot?: boolean;
  isDemoData?: boolean;
  createdAt: string;
  lastLoginAt?: string | null;
  lastSeenAt?: string | null;
}

export interface Wallet {
  id: number;
  currency: string;
  available: number;
  locked: number;
  total: number;
  isDemo: boolean;
  updatedAt: string;
}

export type TxType = 'DEPOSIT' | 'WITHDRAWAL' | 'GAME_ENTRY' | 'GAME_WIN' | 'REFUND';

export interface Transaction {
  id: number;
  reference: string;
  type: TxType;
  direction: 'CREDIT' | 'DEBIT';
  amount: number;
  signedAmount: number;
  balanceAfter: number;
  lockedAfter: number;
  description: string;
  status: string;
  matchId: number | null;
  matchCode: string | null;
  createdAt: string;
  username?: string;
}

export interface Paged<T> { items: T[]; total: number; page: number; pageSize: number; }

export interface StakeOption { stake: number; pool: number; fee: number; prize: number; }

export interface Game {
  id: number;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  howToPlay: string;
  mode: string;
  estimatedDurationSeconds: number;
  accentColor: string;
  isEnabled: boolean;
  waiting?: number;
  waitingByStake?: Record<string, number>;
  stakes?: StakeOption[];
  minEntry?: number;
  maxPrize?: number;
  feePercent?: number;
}

export type MatchStatus = 'WAITING' | 'MATCHED' | 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type Outcome = 'WIN' | 'LOSS' | 'DRAW' | 'REFUNDED' | null;

export interface MatchPlayer {
  userId: number;
  username: string;
  displayName: string;
  avatarColor: string;
  isBot: boolean;
  slot: number;
  ready: boolean;
  started: boolean;
  submitted: boolean;
  outcome: Outcome;
  payout: number;
  result: {
    score: number;
    valid: boolean;
    invalidReason: string | null;
    summary: Record<string, number | null>;
    rounds: Array<Record<string, unknown>>;
    serverElapsedMs: number | null;
  } | null;
}

export interface MatchView {
  id: number;
  code: string;
  status: MatchStatus;
  source: 'MATCHMAKING' | 'CHALLENGE' | 'DIRECT';
  game: { id: number; slug: string; name: string; accentColor: string };
  stake: number;
  pool: number;
  feePercent: number;
  fee: number;
  prize: number;
  winnerId: number | null;
  isDraw: boolean;
  resultReason: string | null;
  cancelReason: string | null;
  createdBy: number;
  createdAt: string;
  matchedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  deadlines: { waitingExpiresAt: string | null; startBy: string | null };
  viewerId: number;
  players: MatchPlayer[];
}

export interface MatchSummary {
  id: number;
  code: string;
  status: MatchStatus;
  source: string;
  game: { id: number; slug: string; name: string; accentColor: string };
  stake: number;
  prize: number;
  fee: number;
  outcome: Outcome;
  payout: number | null;
  opponent: { userId: number; username: string; avatarColor: string; isBot: boolean } | null;
  myScore: number | null;
  opponentScore: number | null;
  isDraw: boolean;
  createdAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface Streak { type: 'W' | 'L' | null; count: number; label: string; }

export interface UserStats {
  played: number;
  wins: number;
  losses: number;
  draws: number;
  cancelled: number;
  winRate: number;
  streak: Streak;
  bestWinStreak: number;
  totalWinnings: number;
  totalStaked: number;
  netResult: number;
  reactionRush: { bestReactionMs: number | null; averageReactionMs: number | null };
  perGame: Array<{ gameId: number; slug: string; name: string; accentColor: string; played: number; wins: number; losses: number; bestScore: number | null; averageScore: number | null; winnings: number }>;
}

export interface Challenge {
  id: number;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED';
  direction: 'INCOMING' | 'OUTGOING';
  challenger: { userId: number; username: string; avatarColor: string };
  opponent: { userId: number; username: string; avatarColor: string };
  game: { id: number; slug: string; name: string; accentColor: string };
  stake: number;
  potentialPrize: number | null;
  message: string | null;
  matchId: number | null;
  matchCode: string | null;
  expiresAt: string;
  respondedAt: string | null;
  createdAt: string;
}

export interface LeaderboardEntry {
  rank: number;
  userId: number;
  username: string;
  avatarColor: string;
  isBot: boolean;
  played: number;
  wins: number;
  losses: number;
  winRate: number;
  totalWinnings: number;
  streak: Streak;
}

export interface AppNotification {
  id: number;
  type: string;
  title: string;
  message: string;
  link: string | null;
  isRead: boolean;
  createdAt: string;
}

export interface PublicConfig {
  appName: string;
  demoMode: boolean;
  demoNotice: string;
  currency: { symbol: string; code: string };
  platformFeePercent: number;
  stakeAmounts: number[];
  stakeBreakdown: StakeOption[];
  depositPresets: number[];
  signupBonus: number;
  maxDeposit: number;
  minWithdrawal: number;
  demoBotsEnabled: boolean;
}

export interface PlayerSearchResult { id: number; username: string; displayName: string; avatarColor: string; isBot: boolean; online: boolean; }
