import 'dotenv/config';

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number`);
  return n;
}

function positive(name, fallback) {
  const n = num(name, fallback);
  if (!(n > 0)) throw new Error(`Env var ${name} must be greater than zero`);
  return n;
}

const env = process.env.NODE_ENV || 'development';

export const config = {
  appName: process.env.APP_NAME || 'Rivalis',
  env,
  isTest: env === 'test',
  port: num('PORT', 3000),
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:4200').split(',').map((s) => s.trim()).filter(Boolean),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: num('DB_PORT', 3306),
    user: process.env.DB_USER || 'rivalis',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'rivalis_dev',
  },
  jwtSecret: process.env.JWT_SECRET || (env === 'production' ? null : 'dev-insecure-secret'),
  sessionTtlHours: num('SESSION_TTL_HOURS', 12),
  sessionRememberTtlDays: num('SESSION_REMEMBER_TTL_DAYS', 30),
  currencySymbol: process.env.CURRENCY_SYMBOL || 'P',
  currencyCode: process.env.CURRENCY_CODE || 'BWP',
  demoBotsEnabled: (process.env.DEMO_BOTS_ENABLED || 'true') === 'true',
  sweeperIntervalSeconds: num('SWEEPER_INTERVAL_SECONDS', 5),
  // Every PvP timer lives here and only here. The server stamps absolute
  // deadlines onto the match/challenge row at each state transition using
  // these durations; clients only ever render the remaining time against
  // those stored deadlines. See README "Timers".
  timers: {
    // Find Opponent (open) and direct challenges: time for someone to accept.
    challengeAcceptanceSeconds: positive('CHALLENGE_ACCEPTANCE_TIMEOUT_SECONDS', 300),
    // Once two players are matched: time for both to press Lock In.
    lockInSeconds: positive('LOCK_IN_TIMEOUT_SECONDS', 120),
    // Once both are locked in (skill games): time to complete the game.
    lockedGameSeconds: positive('LOCKED_GAME_TIMEOUT_SECONDS', 600),
    // Once one player has acted (locked in / finished): time for the other.
    playerActionSeconds: positive('PLAYER_ACTION_TIMEOUT_SECONDS', 120),
    // Grace for a player whose connection drops before their deadline.
    reconnectionSeconds: positive('RECONNECTION_TIMEOUT_SECONDS', 60),
    // Football: how long after kickoff we wait for a verifiable result before voiding.
    footballResultTimeoutMinutes: positive('FOOTBALL_RESULT_TIMEOUT_MINUTES', 240),
    // Network allowance for a request that was sent just before a deadline.
    latencyGraceMs: num('TIMER_LATENCY_GRACE_MS', 2000),
  },
  // Flat fee for leaving a challenge after both players locked in. Server-side only.
  abandonmentFee: positive('ABANDONMENT_FEE', 0.5),
  // The platform is a prototype: money is ALWAYS simulated. There is intentionally
  // no runtime switch to turn this off — enabling real money is a deliberate
  // future code change made only after the relevant Botswana regulatory and
  // licensing review, not a config flag. See README "Path to real money".
  demoMode: true,
  football: {
    // 'mock' (default): a fully self-contained, clearly-labelled simulated
    // provider — deterministic, needs no API key, safe for local dev/testing.
    // 'football-data': a real implementation against api.football-data.org.
    // Swap providers with zero code changes elsewhere in the app.
    //
    // The test suite ALWAYS uses 'mock', regardless of FOOTBALL_PROVIDER in
    // .env: tests seed their own deterministic mock fixtures and assert on
    // mock capabilities (statistics/events available), so a developer's real
    // provider key for local manual testing must never change what `npm
    // test` exercises or silently disable the stats-dependent test cases.
    provider: env === 'test' ? 'mock' : (process.env.FOOTBALL_PROVIDER || 'mock'),
    apiKey: process.env.FOOTBALL_API_KEY || '',
    apiBaseUrl: process.env.FOOTBALL_API_BASE_URL || 'https://api.football-data.org/v4',
    syncIntervalSeconds: num('FOOTBALL_SYNC_INTERVAL_SECONDS', 20),
    fixtureWindowDays: num('FOOTBALL_FIXTURE_WINDOW_DAYS', 21),
  },
};

if (!config.jwtSecret) throw new Error('JWT_SECRET must be set in production');
