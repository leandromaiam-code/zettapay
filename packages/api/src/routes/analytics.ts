import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { findMerchantByApiKey } from "../db/merchants.js";
import { HttpError } from "../lib/errors.js";
import { computeAnalytics } from "../services/analytics.js";

const API_KEY_HEADER = "x-zettapay-api-key";

export function analyticsRouter(db: Db): Router {
  const router = Router();

  router.get("/analytics", (req, res, next) => {
    try {
      const apiKey = req.header(API_KEY_HEADER);
      if (!apiKey) {
        throw HttpError.unauthorized(`"${API_KEY_HEADER}" header is required`);
      }
      const merchant = findMerchantByApiKey(db, apiKey.trim());
      if (!merchant) {
        throw HttpError.unauthorized("Invalid API key");
      }
      const analytics = computeAnalytics(db, merchant.id);
      res.json({ analytics });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
