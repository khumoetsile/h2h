// Development seed data. EVERYTHING here is DEMO data (users are flagged with
// is_demo_data = 1 and all balances are simulated demo funds).
//
// Matches are seeded by actually running the game engines against bot-style
// play so that scores, results and ledger entries are internally consistent.
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../src/db.js';
import { config } from '../src/config.js';
import { SETTING_DEFAULTS, SETTING_DESCRIPTIONS } from '../src/services/settingsService.js';
import { getEngine } from '../src/games/index.js';
import { createRng } from '../src/games/rng.js';
import { computePrize, fromCents, toCents } from '../src/utils/money.js';
import { matchCode, txReference } from '../src/utils/ids.js';

// Copy here is player-facing: short, plain, jargon-free. Save the mechanical
// detail (scoring formulas, "seed", "server") for the in-app "How to play"
// panel only, and even there keep it in plain language.
const GAMES = [
  {
    slug: 'reaction-rush', name: 'Reaction Rush', tagline: 'Test how fast you can react.', accent: '#22D3EE', duration: 45,
    description: 'A target pops up on your screen — tap it before your opponent taps theirs. 10 rounds. Fastest total time wins.',
    how: 'Wait for the target to appear, then tap it as fast as you can. The quicker you react, the more points you score. Tap too early or miss and you score nothing for that round. After 10 rounds, whoever scored the most wins.',
  },
  {
    slug: 'penalty-shootout', name: 'Penalty Shootout', tagline: 'Score more goals than your opponent.', accent: '#10B981', duration: 40,
    description: 'Take 5 penalty shots. Time it right to beat the keeper and score more goals than your opponent.',
    how: 'Watch the marker slide across the goal and tap to shoot. The keeper often dives the way they\'re leaning, so aim the other way. Score in the corners for extra points. After 5 shots each, most goals wins.',
  },
  {
    slug: 'word-battle', name: 'Word Battle', tagline: 'Think faster than your opponent.', accent: '#A855F7', duration: 90,
    description: 'Unscramble 8 mixed-up words as quickly as you can. Faster, correct answers score more.',
    how: 'The letters of a word are jumbled up — type the real word and hit enter. You have 20 seconds per word, and you can skip one if you\'re stuck. Whoever scores the most after 8 words wins.',
  },
  {
    slug: 'memory-battle', name: 'Memory Battle', tagline: 'Remember more and score more.', accent: '#F97316', duration: 80,
    description: 'Watch the tiles light up, then repeat the pattern from memory. Patterns get longer each round.',
    how: 'A sequence of tiles flashes on the grid — watch closely, then tap them back in the same order. Patterns start short and get longer each round. Whoever remembers the most wins.',
  },
  {
    slug: 'aim-challenge', name: 'Aim Challenge', tagline: 'Hit more targets than your opponent.', accent: '#EF4444', duration: 35,
    description: '20 targets appear one after another and shrink fast — hit as many as you can, right in the centre.',
    how: 'Targets pop up and shrink away quickly — tap each one before it disappears. Hitting the centre scores more than a glancing hit. Whoever hits the most (and most accurately) wins.',
  },
];

const PASSWORD_PLAYER = 'Player123!';
const PASSWORD_ADMIN = 'Admin123!';

