import { Router } from 'express';
import { z } from 'zod';
import { queryOne } from '../db.js';
import { ah } from '../utils/errors.js';
import { validate } from '../middleware/validate.js';
import { requirePlayer } from '../middleware/auth.js';
import { challengeSchema } from './schemas.js';
import * as svc from '../services/challengeService.js';
import * as footballSvc from '../football/footballChallengeService.js';

const router = Router();
const listQuery = z.object({
  box: z.enum(['all', 'incoming', 'outgoing']).optional(),
  status: z.enum(['active', 'history', 'all']).optional(),
});
const idParam = (req) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : 0;
};

/** A challenge row carries a fixture_id when it's a football pick rather than a skill-game challenge. */
async function isFootballChallenge(id) {
  const row = await queryOne('SELECT fixture_id FROM challenges WHERE id = ?', [id]);
  return !!row?.fixture_id;
}

router.get('/', validate(listQuery, 'query'), ah(async (req, res) => {
  res.json({ challenges: await svc.listChallenges(req.user.id, req.validatedQuery) });
}));
router.post('/', requirePlayer, validate(challengeSchema), ah(async (req, res) => {
  res.status(201).json({ challenge: await svc.createChallenge(req.user.id, req.body) });
}));
router.get('/:id', ah(async (req, res) => {
  const id = idParam(req);
  const challenge = (await isFootballChallenge(id)) ? await footballSvc.getFootballChallenge(id, req.user.id) : await svc.getChallenge(id, req.user.id);
  res.json({ challenge });
}));
router.post('/:id/accept', requirePlayer, ah(async (req, res) => {
  const id = idParam(req);
  const match = (await isFootballChallenge(id)) ? await footballSvc.acceptFootballChallenge(req.user.id, id) : await svc.acceptChallenge(req.user.id, id);
  res.json({ match });
}));
// "decline" and "reject" are the same action — the UI and the wording in
// notifications say "decline", the spec's REST naming says "reject".
router.post(['/:id/decline', '/:id/reject'], ah(async (req, res) => res.json({ challenge: await svc.declineChallenge(req.user.id, idParam(req)) })));
router.post('/:id/cancel', ah(async (req, res) => res.json({ challenge: await svc.cancelChallenge(req.user.id, idParam(req)) })));

export default router;
