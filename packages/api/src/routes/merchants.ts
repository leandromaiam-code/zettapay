import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { registerMerchant } from "../services/merchants.js";
import { idempotency } from "../middleware/idempotency.js";
import {
  optionalString,
  requireSolanaAddress,
  requireString,
} from "../lib/validate.js";
import { HttpError } from "../lib/errors.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https:\/\//i;

export function merchantsRouter(db: Db): Router {
  const router = Router();

  router.post(
    "/merchants/register",
    idempotency(db, { scope: "POST /merchants/register" }),
    (req, res, next) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const name = requireString(body, "name", { maxLength: 120 });
        const walletAddress = requireSolanaAddress(body, "walletAddress");
        const email = requireString(body, "email", { maxLength: 254 }).toLowerCase();
        if (!EMAIL_RE.test(email)) {
          throw HttpError.badRequest('Field "email" must be a valid email address');
        }
        const webhookUrl = optionalString(body, "webhookUrl", { maxLength: 2048 });
        if (webhookUrl && !URL_RE.test(webhookUrl)) {
          throw HttpError.badRequest(
            'Field "webhookUrl" must be an https:// URL (TLS required)',
          );
        }

        const merchant = registerMerchant(db, {
          name,
          walletAddress,
          email,
          webhookUrl,
        });
        res.status(201).json({ merchant });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
