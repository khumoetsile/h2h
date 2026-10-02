import http from 'node:http';
import { Server } from 'socket.io';
import { config } from './config.js';
import { createApp } from './app.js';
import { pool } from './db.js';
import { migrate } from '../scripts/migrate.js';
import { isUserOnline, setIo } from './realtime.js';
import { authenticateToken } from './middleware/auth.js';
import { compensateDowntime, heartbeat, markPresence, sweepMatches } from './services/matchService.js';
import { expireChallenges } from './services/challengeService.js';
import { startFootballSync } from './football/footballSyncService.js';

export function createServer() {
  const app = createApp();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: config.corsOrigins } });

  // Socket auth uses the same token + server-side session as the REST API.
  io.use(async (socket, next) => {
    try {
      const user = await authenticateToken(socket.handshake.auth?.token);
      socket.data.userId = user.id;
      socket.data.role = user.role;
      next();
    } catch (err) {
      next(new Error(err.message || 'unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    socket.join(`user:${userId}`);
    if (socket.data.role === 'ADMIN') socket.join('admins');
    // Presence drives the reconnection window (see src/timers.js): a player
    // whose LAST connection drops while they owe an action gets a bounded
    // grace period; connecting again closes it.
    markPresence(userId, true).catch((err) => console.error('presence (online) failed', err));
    socket.on('disconnect', () => {
      if (isUserOnline(userId)) return; // another tab/device is still connected
      markPresence(userId, false).catch((err) => console.error('presence (offline) failed', err));
    });
  });
  setIo(io);
  return { app, server, io };
}

export function startSweeper() {
  let running = false;
  let booted = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (!booted) {
        // Anything that was running while this server was down gets the
        // outage added back before it can be judged as timed out.
        const extended = await compensateDowntime({ thresholdMs: Math.max(30000, config.sweeperIntervalSeconds * 3000) });
        if (extended) console.log(`  Server was down ~${extended}s. Extended running challenge timers by that amount.`);
        booted = true;
      }
      await expireChallenges();
      await sweepMatches();
      await heartbeat();
    } catch (err) {
      console.error('Sweeper error', err);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, config.sweeperIntervalSeconds * 1000);
  tick();
  return handle;
}

/** Boot the API: optional auto-migrate, DB check, background jobs, listen. */
export async function start() {
  const { server } = createServer();
  try {
    if (process.env.AUTO_MIGRATE === 'true') await migrate();
    await pool.query('SELECT 1');
  } catch (err) {
    console.error(`\n  Could not connect to MySQL at ${config.db.host}:${config.db.port}/${config.db.database}: ${err.message}\n  Check DB_* in backend/.env and run "npm run db:reset".\n`);
    process.exit(1);
  }
  startSweeper();
  startFootballSync(config.football.syncIntervalSeconds);
  server.listen(config.port, () => {
    console.log(`\n  ${config.appName} API (DEMO MODE: simulated funds only)`);
    console.log(`  Listening on http://localhost:${config.port}/api\n`);
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) await start();
