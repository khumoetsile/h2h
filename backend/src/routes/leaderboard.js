import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../utils/errors.js';
import { validate } from '../middleware/validate.js';
import { leaderboard } from '../services/statsService.js';
import { optionalAuth } from '../middleware/auth.js';
import rateLimit from 'express-rate-limit';

const router = Router();
router.use(optionalAuth, rateLimit({windowMs:60000, limit:120, standardHeaders:true, legacyHeaders:false}));
const q = z.object({
  period: z.enum(['daily', 'weekly', 'all']).optional(),
  gameId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

router.get('/', validate(q, 'query'), ah(async (req, res) => {
  const { period = 'all', gameId, limit } = req.validatedQuery;
  const entries = await leaderboard(period, { gameId, limit });
  res.set('Cache-Control', 'private, no-store');
  res.json({ period, entries, me: req.user ? entries.find((e) => e.userId === req.user.id) || null : null });
}));

export default router;
