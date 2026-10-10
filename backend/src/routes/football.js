import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../utils/errors.js';
import { validate } from '../middleware/validate.js';
import { optionalAuth, requireAuth, requirePlayer } from '../middleware/auth.js';
import { footballChallengeSchema, footballFindSchema } from './schemas.js';
import * as svc from '../football/footballChallengeService.js';
import { getMatchView } from '../services/matchService.js';

const router = Router();

const fixturesQuery = z.object({
  competitionId: z.coerce.number().int().positive().optional(),
  status: z.enum(['upcoming', 'live', 'completed', 'all']).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  teamId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).refine((q) => {
  const validDate = (date) => {
    if (!date) return true;
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
  };
  if (!validDate(q.dateFrom) || !validDate(q.dateTo)) return false;
  if (q.dateFrom && q.dateTo && q.dateFrom > q.dateTo) return false;
  if (q.dateFrom && q.dateTo && (Date.parse(`${q.dateTo}T00:00:00Z`) - Date.parse(`${q.dateFrom}T00:00:00Z`)) / 86400000 > 90) return false;
  return true;
}, { message: 'Choose a valid date range of no more than 90 days.' });

const fixtureIdParam = z.object({ id: z.coerce.number().int().positive() });

router.get('/competitions', ah(async (_req, res) => {
  res.json({ competitions: await svc.listCompetitions() });
}));

router.get('/challenge-types', ah(async (_req, res) => {
  res.json({ challengeTypes: await svc.listChallengeTypes() });
}));

router.get('/teams/:id', validate(fixtureIdParam, 'params'), ah(async (req, res) => {
  res.json(await svc.getTeamDetail(Number(req.params.id)));
}));

router.get('/fixtures', validate(fixturesQuery, 'query'), ah(async (req, res) => {
  res.json(await svc.listFixtures(req.validatedQuery));
}));

router.get('/fixtures/:id', optionalAuth, validate(fixtureIdParam, 'params'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const [fixture, openChallenges] = await Promise.all([
    svc.getFixtureDetail(id),
    req.user?.role === 'PLAYER' ? svc.listOpenChallenges(req.user.id, { fixtureId: id }) : [],
  ]);
  res.json({ fixture, openChallenges, serverNow: new Date() });
}));

// Matchmaking: find (or wait for) an opponent who picks the other side of the same question.
router.post('/find', requireAuth, requirePlayer, validate(footballFindSchema), ah(async (req, res) => {
  const r = await svc.findFootballOpponent(req.user.id, req.body);
  res.status(r.matched ? 200 : 201).json({ matched: r.matched, alreadyQueued: !!r.alreadyQueued, match: await getMatchView(r.matchId, req.user.id) });
}));

// Publicly discoverable 1v1s waiting for a second player (created via /find when no instant match existed).
router.get('/open-challenges', requireAuth, requirePlayer, ah(async (req, res) => {
  res.json({ challenges: await svc.listOpenChallenges(req.user.id), serverNow: new Date() });
}));

// Join one specific open challenge directly — race-safe: only one caller can ever win this.
router.post('/open-challenges/:id/join', requireAuth, requirePlayer, ah(async (req, res) => {
  const id = Number(req.params.id) || 0;
  res.json({ match: await svc.joinOpenChallenge(req.user.id, id) });
}));

// Challenge a specific player directly.
router.post('/challenges', requireAuth, requirePlayer, validate(footballChallengeSchema), ah(async (req, res) => {
  res.status(201).json({ challenge: await svc.createFootballChallenge(req.user.id, req.body) });
}));

export default router;
