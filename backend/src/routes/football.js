import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { ah } from '../utils/errors.js';
import { validate } from '../middleware/validate.js';
import { optionalAuth, requireAuth, requirePlayer } from '../middleware/auth.js';
import { footballChallengeSchema, footballFindSchema } from './schemas.js';
import * as svc from '../football/footballChallengeService.js';
import { getMatchView } from '../services/matchService.js';
import * as research from '../football/footballResearchService.js';
import { validIsoDate } from '../utils/search.js';
import * as predictions from '../football/footballPredictionService.js';
import * as community from '../football/communityPredictionService.js';

const router = Router();

const fixturesQuery = z.object({
  competitionId: z.coerce.number().int().positive().optional(),
  status: z.enum(['upcoming', 'live', 'completed', 'all']).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  teamId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(80, 'Search must be at most 80 characters.').optional(),
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
const fixtureReactionSchema = z.object({ reaction: z.enum(['FIRE', 'SHOCK', 'GOAL']).nullable() });
const teamSearchQuery = z.object({ q: z.string().trim().max(80).default(''), competitionId: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
const researchQuery = z.object({
  teamA: z.coerce.number().int().positive(), teamB: z.coerce.number().int().positive(),
  venue: z.enum(['all', 'home', 'away']).default('all'), competitionId: z.coerce.number().int().positive().optional(),
  dateFrom: z.string().refine(validIsoDate, 'Choose a valid start date.').optional(),
  dateTo: z.string().refine(validIsoDate, 'Choose a valid end date.').optional(),
  season: z.string().regex(/^\d{4}(?:-\d{2})?$/).optional(),
  meetings: z.enum(['5', '10', '20', 'all']).default('all'), form: z.coerce.number().pipe(z.union([z.literal(5), z.literal(10), z.literal(20)])).default(10), page: z.coerce.number().int().min(1).max(500).default(1),
}).refine(q => q.teamA !== q.teamB, { message: 'Choose two different teams.', path: ['teamB'] })
  .refine(q => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, { message: 'The end date must be on or after the start date.', path: ['dateTo'] })
  .refine(q => !q.dateFrom || !q.dateTo || (Date.parse(q.dateTo) - Date.parse(q.dateFrom)) / 86400000 <= 3660, { message: 'Choose a date range of no more than ten years.', path: ['dateTo'] });
const fixtureDetailQuery = z.object({ includeInsights: z.enum(['true', 'false']).default('true'), insights: z.enum(['none', 'full']).optional() });
const researchLimit = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => process.env.NODE_ENV === 'test', message: { error: { code: 'RESEARCH_RATE_LIMIT', message: 'Many comparisons were requested. Wait a moment, then try again.' } } });

router.get('/competitions', ah(async (_req, res) => {
  res.json({ competitions: await svc.listCompetitions() });
}));

router.get('/challenge-types', ah(async (_req, res) => {
  res.json({ challengeTypes: await svc.listChallengeTypes() });
}));

router.get('/followed-fixtures', requireAuth, requirePlayer, ah(async (req, res) => {
  res.json({ fixtures: await svc.getFollowedFixtures(req.user.id) });
}));

router.get('/teams/:id', validate(fixtureIdParam, 'params'), ah(async (req, res) => {
  res.json(await svc.getTeamDetail(Number(req.params.id)));
}));

router.get('/teams', validate(teamSearchQuery, 'query'), ah(async (req, res) => res.json(await research.searchTeams(req.validatedQuery))));

router.get('/research/teams/:id', validate(fixtureIdParam, 'params'), ah(async (req, res) => res.json(await research.researchTeam(Number(req.params.id)))));

router.get('/research', researchLimit, validate(researchQuery, 'query'), ah(async (req, res) => res.json(await research.researchTeams(req.validatedQuery))));

router.get('/fixtures', validate(fixturesQuery, 'query'), ah(async (req, res) => {
  res.json(await svc.listFixtures(req.validatedQuery));
}));

router.get('/prediction-methodology', ah(async (_req,res)=>res.json(await predictions.modelMethodology())));
router.get('/predictions/rankings', ah(async (_req,res)=>res.json(await community.freePredictionRankings())));
router.get('/predictions/mine',requireAuth,validate(z.object({page:z.coerce.number().int().min(1).max(500).default(1),pageSize:z.coerce.number().int().min(1).max(50).default(20)}),'query'),ah(async(req,res)=>res.json(await community.freePredictionHistory(req.user.id,req.validatedQuery))));
router.get('/fixtures/:id/predictions',optionalAuth,validate(fixtureIdParam,'params'),ah(async(req,res)=>{
  res.set('Cache-Control','private, no-store');
  const id=Number(req.params.id);const f=await predictions.predictionFixture(id);
  const [model,picks]=await Promise.all([predictions.modelPredictionForFixture(id),community.communityPicks(id,req.user?.id)]);
  res.json({fixture:{id:f.id,homeTeam:f.home_short||f.home_name,awayTeam:f.away_short||f.away_name,kickoffAt:f.kickoff_at,status:f.status},model,community:picks,open:!f.is_simulated&&f.provider!=='mock'&&f.status==='SCHEDULED'&&new Date(f.kickoff_at)>new Date(),serverNow:new Date()});
}));
const freePickLimit=rateLimit({windowMs:60000,limit:30,standardHeaders:'draft-7',legacyHeaders:false,skip:()=>process.env.NODE_ENV==='test',message:{error:{code:'PICK_RATE_LIMIT',message:'Wait a moment before changing your pick again.'}}});
router.put('/fixtures/:id/prediction',requireAuth,freePickLimit,validate(fixtureIdParam,'params'),validate(z.object({pick:z.enum(['HOME','DRAW','AWAY'])})),ah(async(req,res)=>{
  const saved=await community.saveFreePrediction(req.user.id,Number(req.params.id),req.body.pick);
  res.json({...saved,community:await community.communityPicks(Number(req.params.id),req.user.id)});
}));

router.get('/fixtures/:id', optionalAuth, validate(fixtureIdParam, 'params'), validate(fixtureDetailQuery, 'query'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const [fixture, openChallenges, reactions, followed] = await Promise.all([
    svc.getFixtureDetail(id, { includeInsights: req.validatedQuery.includeInsights !== 'false' && req.validatedQuery.insights !== 'none' }),
    req.user?.role === 'PLAYER' ? svc.listOpenChallenges(req.user.id, { fixtureId: id }) : [],
    svc.getFixtureReactions(id, req.user?.id),
    req.user?.role === 'PLAYER' ? svc.isFixtureFollowed(req.user.id, id) : false,
  ]);
  fixture.reactions = reactions;
  fixture.followed = followed;
  res.json({ fixture, openChallenges, serverNow: new Date() });
}));

router.get('/fixtures/:id/insights', researchLimit, validate(fixtureIdParam, 'params'), ah(async (req, res) => {
  const fixture = await svc.getFixtureDetail(Number(req.params.id));
  res.json({ headToHead: fixture.headToHead, recentMeetings: fixture.recentMeetings, lastUpdatedAt: fixture.lastUpdatedAt });
}));

router.put('/fixtures/:id/follow', requireAuth, requirePlayer, validate(fixtureIdParam, 'params'), ah(async (req, res) => {
  res.json(await svc.followFixture(req.user.id, Number(req.params.id)));
}));

router.delete('/fixtures/:id/follow', requireAuth, requirePlayer, validate(fixtureIdParam, 'params'), ah(async (req, res) => {
  res.json(await svc.unfollowFixture(req.user.id, Number(req.params.id)));
}));

router.put('/fixtures/:id/reaction', requireAuth, validate(fixtureIdParam, 'params'), validate(fixtureReactionSchema), ah(async (req, res) => {
  res.json({ reactions: await svc.setFixtureReaction(Number(req.params.id), req.user.id, req.body.reaction) });
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
