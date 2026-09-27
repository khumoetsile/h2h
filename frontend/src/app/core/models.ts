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

export type TxType = 'DEPOSIT' | 'WITHDRAWAL' | 'GAME_ENTRY' | 'GAME_WIN' | 'REFUND' | 'FORFEIT' | 'ABANDONMENT_FEE';

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

export type MatchStatus = 'WAITING' | 'MATCHED' | 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'VOID';
export type MatchCategory = 'SKILL_GAME' | 'FOOTBALL';

/** Why an active challenge ended other than by a normal result. */
export type EndReason = 'NO_OPPONENT' | 'LOCK_IN_TIMEOUT' | 'ACTION_TIMEOUT' | 'GAME_TIMEOUT' | 'RESULT_TIMEOUT' | 'ABANDONED' | 'PLAYER_CANCELLED' | 'FIXTURE' | null;

/** One unambiguous, player-facing state per challenge (computed server-side). */
export type DisplayState = 'WAITING_FOR_OPPONENT' | 'LOCKING_IN' | 'LOCKED_IN' | 'IN_PROGRESS' | 'WON' | 'LOST' | 'DRAW' | 'VOID' | 'EXPIRED' | 'TIMED_OUT' | 'LEFT' | 'OPPONENT_LEFT' | 'CANCELLED';

/** Authoritative deadlines stamped by the server. Render them against ServerClock — never decide anything from them client-side. */
export interface MatchTimers {
  serverNow?: string;
  acceptanceDeadline: string | null;
  lockInDeadline: string | null;
  playerActionDeadline: string | null;
  completionDeadline: string | null;
  kickoffAt?: string | null;
  myDeadline: string | null;
}

export interface FootballPick { HOME: string; AWAY: string; YES: string; NO: string }
export type PickType = 'TEAM' | 'YES_NO';
export type Pick = 'HOME' | 'AWAY' | 'YES' | 'NO';

/** Attached to a match/challenge when category/source is football — null otherwise. */
export interface FootballMatchInfo {
  fixtureId: number;
  competition: { name: string; code: string } | string;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: string;
  fixtureStatus?: FixtureStatus;
  minute?: number | null;
  homeScore?: number | null;
  awayScore?: number | null;
  firstGoalTeam?: 'HOME' | 'AWAY' | 'NONE' | null;
  stats?: {
    shots: { home: number | null; away: number | null };
    shotsOnTarget: { home: number | null; away: number | null };
    possession: { home: number | null; away: number | null };
    corners: { home: number | null; away: number | null };
    cards: { home: number | null; away: number | null };
  };
  challengeType?: { slug: string; name: string; question: string; pickType: PickType };
  questionName?: string;
  creatorPick: Pick;
  creatorPickLabel: string;
  opponentPick: Pick | null;
  opponentPickLabel: string | null;
}
export type Outcome = 'WIN' | 'LOSS' | 'DRAW' | 'REFUNDED' | null;

export interface MatchPlayer {
  userId: number;
  username: string;
  displayName: string;
  avatarColor: string;
  isBot: boolean;
  slot: number;
  ready: boolean;
  lockedIn: boolean;
  started: boolean;
  submitted: boolean;
  /** True while this player still has to act (lock in / finish) in the current phase. */
  owesAction: boolean;
  /** This player's own deadline, including any reconnection grace. */
  deadline: string | null;
  connected: boolean;
  /** Set only while they are offline with a reconnection window running. */
  reconnectDeadline: string | null;
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
  category: MatchCategory;
  football: FootballMatchInfo | null;
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
  endReason: EndReason;
  abandonedBy: number | null;
  createdBy: number;
  createdAt: string;
  matchedAt: string | null;
  lockedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  timers: MatchTimers;
  viewerId: number;
  players: MatchPlayer[];
}

export interface MatchSummary {
  id: number;
  code: string;
  status: MatchStatus;
  displayState: DisplayState;
  endReason: EndReason;
  abandonedBy: number | null;
  source: string;
  category: MatchCategory;
  football: {
    fixtureId: number | null; competition: string; homeTeam: string; awayTeam: string; questionName: string;
    challengeTypeSlug: string | null; question: string | null; kickoffAt: string | null; fixtureStatus: FixtureStatus | null; minute: number | null;
    homeScore: number | null; awayScore: number | null; myPickLabel: string | null; opponentPickLabel: string | null;
  } | null;
  timers: Omit<MatchTimers, 'serverNow' | 'kickoffAt'> | null;
  lockedIn: boolean | null;
  opponentLockedIn: boolean | null;
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
  h2hScore: number;
  currentWinStreak: number;
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
  football?: {
    fixtureId: number; competition: string; homeTeam: string; awayTeam: string; kickoffAt: string;
    question: string; pickType: PickType; creatorPick: Pick; creatorPickLabel: string;
    homePickLabel: string; awayPickLabel: string;
  };
}

// ---------------------------------------------------------------------------
// Football
// ---------------------------------------------------------------------------

export type FixtureStatus = 'SCHEDULED' | 'LIVE' | 'FINISHED' | 'POSTPONED' | 'CANCELLED' | 'ABANDONED';

export interface FootballCompetition { id: number; code: string; name: string; country: string | null; emblemUrl: string | null; }

export interface FootballTeam { id: number; name: string; shortName: string | null; crestUrl: string | null; }

export interface FootballChallengeType {
  id: number; slug: string; name: string; question: string; pickType: PickType; settlementSummary: string;
}

export interface FootballFixture {
  id: number;
  competition: { id: number; code: string; name: string };
  homeTeam: FootballTeam;
  awayTeam: FootballTeam;
  kickoffAt: string;
  status: FixtureStatus;
  minute: number | null;
  homeScore: number | null;
  awayScore: number | null;
  isSimulated: boolean;
  openChallenges: number;
  challengeTypes?: FootballChallengeType[];
  stakes?: number[];
}

/** A publicly discoverable "Find an opponent" challenge, waiting for a second player to join. */
export interface OpenFootballChallenge {
  matchId: number;
  code: string;
  stake: number;
  createdAt: string;
  acceptanceDeadline: string;
  kickoffAt: string;
  creator: { username: string; avatarColor: string };
  fixtureId: number;
  competition: { name: string; code: string };
  homeTeam: string;
  awayTeam: string;
  challengeType: { slug: string; name: string; question: string; pickType: PickType };
  creatorPick: Pick;
  creatorPickLabel: string;
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
  abandonmentFee: number;
  timers: {
    challengeAcceptanceSeconds: number; lockInSeconds: number; lockedGameSeconds: number;
    playerActionSeconds: number; reconnectionSeconds: number; footballResultTimeoutMinutes: number;
  };
}

/** The viewer's own completed-challenge record against another player. */
export interface Rivalry {
  played: number;
  myWins: number;
  theirWins: number;
  draws: number;
  isRivalry: boolean;
  recent: { code: string; category: MatchCategory; completedAt: string; stake: number; myOutcome: Outcome; label: string }[];
}

export interface PlayerSearchResult { id: number; username: string; displayName: string; avatarColor: string; isBot: boolean; online: boolean; }
