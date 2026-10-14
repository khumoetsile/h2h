import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { ah } from "../utils/errors.js";
import { validate } from "../middleware/validate.js";
import {
  optionalAuth,
  requireAuth,
  requirePlayer,
} from "../middleware/auth.js";
import * as svc from "../football/fantasyArenaService.js";
const id = z.coerce.number().int().positive();
const decimal = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-7;
export const arenaSchema = z.object({
  name: z.string().trim().min(3).max(100),
  description: z.string().trim().max(500).optional(),
  entryFee: z
    .number()
    .positive()
    .max(100000)
    .refine(decimal, "Use at most two decimal places."),
  feePercent: z.number().min(0).max(100).refine(decimal).default(10),
  prizePercentages: z
    .array(z.number().min(0).max(100).refine(decimal))
    .length(3)
    .default([50, 30, 20])
    .refine(
      (p) => p.reduce((s, n) => s + Math.round(n * 100), 0) === 10000,
      "Prize percentages must total 100%.",
    ),
  fixtures: z
    .array(z.object({ fixtureId: id, referenceTeamId: id.optional() }))
    .min(1)
    .max(100),
});
const picks = z.object({
  predictions: z
    .array(
      z.object({ arenaFixtureId: id, pick: z.enum(["WIN", "DRAW", "LOSS"]) }),
    )
    .min(1)
    .max(100),
});
const paging = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const router = Router();
router.use(optionalAuth, (_req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
});
router.get(
  "/",
  validate(
    paging.extend({
      section: z.enum(["open", "live", "completed", "mine"]).default("open"),
    }),
    "query",
  ),
  ah(async (req, res) =>
    res.json(
      await svc.listArenas({ ...req.validatedQuery, userId: req.user?.id }),
    ),
  ),
);
router.get(
  "/:id",
  validate(z.object({ id }), "params"),
  ah(async (req, res) =>
    res.json(await svc.arenaDetail(req.params.id, req.user?.id)),
  ),
);
router.get(
  "/:id/leaderboard",
  validate(z.object({ id }), "params"),
  validate(paging, "query"),
  ah(async (req, res) =>
    res.json(
      await svc.arenaLeaderboard(req.params.id, {
        ...req.validatedQuery,
        userId: req.user?.id,
      }),
    ),
  ),
);
router.get(
  "/:id/entries/:entryId",
  validate(z.object({ id, entryId: id }), "params"),
  ah(async (req, res) =>
    res.json(
      await svc.participantSlip(
        req.params.id,
        req.params.entryId,
        req.user?.id,
      ),
    ),
  ),
);
const limiter = rateLimit({
  windowMs: 60000,
  limit: 15,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: {
    error: {
      code: "ARENA_RATE_LIMIT",
      message: "Please wait a moment before trying again.",
    },
  },
});
router.post(
  "/:id/entry",
  requireAuth,
  requirePlayer,
  limiter,
  validate(z.object({ id }), "params"),
  validate(picks),
  ah(async (req, res) =>
    res.json(
      await svc.joinArena(req.user.id, req.params.id, req.body.predictions),
    ),
  ),
);
router.put(
  "/:id/entry",
  requireAuth,
  requirePlayer,
  limiter,
  validate(z.object({ id }), "params"),
  validate(picks),
  ah(async (req, res) =>
    res.json(
      await svc.editArenaSlip(req.user.id, req.params.id, req.body.predictions),
    ),
  ),
);
export default router;
export const adminArenaRouter = Router();
adminArenaRouter.get(
  "/fixtures",
  validate(z.object({ q: z.string().trim().max(100).default("") }), "query"),
  ah(async (req, res) =>
    res.json(await svc.availableArenaFixtures(req.validatedQuery.q)),
  ),
);
adminArenaRouter.get(
  "/",
  validate(paging, "query"),
  ah(async (req, res) =>
    res.json(
      await svc.listArenas({
        ...req.validatedQuery,
        userId: req.user.id,
        admin: true,
      }),
    ),
  ),
);
adminArenaRouter.post(
  "/",
  validate(arenaSchema),
  ah(async (req, res) =>
    res.status(201).json(await svc.createArena(req.user.id, req.body)),
  ),
);
adminArenaRouter.get(
  "/:id",
  validate(z.object({ id }), "params"),
  ah(async (req, res) =>
    res.json(await svc.arenaDetail(req.params.id, req.user.id, true)),
  ),
);
adminArenaRouter.patch(
  "/:id",
  validate(z.object({ id }), "params"),
  validate(arenaSchema),
  ah(async (req, res) =>
    res.json(await svc.updateArena(req.user.id, req.params.id, req.body)),
  ),
);
adminArenaRouter.post(
  "/:id/publish",
  validate(z.object({ id }), "params"),
  ah(async (req, res) =>
    res.json(await svc.publishArena(req.user.id, req.params.id)),
  ),
);
adminArenaRouter.post(
  "/:id/cancel",
  validate(z.object({ id }), "params"),
  validate(z.object({ reason: z.string().trim().min(5).max(200) })),
  ah(async (req, res) =>
    res.json(
      await svc.cancelArena(req.user.id, req.params.id, req.body.reason),
    ),
  ),
);
adminArenaRouter.get(
  "/:id/leaderboard",
  validate(z.object({ id }), "params"),
  validate(paging, "query"),
  ah(async (req, res) =>
    res.json(
      await svc.arenaLeaderboard(req.params.id, {
        ...req.validatedQuery,
        userId: req.user.id,
        admin: true,
      }),
    ),
  ),
);
adminArenaRouter.get(
  "/:id/entries/:entryId",
  validate(z.object({ id, entryId: id }), "params"),
  ah(async (req, res) =>
    res.json(
      await svc.participantSlip(
        req.params.id,
        req.params.entryId,
        req.user.id,
        true,
      ),
    ),
  ),
);
