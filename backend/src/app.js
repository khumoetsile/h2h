import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config.js';
import { requireAdmin, requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { ah } from './utils/errors.js';
import { getSettings } from './services/settingsService.js';
import { computePrize } from './utils/money.js';
import { publicTimerConfig } from './timers.js';
import authRoutes from './routes/auth.js';
import inviteRoutes from './routes/invites.js';
import pushRoutes from './routes/push.js';
import { pushStatus } from './services/pushService.js';
import meRoutes from './routes/me.js';
import walletRoutes from './routes/wallet.js';
import gameRoutes from './routes/games.js';
import matchRoutes from './routes/matches.js';
import challengeRoutes from './routes/challenges.js';
import footballRoutes from './routes/football.js';
import leaderboardRoutes from './routes/leaderboard.js';
import notificationRoutes from './routes/notifications.js';
import userRoutes from './routes/users.js';
import adminRoutes from './routes/admin.js';

/** Built frontend, if present: WEB_ROOT, ./public (deployed) or ../frontend/dist/frontend/browser (local build). */
function resolveWebRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.WEB_ROOT, path.join(here, '..', 'public'), path.join(here, '..', '..', 'frontend', 'dist', 'frontend', 'browser')];
  return candidates.find((d) => d && fs.existsSync(path.join(d, 'index.html')));
}

export function createApp() {
  const app = express();
  app.set('trust proxy', 'loopback');
  // The Angular build ships inline bootstrap snippets, so the default CSP is
  // only kept for the API-only setup.
  const webRoot = config.isTest ? undefined : resolveWebRoot();
  app.use(helmet(webRoot ? { contentSecurityPolicy: false } : undefined));
  app.use(cors({ origin: config.corsOrigins, credentials: false }));
  app.use(express.json({ limit: '100kb' }));
  if (!config.isTest) app.use(morgan('dev'));

  app.get('/api/health', (_req, res) => res.json({ ok: true, app: config.appName, demoMode: true, push: pushStatus(), time: new Date().toISOString() }));
  // Server clock for countdown display. Clients estimate their offset from
  // this; they never use their own clock to decide whether time is up.
  // Tells Google which sellers may sell this site's ads. Only exists once a publisher ID is configured.
  app.get('/ads.txt', (_req, res) => {
    const id = config.ads.client.replace(/^ca-/, '');
    if (!id) return res.sendStatus(404);
    res.type('text/plain').send(`google.com, ${id}, DIRECT, f08c47fec0942fa0\n`);
  });
  app.get('/api/time', (_req, res) => res.json({ serverNow: new Date().toISOString() }));

  // Public runtime configuration (app name, demo flags, stakes, fee).
  app.get('/api/config', ah(async (_req, res) => {
    const s = await getSettings();
    res.json({
      appName: config.appName,
      demoMode: true,
      demoNotice: 'DEMO MODE: all funds are simulated. No real money is deposited, staked, won or withdrawn.',
      currency: { symbol: config.currencySymbol, code: config.currencyCode },
      platformFeePercent: s.platform_fee_percent,
      stakeAmounts: s.stake_amounts,
      stakeBreakdown: s.stake_amounts.map((st) => ({ stake: st, ...computePrize(st, s.platform_fee_percent) })),
      depositPresets: s.deposit_presets,
      signupBonus: s.signup_bonus,
      maxDeposit: s.max_deposit,
      minWithdrawal: s.min_withdrawal,
      demoBotsEnabled: config.demoBotsEnabled,
      ads: config.ads.client ? { client: config.ads.client, slots: { home: config.ads.slotHome, list: config.ads.slotList } } : null,
      abandonmentFee: config.abandonmentFee,
      timers: publicTimerConfig(),
      serverNow: new Date().toISOString(),
    });
  }));

  app.use('/api/auth', authRoutes);
  app.use('/api/invites', inviteRoutes);
  app.use('/api', requireAuth, meRoutes); // /api/me, /api/dashboard
  app.use('/api/push', requireAuth, pushRoutes);
  app.use('/api/wallet', requireAuth, walletRoutes);
  app.use('/api/games', requireAuth, gameRoutes);
  app.use('/api/matches', requireAuth, matchRoutes);
  app.use('/api/challenges', requireAuth, challengeRoutes);
  app.use('/api/football', requireAuth, footballRoutes);
  app.use('/api/leaderboard', requireAuth, leaderboardRoutes);
  app.use('/api/notifications', requireAuth, notificationRoutes);
  app.use('/api/users', requireAuth, userRoutes);
  app.use('/api/admin', requireAuth, requireAdmin, adminRoutes);

  app.use('/api', notFoundHandler);
  // Single-origin hosting (cPanel): serve the built Angular app with SPA fallback.
  if (webRoot) {
    // Hashed build files never change, so browsers may keep them for a year. index.html and
    // the unhashed icon font are revalidated so a deploy shows up straight away.
    app.use(express.static(webRoot, {
      index: false,
      setHeaders: (res, file) => {
        if (/-[A-Z0-9]{8}\.(js|css|woff2?)$/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else if (/\.html$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
        else res.setHeader('Cache-Control', 'public, max-age=86400');
      },
    }));
    // A missing file (anything with an extension) is a real 404, not the app page.
    app.get(/\.[A-Za-z0-9]{1,8}$/, (_req, res) => res.sendStatus(404));
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => res.sendFile(path.join(webRoot, 'index.html'), { cacheControl: false, headers: { 'Cache-Control': 'no-cache' } }));
  }
  app.use(errorHandler);
  return app;
}
