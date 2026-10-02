import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { ah } from '../utils/errors.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { loginSchema, quickSignupSchema, registerSchema } from './schemas.js';
import * as auth from '../services/authService.js';

const router = Router();
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isTest ? 10000 : 50,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes and try again.' } }),
});

const meta = (req) => ({ userAgent: req.headers['user-agent'], ip: req.ip });

router.post('/register', limiter, validate(registerSchema), ah(async (req, res) => {
  res.status(201).json(await auth.register(req.body, meta(req)));
}));

// Fast sign-up for someone arriving from an invite link: just a name and a password.
router.post('/quick', limiter, validate(quickSignupSchema), ah(async (req, res) => {
  res.status(201).json(await auth.quickSignup(req.body, meta(req)));
}));

router.post('/login', limiter, validate(loginSchema), ah(async (req, res) => {
  res.json(await auth.login(req.body, meta(req)));
}));

router.post('/logout', requireAuth, ah(async (req, res) => {
  await auth.logout(req.user.sessionId, req.user.id);
  res.json({ ok: true });
}));

export default router;
