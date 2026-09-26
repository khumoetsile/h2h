import { query, queryOne } from '../db.js';

/** Current streak from a list of outcomes ordered newest-first. */
export function computeStreak(outcomes) {
  const decisive = outcomes.filter((o) => o === 'WIN' || o === 'LOSS');
  if (!decisive.length) return { type: null, count: 0, label: '—' };
  const first = decisive[0];
  let count = 0;
  for (const o of decisive) { if (o === first) count++; else break; }
  const type = first === 'WIN' ? 'W' : 'L';
  return { type, count, label: `${type}${count}` };
}

function bestWinStreak(outcomesOldestFirst) {
  let best = 0; let cur = 0;
  for (const o of outcomesOldestFirst) {
    if (o === 'WIN') { cur++; best = Math.max(best, cur); } else if (o === 'LOSS') cur = 0;
  }
  return best;
}

async function outcomesByUser(userIds) {
  if (!userIds.length) return {};
  const rows = await query(
    `SELECT mp.user_id, mp.outcome FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE m.status = 'COMPLETED' AND mp.user_id IN (?) ORDER BY m.completed_at DESC, m.id DESC`,
    [userIds],
  );
  const out = {};
  for (const r of rows) (out[r.user_id] ??= []).push(r.outcome);
  return out;
}

export async function getUserStats(userId) {
  const totals = await queryOne(
    `SELECT
       SUM(m.status = 'COMPLETED') AS played,
       SUM(mp.outcome = 'WIN') AS wins,
       SUM(mp.outcome = 'LOSS') AS losses,
       SUM(mp.outcome = 'DRAW') AS draws,
       SUM(m.status = 'CANCELLED') AS cancelled,
       COALESCE(SUM(CASE WHEN mp.outcome = 'WIN' THEN mp.payout ELSE 0 END), 0) AS winnings,
       COALESCE(SUM(CASE WHEN m.status = 'COMPLETED' THEN mp.stake ELSE 0 END), 0) AS staked,
       COALESCE(SUM(CASE WHEN m.status = 'COMPLETED' THEN mp.payout - mp.stake ELSE 0 END), 0) AS net
     FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.user_id = ?`,
    [userId],
  );
  const outcomes = (await outcomesByUser([userId]))[userId] || [];
  const wins = Number(totals.wins || 0);
  const losses = Number(totals.losses || 0);
  const perGame = await query(
    `SELECT g.id, g.slug, g.name, g.accent_color,
            COUNT(x.match_id) AS played, SUM(x.outcome = 'WIN') AS wins, SUM(x.outcome = 'LOSS') AS losses,
            MAX(x.score) AS best_score, ROUND(AVG(x.score)) AS avg_score,
            COALESCE(SUM(CASE WHEN x.outcome = 'WIN' THEN x.payout ELSE 0 END), 0) AS winnings
     FROM games g
     LEFT JOIN (
       SELECT m.game_id, mp.match_id, mp.outcome, mp.payout, gr.score
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id AND m.status = 'COMPLETED'
       LEFT JOIN game_results gr ON gr.match_id = m.id AND gr.user_id = mp.user_id AND gr.is_valid = 1
       WHERE mp.user_id = ?
     ) x ON x.game_id = g.id
     GROUP BY g.id ORDER BY g.sort_order`,
    [userId],
  );
  const rt = await queryOne(
    `SELECT MIN(JSON_EXTRACT(gr.summary, '$.bestReactionMs')) AS best, ROUND(AVG(JSON_EXTRACT(gr.summary, '$.averageReactionMs'))) AS avg
     FROM game_results gr JOIN matches m ON m.id = gr.match_id JOIN games g ON g.id = m.game_id
     WHERE gr.user_id = ? AND g.slug = 'reaction-rush' AND gr.is_valid = 1 AND m.status = 'COMPLETED'`,
    [userId],
  );
  const decided = wins + losses;
  return {
    played: Number(totals.played || 0),
    wins,
    losses,
    draws: Number(totals.draws || 0),
    cancelled: Number(totals.cancelled || 0),
    winRate: decided ? Math.round((wins / decided) * 1000) / 10 : 0,
    streak: computeStreak(outcomes),
    bestWinStreak: bestWinStreak([...outcomes].reverse()),
    totalWinnings: Number(totals.winnings || 0),
    totalStaked: Number(totals.staked || 0),
    netResult: Number(totals.net || 0),
    reactionRush: { bestReactionMs: rt?.best != null ? Number(rt.best) : null, averageReactionMs: rt?.avg != null ? Number(rt.avg) : null },
    perGame: perGame.map((g) => ({
      gameId: g.id, slug: g.slug, name: g.name, accentColor: g.accent_color,
      played: Number(g.played || 0), wins: Number(g.wins || 0), losses: Number(g.losses || 0),
      bestScore: g.best_score, averageScore: g.avg_score != null ? Number(g.avg_score) : null, winnings: Number(g.winnings || 0),
    })),
    isDemo: true,
  };
}

const PERIODS = { daily: 'INTERVAL 1 DAY', weekly: 'INTERVAL 7 DAY', all: null };

export async function leaderboard(period = 'all', { limit = 50, gameId = null } = {}) {
  const interval = PERIODS[period] === undefined ? null : PERIODS[period];
  const params = [];
  let filter = `m.status = 'COMPLETED' AND u.role = 'PLAYER' AND u.status = 'ACTIVE'`;
  if (interval) filter += ` AND m.completed_at >= NOW() - ${interval}`;
  if (gameId) { filter += ' AND m.game_id = ?'; params.push(gameId); }
  const rows = await query(
    `SELECT u.id, u.username, u.avatar_color, u.is_bot,
            COUNT(*) AS played, SUM(mp.outcome = 'WIN') AS wins, SUM(mp.outcome = 'LOSS') AS losses,
            COALESCE(SUM(CASE WHEN mp.outcome = 'WIN' THEN mp.payout ELSE 0 END), 0) AS winnings
     FROM match_players mp JOIN matches m ON m.id = mp.match_id JOIN users u ON u.id = mp.user_id
     WHERE ${filter}
     GROUP BY u.id
     ORDER BY wins DESC, (SUM(mp.outcome = 'WIN') / NULLIF(SUM(mp.outcome IN ('WIN','LOSS')), 0)) DESC, winnings DESC, u.username ASC
     LIMIT ?`,
    [...params, Math.min(Number(limit) || 50, 200)],
  );
  const streaks = await outcomesByUser(rows.map((r) => r.id));
  return rows.map((r, i) => {
    const wins = Number(r.wins || 0);
    const losses = Number(r.losses || 0);
    return {
      rank: i + 1,
      userId: r.id,
      username: r.username,
      avatarColor: r.avatar_color,
      isBot: !!r.is_bot,
      played: Number(r.played),
      wins,
      losses,
      winRate: wins + losses ? Math.round((wins / (wins + losses)) * 1000) / 10 : 0,
      totalWinnings: Number(r.winnings),
      streak: computeStreak(streaks[r.id] || []),
    };
  });
}

export async function leaderboardPosition(userId, period = 'all') {
  const board = await leaderboard(period, { limit: 200 });
  const entry = board.find((e) => e.userId === userId);
  return { rank: entry ? entry.rank : null, of: board.length };
}
