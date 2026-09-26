import http from 'node:http';
import { Server } from 'socket.io';
import { config } from './config.js';
import { createApp } from './app.js';
import { pool } from './db.js';
import { setIo } from './realtime.js';
import { authenticateToken } from './middleware/auth.js';
import { sweepMatches } from './services/matchService.js';
import { expireChallenges } from './services/challengeService.js';

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
    socket.join(`user:${socket.data.userId}`);
    if (socket.data.role === 'ADMIN') socket.join('admins');
  });
  setIo(io);
  return { app, server, io };
}

export function startSweeper() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await expireChallenges();
      await sweepMatches();
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

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const { server } = createServer();
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error(`\n  Could not connect to MySQL at ${config.db.host}:${config.db.port}/${config.db.database}: ${err.message}\n  Check DB_* in backend/.env and run "npm run db:reset".\n`);
    process.exit(1);
  }
  startSweeper();
  server.listen(config.port, () => {
    console.log(`\n  ${config.appName} API (DEMO MODE — simulated funds only)`);
    console.log(`  Listening on http://localhost:${config.port}/api\n`);
  });
}
