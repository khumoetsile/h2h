import { query, queryOne } from '../db.js';
import { notFound } from '../utils/errors.js';
import { computePrize } from '../utils/money.js';
import { getSettings } from './settingsService.js';
import { queueCounts } from './matchService.js';

export function mapGame(g) {
  return {
    id: g.id,
    slug: g.slug,
    name: g.name,
    tagline: g.tagline,
    description: g.description,
    howToPlay: g.how_to_play,
    mode: g.mode,
    estimatedDurationSeconds: g.estimated_duration_seconds,
    accentColor: g.accent_color,
    isEnabled: !!g.is_enabled,
    sortOrder: g.sort_order,
  };
}

export async function listGames({ includeDisabled = false } = {}) {
  const rows = await query(`SELECT * FROM games ${includeDisabled ? '' : 'WHERE is_enabled = 1'} ORDER BY sort_order, id`);
  return rows.map(mapGame);
}

/** Catalogue view: game + stakes with prize breakdown + players waiting. */
export async function catalogue() {
  const [games, settings, queue] = await Promise.all([listGames(), getSettings(), queueCounts()]);
  const stakes = settings.stake_amounts.map((s) => ({ stake: s, ...computePrize(s, settings.platform_fee_percent) }));
  return games.map((g) => ({
    ...g,
    waiting: queue[g.id]?.total || 0,
    waitingByStake: queue[g.id]?.byStake || {},
    stakes,
    minEntry: stakes[0]?.stake ?? null,
    maxPrize: stakes[stakes.length - 1]?.prize ?? null,
  }));
}

export async function getGameBySlug(slug) {
  const g = await queryOne('SELECT * FROM games WHERE slug = ? OR id = ?', [slug, Number(slug) || 0]);
  if (!g) throw notFound('Game not found.');
  const [settings, queue] = await Promise.all([getSettings(), queueCounts()]);
  return {
    ...mapGame(g),
    waiting: queue[g.id]?.total || 0,
    waitingByStake: queue[g.id]?.byStake || {},
    stakes: settings.stake_amounts.map((s) => ({ stake: s, ...computePrize(s, settings.platform_fee_percent) })),
    feePercent: settings.platform_fee_percent,
  };
}
