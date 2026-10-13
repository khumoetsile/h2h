import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { optionalAuth, requireAuth, requirePlayer } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { ah } from '../utils/errors.js';
import * as chess from '../services/chessService.js';

const router = Router();
const createSchema = z.object({ stake: z.number().finite().positive(), opponent: z.union([z.string().trim().min(3).max(21), z.number().int().positive()]).optional() });
const moveSchema = z.object({ from: z.string().regex(/^[a-h][1-8]$/), to: z.string().regex(/^[a-h][1-8]$/), promotion: z.enum(['q', 'r', 'b', 'n']).optional(), version: z.number().int().nonnegative() });
const drawSchema = z.object({ action: z.enum(['offer', 'accept', 'decline']) });
const moveLimit = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => process.env.NODE_ENV === 'test', message: { error: { code: 'TOO_MANY_ACTIONS', message: 'Too many chess actions. Wait a moment, then try again.' } } });

router.get('/config', ah(async (_req, res) => res.json(await chess.chessConfig())));
router.get('/', requireAuth, ah(async (req, res) => res.json(await chess.listChess(req.user.id))));
router.get('/:code', optionalAuth, ah(async (req, res) => res.json({ game: await chess.getChessView(req.params.code, req.user?.id, { admin: req.user?.role === 'ADMIN' }) })));
router.post('/', requireAuth, requirePlayer, moveLimit, validate(createSchema), ah(async (req, res) => res.status(201).json({ game: await chess.createChess(req.user.id, req.body) })));
router.post('/:code/accept', requireAuth, requirePlayer, moveLimit, ah(async (req, res) => res.json({ game: await chess.acceptChess(req.user.id, req.params.code) })));
router.post('/:code/move', requireAuth, requirePlayer, moveLimit, validate(moveSchema), ah(async (req, res) => res.json({ game: await chess.moveChess(req.user.id, req.params.code, req.body) })));
router.post('/:code/resign', requireAuth, requirePlayer, moveLimit, ah(async (req, res) => res.json({ game: await chess.resignChess(req.user.id, req.params.code) })));
router.post('/:code/cancel', requireAuth, requirePlayer, moveLimit, ah(async (req, res) => res.json({ game: await chess.cancelChess(req.user.id, req.params.code) })));
router.post('/:code/decline', requireAuth, requirePlayer, moveLimit, ah(async (req, res) => res.json({ game: await chess.declineChess(req.user.id, req.params.code) })));
router.post('/:code/draw', requireAuth, requirePlayer, moveLimit, validate(drawSchema), ah(async (req, res) => res.json({ game: await chess.drawChess(req.user.id, req.params.code, req.body) })));

export default router;