const USERS = [
  { first: 'Ada', last: 'Admin', username: 'admin', email: 'admin@example.com', phone: '+267 71 000 001', role: 'ADMIN', password: PASSWORD_ADMIN, color: '#EAB308', balance: 0 },
  { first: 'Demo', last: 'Player', username: 'player', email: 'player@example.com', phone: '+267 71 000 002', password: PASSWORD_PLAYER, color: '#3B82F6', balance: 500 },
  { first: 'Kabelo', last: 'Molefe', username: 'Kabelo', email: 'kabelo@example.com', phone: '+267 72 111 222', password: PASSWORD_PLAYER, color: '#22D3EE', balance: 750 },
  { first: 'Neo', last: 'Dube', username: 'NeoStrike', email: 'neo@example.com', phone: '+267 73 222 333', password: PASSWORD_PLAYER, color: '#A855F7', balance: 420 },
  { first: 'Lesedi', last: 'Kgosi', username: 'LesediK', email: 'lesedi@example.com', phone: '+267 74 333 444', password: PASSWORD_PLAYER, color: '#F97316', balance: 610 },
  { first: 'Tumi', last: 'Seretse', username: 'TumiFlash', email: 'tumi@example.com', phone: '+267 75 444 555', password: PASSWORD_PLAYER, color: '#10B981', balance: 380 },
  { first: 'Onalenna', last: 'Phiri', username: 'OnaPro', email: 'ona@example.com', phone: '+267 76 555 666', password: PASSWORD_PLAYER, color: '#EC4899', balance: 290 },
  { first: 'Boitumelo', last: 'Tau', username: 'B_Tau', email: 'boitumelo@example.com', phone: '+267 77 666 777', password: PASSWORD_PLAYER, color: '#6366F1', balance: 530, disabled: true },
  // House bots — opponents for solo testing ("Play a demo opponent").
  { first: 'Rival', last: 'Bot', username: 'RivalBot', email: 'rivalbot@bots.invalid', phone: '+267 70 000 101', password: null, color: '#64748B', balance: 5000, bot: true },
  { first: 'Circuit', last: 'Bot', username: 'CircuitAce', email: 'circuit@bots.invalid', phone: '+267 70 000 102', password: null, color: '#94A3B8', balance: 5000, bot: true },
  { first: 'Pixel', last: 'Bot', username: 'PixelPro', email: 'pixel@bots.invalid', phone: '+267 70 000 103', password: null, color: '#475569', balance: 5000, bot: true },
];

