import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { ah } from '../utils/errors.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { claimSchema, loginSchema, quickSignupSchema, registerSchema } from './schemas.js';
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

// No form at all: a guest account for someone who just wants to play. Own limiter, since phones on one carrier share an IP.
const guestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: config.isTest ? 10000 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many new players from this network. Please try again in a little while.' } }),
});
router.post('/guest', guestLimiter, ah(async (req, res) => {
  res.status(201).json(await auth.guestSignup(meta(req)));
}));

// A guest saves their account by choosing a password.
router.post('/claim', requireAuth, validate(claimSchema), ah(async (req, res) => {
  res.json({ user: await auth.claimAccount(req.user.id, req.body) });
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
