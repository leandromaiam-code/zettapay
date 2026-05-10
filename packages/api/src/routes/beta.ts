import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { type BetaLaunchConfig } from "../beta/config.js";
import { betaStatusSnapshot } from "../beta/monitoring.js";

/**
 * /beta/status — operator endpoint for the 24/7 monitoring dashboard.
 * Returns allowlist size, days remaining, per-merchant cap utilization,
 * and aggregate totals. Always 200 (even when disabled) so monitors can
 * detect a misconfigured rollout that flipped enabled=false unexpectedly.
 */
export function betaRouter(db: Db, config: BetaLaunchConfig): Router {
  const router = Router();

  router.get("/beta/status", (_req, res) => {
    res.json(betaStatusSnapshot(db, config));
  });

  return router;
}
