import 'dotenv/config';

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number`);
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
  sweeperIntervalSeconds: num('SWEEPER_INTERVAL_SECONDS', 15),
  // The platform is a prototype: money is ALWAYS simulated. There is intentionally
  // no switch to turn this off.
  demoMode: true,
};

if (!config.jwtSecret) throw new Error('JWT_SECRET must be set in production');
