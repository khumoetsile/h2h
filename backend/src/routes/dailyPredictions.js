import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { requireAuth, optionalAuth, requireAdmin } from "../middleware/auth.js";
import { ah, badRequest } from "../utils/errors.js";
import * as daily from "../football/dailyPredictionService.js";
const router = Router();
const challengeBody = z.object({
  fixtureId: z.number().int().positive(),
  referenceTeamId: z.number().int().positive(),
  slot: z.number().int().min(1).max(10).default(1),
});
const predictionBody = z.object({ pick: z.enum(["WIN", "DRAW", "LOSS"]) });
const reasonBody = z.object({ reason: z.string().trim().min(10).max(255) });
const preferenceBody = z.object({ reminders: z.boolean() });
const id = (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1)
    throw badRequest("INVALID_ID", "Invalid challenge ID.");
  return n;
};
function pagination(req) {
  return {
    page: Math.min(10000, id(req.query.page || 1)),
    pageSize: Math.min(50, id(req.query.pageSize || 20)),
  };
}
router.get(
  "/",
  optionalAuth,
  ah(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await daily.dailyOverview(req.user?.id));
  }),
);
router.get(
  "/history",
  requireAuth,
  ah(async (req, res) =>
    res.json(
      await daily.dailyHistory(req.user.id, {
        ...pagination(req),
        filter: req.query.filter || "all",
      }),
    ),
  ),
);
router.get(
  "/leaderboard",
  optionalAuth,
  ah(async (req, res) =>
    res.json(
      await daily.dailyLeaderboard(
        req.query.period || "weekly",
        req.user?.id,
        pagination(req),
      ),
    ),
  ),
);
router.put(
  "/preferences",
  requireAuth,
  validate(preferenceBody),
  ah(async (req, res) =>
    res.json(await daily.setDailyReminders(req.user.id, req.body.reminders)),
  ),
);
router.put(
  "/:id/prediction",
  requireAuth,
  validate(predictionBody),
  ah(async (req, res) =>
    res.json(
      await daily.submitDailyPrediction(
        req.user.id,
        id(req.params.id),
        req.body.pick,
      ),
    ),
  ),
);
router.get(
  "/admin/fixtures",
  requireAuth,
  requireAdmin,
  ah(async (_req, res) =>
    res.json({ fixtures: await daily.dailyAdminFixtures() }),
  ),
);
router.get(
  "/admin/challenges",
  requireAuth,
  requireAdmin,
  ah(async (_req, res) =>
    res.json({
      challenges: await daily.dailyAdminChallenges(),
      slots: daily.dailySlots,
    }),
  ),
);
router.post(
  "/admin/challenges",
  requireAuth,
  requireAdmin,
  validate(challengeBody),
  ah(async (req, res) =>
    res
      .status(201)
      .json(await daily.publishDailyChallenge(req.user.id, req.body)),
  ),
);
router.put(
  "/admin/challenges/:id",
  requireAuth,
  requireAdmin,
  validate(challengeBody),
  ah(async (req, res) =>
    res.json(
      await daily.publishDailyChallenge(req.user.id, {
        ...req.body,
        challengeId: id(req.params.id),
      }),
    ),
  ),
);
router.post(
  "/admin/challenges/:id/reconcile",
  requireAuth,
  requireAdmin,
  validate(reasonBody),
  ah(async (req, res) =>
    res.json(
      await daily.settleDailyChallenge(id(req.params.id), {
        actorId: req.user.id,
        reason: req.body.reason,
        reconcile: true,
      }),
    ),
  ),
);
router.post(
  "/admin/challenges/:id/void",
  requireAuth,
  requireAdmin,
  validate(reasonBody),
  ah(async (req, res) =>
    res.json(
      await daily.settleDailyChallenge(id(req.params.id), {
        actorId: req.user.id,
        reason: req.body.reason,
        voidChallenge: true,
      }),
    ),
  ),
);
export default router;
