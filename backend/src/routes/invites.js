import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { ah, notFound } from '../utils/errors.js';
import { queryOne } from '../db.js';

const router = Router();
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.isTest ? 10000 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment.' } }),
});

/**
 * What an invite link shows to someone who may not have an account yet: who is challenging, to what,
 * and whether the seat is still free. Public, so it reveals only the bare minimum.
 */
router.get('/:code', limiter, ah(async (req, res) => {
  const m = await queryOne(
    `SELECT m.code, m.stake, m.prize, m.status, m.source, m.acceptance_deadline,
            g.slug AS game_slug, g.name AS game_name, g.accent_color, g.tagline,
            u.username, u.avatar_color
       FROM matches m
       JOIN games g ON g.id = m.game_id
       JOIN users u ON u.id = m.created_by AND u.is_bot = 0
      WHERE m.code = ? AND m.category = 'SKILL_GAME' AND m.source IN ('DIRECT', 'MATCHMAKING')`,
    [String(req.params.code).slice(0, 40)],
  );
  if (!m) throw notFound('This invite link is not valid.');
  const expired = m.acceptance_deadline && new Date(m.acceptance_deadline).getTime() <= Date.now();
  const state = m.status === 'WAITING' ? (expired ? 'EXPIRED' : 'OPEN') : (m.status === 'CANCELLED' ? 'EXPIRED' : 'TAKEN');
  res.json({
    invite: {
      code: m.code,
      state,
      stake: Number(m.stake),
      prize: Number(m.prize),
      expiresAt: state === 'OPEN' ? m.acceptance_deadline : null,
      game: { slug: m.game_slug, name: m.game_name, accentColor: m.accent_color, tagline: m.tagline },
      from: { username: m.username, avatarColor: m.avatar_color },
    },
  });
}));

export default router;
