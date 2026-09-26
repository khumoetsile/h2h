import { Router } from 'express';
import { ah } from '../utils/errors.js';
import { catalogue, getGameBySlug } from '../services/gameService.js';

const router = Router();

router.get('/', ah(async (_req, res) => res.json({ games: await catalogue() })));
router.get('/:slug', ah(async (req, res) => res.json({ game: await getGameBySlug(req.params.slug) })));

export default router;