async function insertTx(tx, { userId, walletId, type, direction, amount, avail, locked, description, status = 'COMPLETED', matchId = null, key = null, at }) {
  await tx.q(
    `INSERT INTO transactions (reference, user_id, wallet_id, type, direction, amount, available_after, locked_after, description, status, match_id, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [txReference(), userId, walletId, type, direction, amount, fromCents(avail), fromCents(locked), description, status, matchId, key, at],
  );
}

export async function seed({ log = console.log } = {}) {
  const [[existing]] = await pool.query('SELECT COUNT(*) AS n FROM users');
  if (existing.n > 0) {
    log('Database already has users — skipping seed. Run "npm run db:reset" to start fresh.');
    return;
  }
  const hashes = {
    [PASSWORD_PLAYER]: await bcrypt.hash(PASSWORD_PLAYER, 10),
    [PASSWORD_ADMIN]: await bcrypt.hash(PASSWORD_ADMIN, 10),
    bot: await bcrypt.hash(`bot-${Math.random()}-${Date.now()}`, 10),
  };

  await withTransaction(async (tx) => {
    // Settings
    for (const [k, v] of Object.entries(SETTING_DEFAULTS)) {
      await tx.q('INSERT INTO admin_settings (setting_key, setting_value, description) VALUES (?, CAST(? AS JSON), ?)', [k, JSON.stringify(v), SETTING_DESCRIPTIONS[k]]);
    }
    // Games
    const gameIds = {};
    for (const [i, g] of GAMES.entries()) {
      const r = await tx.q(
        `INSERT INTO games (slug, name, tagline, description, how_to_play, mode, estimated_duration_seconds, accent_color, sort_order) VALUES (?, ?, ?, ?, ?, '1v1', ?, ?, ?)`,
        [g.slug, g.name, g.tagline, g.description, g.how, g.duration, g.accent, i + 1],
      );
      gameIds[g.slug] = r.insertId;
    }
    // Users + wallets. The whole history is backdated so the ledger reads naturally.
    const day = 86400000;
    const start = Date.now() - 20 * day;
    const users = {};
    for (const u of USERS) {
      const r = await tx.q(
        `INSERT INTO users (first_name, last_name, username, email, phone, password_hash, role, status, avatar_color, is_demo_data, is_bot, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        [u.first, u.last, u.username, u.email, u.phone, u.bot ? hashes.bot : hashes[u.password], u.role || 'PLAYER', u.disabled ? 'DISABLED' : 'ACTIVE', u.color, u.bot ? 1 : 0, new Date(start), u.bot ? null : new Date(Date.now() - Math.random() * 2 * day)],
      );
      const w = await tx.q('INSERT INTO wallets (user_id, created_at) VALUES (?, ?)', [r.insertId, new Date(start)]);
      users[u.username] = { id: r.insertId, walletId: w.insertId, avail: 0, locked: 0, ...u };
      if (u.balance > 0) {
        users[u.username].avail = toCents(u.balance);
        await insertTx(tx, {
          userId: r.insertId, walletId: w.insertId, type: 'DEPOSIT', direction: 'CREDIT', amount: u.balance, avail: toCents(u.balance), locked: 0,
          description: u.bot ? 'House bot float — DEMO FUNDS' : 'Welcome bonus + demo deposit — DEMO FUNDS (no real money)', status: 'DEMO_COMPLETED', at: new Date(start),
        });
      }
    }

    // Completed / cancelled matches between players (and some vs bots).
    const fee = SETTING_DEFAULTS.platform_fee_percent;
    const pairs = [
      ['player', 'Kabelo', 'reaction-rush', 20], ['NeoStrike', 'player', 'reaction-rush', 10], ['player', 'LesediK', 'penalty-shootout', 50],
      ['Kabelo', 'NeoStrike', 'reaction-rush', 20], ['TumiFlash', 'Kabelo', 'word-battle', 10], ['LesediK', 'OnaPro', 'memory-battle', 5],
      ['Kabelo', 'LesediK', 'aim-challenge', 20], ['NeoStrike', 'TumiFlash', 'reaction-rush', 50], ['OnaPro', 'player', 'word-battle', 10],
      ['Kabelo', 'OnaPro', 'reaction-rush', 100], ['player', 'RivalBot', 'reaction-rush', 20], ['TumiFlash', 'LesediK', 'penalty-shootout', 20],
      ['NeoStrike', 'Kabelo', 'memory-battle', 20], ['player', 'TumiFlash', 'aim-challenge', 10], ['LesediK', 'NeoStrike', 'reaction-rush', 10],
      ['Kabelo', 'TumiFlash', 'reaction-rush', 50], ['OnaPro', 'NeoStrike', 'penalty-shootout', 5], ['player', 'CircuitAce', 'memory-battle', 10],
      ['Kabelo', 'player', 'reaction-rush', 20], ['LesediK', 'TumiFlash', 'word-battle', 20], ['NeoStrike', 'OnaPro', 'aim-challenge', 10],
      ['Kabelo', 'LesediK', 'reaction-rush', 10], ['player', 'NeoStrike', 'penalty-shootout', 20], ['TumiFlash', 'OnaPro', 'reaction-rush', 20],
    ];
    const rng = createRng(20260926);
    let t = start + day;
    const step = (18 * day) / (pairs.length + 2);
    for (const [idx, [aName, bName, slug, stake]] of pairs.entries()) {
      t += step * (0.6 + rng.next() * 0.8);
      const a = users[aName];
      const b = users[bName];
      const gameName = GAMES.find((g) => g.slug === slug).name;
      const { pool: poolAmt, fee: feeAmt, prize } = computePrize(stake, fee);
      const seed = rng.int(1, 2 ** 31);
      const code = matchCode();
      const cancelled = idx === 5 || idx === 14;
      const created = new Date(t);
      const completed = new Date(t + 4 * 60000);
      const mr = await tx.q(
        `INSERT INTO matches (code, game_id, stake, pool, fee_percent, fee_amount, prize, status, source, created_by, seed, created_at, matched_at, ready_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'WAITING', ?, ?, ?, ?, ?, ?, ?)`,
        [code, gameIds[slug], stake, poolAmt, fee, feeAmt, prize, idx % 4 === 0 ? 'CHALLENGE' : 'MATCHMAKING', a.id, seed, created, new Date(t + 30000), new Date(t + 60000), cancelled ? null : new Date(t + 90000)],
      );
      const matchId = mr.insertId;
      const m = { id: matchId, code, stake, prize };
      for (const [slot, p] of [[1, a], [2, b]]) {
        p.avail -= toCents(stake); p.locked += toCents(stake);
        await insertTx(tx, { userId: p.id, walletId: p.walletId, type: 'GAME_ENTRY', direction: 'DEBIT', amount: stake, avail: p.avail, locked: p.locked, description: `${gameName} entry`, matchId, key: `match:${matchId}:entry:${p.id}`, at: new Date(t + slot * 15000) });
        await tx.q('INSERT INTO match_players (match_id, user_id, slot, stake, joined_at, ready_at, started_at, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [matchId, p.id, slot, stake, created, cancelled ? null : new Date(t + 60000), cancelled ? null : new Date(t + 90000), cancelled ? null : completed]);
      }
      if (cancelled) {
        for (const p of [a, b]) {
          p.avail += toCents(stake); p.locked -= toCents(stake);
          await insertTx(tx, { userId: p.id, walletId: p.walletId, type: 'REFUND', direction: 'CREDIT', amount: stake, avail: p.avail, locked: p.locked, description: 'Refund: player left before the game started', matchId, key: `match:${matchId}:refund:${p.id}`, at: new Date(t + 120000) });
        }
        await tx.q(`UPDATE match_players SET outcome = 'REFUNDED', payout = stake WHERE match_id = ?`, [matchId]);
        await tx.q(`UPDATE matches SET status = 'CANCELLED', cancelled_at = ?, settled_at = ?, cancel_reason = 'player left before the game started' WHERE id = ?`, [new Date(t + 120000), new Date(t + 120000), matchId]);
        continue;
      }
      // Play the real engine for both sides.
      const engine = getEngine(slug);
      const spec = engine.buildSpec(seed);
      const scores = [a, b].map((p, i) => engine.score(spec, engine.botPlay(spec, createRng(seed + i * 7919 + p.id), seed), seed));
      for (const [i, p] of [a, b].entries()) {
        await tx.q(
          `INSERT INTO game_results (match_id, user_id, score, tiebreak, is_valid, summary, rounds, server_elapsed_ms, created_at) VALUES (?, ?, ?, ?, 1, CAST(? AS JSON), CAST(? AS JSON), ?, ?)`,
          [matchId, p.id, scores[i].score, scores[i].tiebreak, JSON.stringify(scores[i].summary), JSON.stringify(scores[i].rounds), 60000 + rng.int(0, 20000), completed],
        );
      }
      const cmp = (scores[0].score - scores[1].score) || (scores[0].tiebreak - scores[1].tiebreak);
      const winner = cmp >= 0 ? a : b;
      const loser = winner === a ? b : a;
      winner.locked -= toCents(stake); winner.avail += toCents(prize);
      loser.locked -= toCents(stake);
      await insertTx(tx, { userId: winner.id, walletId: winner.walletId, type: 'GAME_WIN', direction: 'CREDIT', amount: prize, avail: winner.avail, locked: winner.locked, description: `${gameName} win`, matchId, key: `match:${matchId}:win`, at: completed });
      await tx.q(`UPDATE match_players SET outcome = 'WIN', payout = ? WHERE match_id = ? AND user_id = ?`, [prize, matchId, winner.id]);
      await tx.q(`UPDATE match_players SET outcome = 'LOSS', payout = 0 WHERE match_id = ? AND user_id = ?`, [matchId, loser.id]);
      await tx.q(`UPDATE matches SET status = 'COMPLETED', winner_id = ?, completed_at = ?, settled_at = ?, result_reason = ? WHERE id = ?`, [winner.id, completed, completed, cmp === 0 ? 'Won on tiebreak' : 'Higher score', matchId]);
      void m;
    }

    // A couple of demo deposits / withdrawals for the main player.
    const p = users.player;
    for (const [type, amt, off] of [['DEPOSIT', 100, 5], ['WITHDRAWAL', 50, 3]]) {
      p.avail += type === 'DEPOSIT' ? toCents(amt) : -toCents(amt);
      await insertTx(tx, {
        userId: p.id, walletId: p.walletId, type, direction: type === 'DEPOSIT' ? 'CREDIT' : 'DEBIT', amount: amt, avail: p.avail, locked: p.locked,
        description: type === 'DEPOSIT' ? 'Demo deposit — DEMO FUNDS (no real money)' : 'Demo withdrawal — no real money transferred', status: 'DEMO_COMPLETED', at: new Date(Date.now() - off * day),
      });
    }

    // Persist final wallet balances.
    for (const u of Object.values(users)) {
      await tx.q('UPDATE wallets SET available_balance = ?, locked_balance = ? WHERE id = ?', [fromCents(u.avail), fromCents(u.locked), u.walletId]);
    }

    // Challenges: pending incoming/outgoing for the demo player + history.
    const ch = async (from, to, slug, stake, status, minutesAgo, message = null) => {
      await tx.q(
        `INSERT INTO challenges (challenger_id, opponent_id, game_id, stake, message, status, expires_at, responded_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [users[from].id, users[to].id, gameIds[slug], stake, message, status,
          new Date(Date.now() + (status === 'PENDING' ? 55 : -30) * 60000), status === 'PENDING' ? null : new Date(Date.now() - (minutesAgo - 5) * 60000), new Date(Date.now() - minutesAgo * 60000)],
      );
    };
    await ch('Kabelo', 'player', 'reaction-rush', 20, 'PENDING', 5, 'Rematch? Bet you can\'t beat 250ms 😎');
    await ch('NeoStrike', 'player', 'penalty-shootout', 10, 'PENDING', 12);
    await ch('player', 'LesediK', 'word-battle', 10, 'PENDING', 3);
    await ch('TumiFlash', 'player', 'memory-battle', 5, 'DECLINED', 600);
    await ch('player', 'OnaPro', 'reaction-rush', 50, 'EXPIRED', 2000);
    await ch('LesediK', 'Kabelo', 'aim-challenge', 20, 'PENDING', 8);

    // Notifications for the demo player.
    const n = async (user, type, title, message, link, read = false, minutesAgo = 1) => {
      await tx.q('INSERT INTO notifications (user_id, type, title, message, link, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [users[user].id, type, title, message, link, read ? 1 : 0, new Date(Date.now() - minutesAgo * 60000)]);
    };
    await n('player', 'WELCOME', `Welcome to ${config.appName}!`, 'Your demo wallet has been funded with DEMO FUNDS. No real money is involved.', '/wallet', true, 20 * 1440);
    await n('player', 'CHALLENGE_RECEIVED', 'Kabelo challenged you', '@Kabelo challenged you to Reaction Rush for P20.00 DEMO.', '/challenges', false, 5);
    await n('player', 'CHALLENGE_RECEIVED', 'NeoStrike challenged you', '@NeoStrike challenged you to Penalty Shootout for P10.00 DEMO.', '/challenges', false, 12);
    await n('player', 'CHALLENGE_DECLINED', 'Challenge declined', '@TumiFlash declined your Memory Battle challenge.', '/challenges', true, 590);
    await n('Kabelo', 'CHALLENGE_RECEIVED', 'LesediK challenged you', '@LesediK challenged you to Aim Challenge for P20.00 DEMO.', '/challenges', false, 8);
  });

  log('Seed complete (DEMO DATA).');
  log('  Admin : admin@example.com / Admin123!');
  log('  Player: player@example.com / Player123!');
  log('  Opponents (password Player123!): kabelo@example.com, neo@example.com, lesedi@example.com, tumi@example.com, ona@example.com');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
