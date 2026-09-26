import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../utils/errors.js';
import { validate } from '../middleware/validate.js';
import { leaderboard } from '../services/statsService.js';

const router = Router();
const q = z.object({
  period: z.enum(['daily', 'weekly', 'all']).optional(),
  gameId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

router.get('/', validate(q, 'query'), ah(async (req, res) => {
  const { period = 'all', gameId, limit } = req.validatedQuery;
  const entries = await leaderboard(period, { gameId, limit });
  res.json({ period, entries, me: entries.find((e) => e.userId === req.user.id) || null });
}));

export default router;
