import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../utils/errors.js';
import { validate } from '../middleware/validate.js';
import { requirePlayer } from '../middleware/auth.js';
import { challengeSchema } from './schemas.js';
import * as svc from '../services/challengeService.js';

const router = Router();
const listQuery = z.object({
  box: z.enum(['all', 'incoming', 'outgoing']).optional(),
  status: z.enum(['active', 'history', 'all']).optional(),
});
const idParam = (req) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : 0;
};

router.get('/', validate(listQuery, 'query'), ah(async (req, res) => {
  res.json({ challenges: await svc.listChallenges(req.user.id, req.validatedQuery) });
}));
router.post('/', requirePlayer, validate(challengeSchema), ah(async (req, res) => {
  res.status(201).json({ challenge: await svc.createChallenge(req.user.id, req.body) });
}));
router.get('/:id', ah(async (req, res) => res.json({ challenge: await svc.getChallenge(idParam(req), req.user.id) })));
router.post('/:id/accept', requirePlayer, ah(async (req, res) => res.json({ match: await svc.acceptChallenge(req.user.id, idParam(req)) })));
router.post('/:id/decline', ah(async (req, res) => res.json({ challenge: await svc.declineChallenge(req.user.id, idParam(req)) })));
router.post('/:id/cancel', ah(async (req, res) => res.json({ challenge: await svc.cancelChallenge(req.user.id, idParam(req)) })));

export default router;
