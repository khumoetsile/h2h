import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../utils/errors.js';
import { validate } from '../middleware/validate.js';
import { requirePlayer } from '../middleware/auth.js';
import { footballChallengeSchema, footballFindSchema } from './schemas.js';
import * as svc from '../football/footballChallengeService.js';
import { getMatchView } from '../services/matchService.js';

const router = Router();

const fixturesQuery = z.object({
  competitionId: z.coerce.number().int().positive().optional(),
  status: z.enum(['upcoming', 'live', 'all']).optional(),
});

router.get('/competitions', ah(async (_req, res) => {
  res.json({ competitions: await svc.listCompetitions() });
}));

router.get('/challenge-types', ah(async (_req, res) => {
  res.json({ challengeTypes: await svc.listChallengeTypes() });
}));

router.get('/fixtures', validate(fixturesQuery, 'query'), ah(async (req, res) => {
  res.json({ fixtures: await svc.listFixtures(req.validatedQuery) });
}));

router.get('/fixtures/:id', ah(async (req, res) => {
  res.json({ fixture: await svc.getFixtureDetail(Number(req.params.id) || 0) });
}));

// Matchmaking: find (or wait for) an opponent who picks the other side of the same question.
router.post('/find', requirePlayer, validate(footballFindSchema), ah(async (req, res) => {
  const r = await svc.findFootballOpponent(req.user.id, req.body);
  res.status(r.matched ? 200 : 201).json({ matched: r.matched, alreadyQueued: !!r.alreadyQueued, match: await getMatchView(r.matchId, req.user.id) });
}));

// Challenge a specific player directly.
router.post('/challenges', requirePlayer, validate(footballChallengeSchema), ah(async (req, res) => {
  res.status(201).json({ challenge: await svc.createFootballChallenge(req.user.id, req.body) });
}));

export default router;
