import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../utils/errors.js';
import { validate } from '../middleware/validate.js';
import { requirePlayer } from '../middleware/auth.js';
import { createMatchSchema, resultSchema } from './schemas.js';
import * as svc from '../services/matchService.js';

const router = Router();
const view = (req, id) => svc.getMatchView(id, req.user.id);

const listQuery = z.object({
  filter: z.enum(['all', 'wins', 'losses', 'cancelled', 'completed']).optional(),
  status: z.enum(['active']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

router.get('/', validate(listQuery, 'query'), ah(async (req, res) => {
  const q = req.validatedQuery;
  res.json(await svc.listMatchesForUser(req.user.id, { ...q, active: q.status === 'active' }));
}));

// Create a match that waits for an opponent (direct link / lobby).
router.post('/', requirePlayer, validate(createMatchSchema), ah(async (req, res) => {
  const id = await svc.createMatch(req.user.id, req.body.gameId, req.body.stake);
  res.status(201).json({ match: await view(req, id) });
}));

// Matchmaking: FIND OPPONENT (same game + same stake), else queue.
router.post('/find', requirePlayer, validate(createMatchSchema), ah(async (req, res) => {
  const r = await svc.findOpponent(req.user.id, req.body.gameId, req.body.stake);
  res.status(r.matched ? 200 : 201).json({ matched: r.matched, alreadyQueued: !!r.alreadyQueued, match: await view(req, r.matchId) });
}));

router.get('/queue', ah(async (_req, res) => res.json({ queue: await svc.queueCounts() })));

router.get('/:id', ah(async (req, res) => res.json({ match: await view(req, req.params.id) })));

router.post('/:id/join', requirePlayer, ah(async (req, res) => {
  const id = await svc.joinMatch(req.user.id, req.params.id);
  res.json({ match: await view(req, id) });
}));

router.post('/:id/ready', ah(async (req, res) => {
  const id = await svc.setReady(req.user.id, req.params.id);
  res.json({ match: await view(req, id) });
}));

router.post('/:id/start', ah(async (req, res) => {
  res.json(await svc.startMatch(req.user.id, req.params.id));
}));

// Players submit raw gameplay actions; the server scores and decides the winner.
router.post('/:id/result', validate(resultSchema), ah(async (req, res) => {
  const r = await svc.submitResult(req.user.id, req.params.id, req.body);
  res.json({ result: r, match: await view(req, r.matchId) });
}));

router.post('/:id/cancel', ah(async (req, res) => {
  const id = await svc.cancelMatch(req.user.id, req.params.id);
  res.json({ match: await view(req, id) });
}));

router.post('/:id/demo-opponent', requirePlayer, ah(async (req, res) => {
  const id = await svc.addDemoOpponent(req.user.id, req.params.id);
  res.json({ match: await view(req, id) });
}));

export default router;
