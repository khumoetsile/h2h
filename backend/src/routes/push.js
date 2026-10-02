import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../utils/errors.js';
import { validate } from '../middleware/validate.js';
import * as push from '../services/pushService.js';

const router = Router();

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(255), auth: z.string().min(1).max(255) }),
});
const unsubscribeSchema = z.object({ endpoint: z.string().url().max(2000) });

// The public key the browser needs to subscribe. null means push is not set up on this server.
router.get('/key', ah(async (_req, res) => res.json({ publicKey: push.getPublicKey() })));

router.post('/subscribe', validate(subscribeSchema), ah(async (req, res) => {
  await push.subscribe(req.user.id, req.body, req.headers['user-agent']);
  res.status(201).json({ ok: true });
}));

router.post('/unsubscribe', validate(unsubscribeSchema), ah(async (req, res) => {
  await push.unsubscribe(req.user.id, req.body.endpoint);
  res.json({ ok: true });
}));

export default router;
