import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../utils/errors.js';
import { validate } from '../middleware/validate.js';
import { requirePlayer } from '../middleware/auth.js';
import { amountSchema } from './schemas.js';
import { demoDeposit, demoWithdrawal, getWallet, listTransactions, TX_TYPES } from '../services/walletService.js';

const router = Router();

// A user can only ever see / modify their own wallet: the user id always
// comes from the authenticated session, never from the request.
router.get('/', ah(async (req, res) => {
  res.json({ wallet: await getWallet(req.user.id), demoMode: true, notice: 'DEMO WALLET: NO REAL MONEY' });
}));

router.post('/demo-deposit', requirePlayer, validate(amountSchema), ah(async (req, res) => {
  const { wallet, transactionId, amount } = await demoDeposit(req.user.id, req.body.amount);
  res.status(201).json({ wallet, transactionId, amount, status: 'DEMO_COMPLETED', message: 'Demo funds added. No real money was deposited.' });
}));

router.post('/demo-withdrawal', requirePlayer, validate(amountSchema), ah(async (req, res) => {
  const { wallet, transactionId, amount } = await demoWithdrawal(req.user.id, req.body.amount);
  res.status(201).json({ wallet, transactionId, amount, status: 'DEMO_COMPLETED', message: 'Demo withdrawal only. No real money was transferred.' });
}));

const txQuery = z.object({
  type: z.enum(TX_TYPES).optional().or(z.literal('').transform(() => undefined)),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

router.get('/transactions', validate(txQuery, 'query'), ah(async (req, res) => {
  res.json(await listTransactions({ ...req.validatedQuery, userId: req.user.id }));
}));

export default router;
