import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { findMerchantByApiKey } from "../db/merchants.js";
import {
  insertSubscription,
  listSubscriptionsByMerchant,
  findSubscription,
  updateSubscriptionStatus,
  isSubscriptionInterval,
  advanceChargeDate,
  type SubscriptionInterval,
} from "../db/subscriptions.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import { normalizeCurrency } from "../lib/currencies.js";
import { idempotency } from "../middleware/idempotency.js";
import {
  optionalRecord,
  optionalString,
  requirePositiveNumber,
  requireSolanaAddress,
  requireString,
} from "../lib/validate.js";

const API_KEY_HEADER = "x-zettapay-api-key";

function authMerchant(db: Db, apiKey: string | undefined) {
  if (!apiKey) {
    throw HttpError.unauthorized(`"${API_KEY_HEADER}" header is required`);
  }
  const merchant = findMerchantByApiKey(db, apiKey.trim());
  if (!merchant) {
    throw HttpError.unauthorized("Invalid API key");
  }
  return merchant;
}

export function subscriptionsRouter(db: Db): Router {
  const router = Router();

  router.post(
    "/subscriptions",
    idempotency(db, { scope: "POST /subscriptions" }),
    (req, res, next) => {
      try {
        const merchant = authMerchant(db, req.header(API_KEY_HEADER));
        const body = (req.body ?? {}) as Record<string, unknown>;

        const customerWallet = requireSolanaAddress(body, "customerWallet");
        const amount = requirePositiveNumber(body, "amount");
        const intervalRaw = requireString(body, "interval", { maxLength: 16 });
        if (!isSubscriptionInterval(intervalRaw)) {
          throw HttpError.badRequest(
            'Field "interval" must be one of: daily, weekly, monthly',
          );
        }
        const interval: SubscriptionInterval = intervalRaw;

        const currencyRaw = optionalString(body, "currency", { maxLength: 16 });
        const currency = normalizeCurrency(currencyRaw);

        const nextChargeAtRaw = optionalString(body, "nextChargeAt", {
          maxLength: 32,
        });
        const nextChargeAt = nextChargeAtRaw
          ? parseFutureIso(nextChargeAtRaw)
          : advanceChargeDate(new Date(), interval).toISOString();

        const metadata = optionalRecord(body, "metadata");

        const subscription = insertSubscription(db, {
          id: newId("sub"),
          merchantId: merchant.id,
          customerWallet,
          amount,
          currency,
          interval,
          nextChargeAt,
          metadata,
        });
        res.status(201).json({ subscription });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/subscriptions", (req, res, next) => {
    try {
      const merchant = authMerchant(db, req.header(API_KEY_HEADER));
      const limitRaw = req.query.limit;
      let limit = 50;
      if (typeof limitRaw === "string") {
        const parsed = Number.parseInt(limitRaw, 10);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 200) {
          limit = parsed;
        }
      }
      const subscriptions = listSubscriptionsByMerchant(db, merchant.id, limit);
      res.json({ subscriptions });
    } catch (err) {
      next(err);
    }
  });

  router.get("/subscriptions/:id", (req, res, next) => {
    try {
      const merchant = authMerchant(db, req.header(API_KEY_HEADER));
      const subscription = findSubscription(db, req.params.id);
      if (!subscription || subscription.merchantId !== merchant.id) {
        throw HttpError.notFound("subscription not found");
      }
      res.json({ subscription });
    } catch (err) {
      next(err);
    }
  });

  router.post("/subscriptions/:id/cancel", (req, res, next) => {
    try {
      const merchant = authMerchant(db, req.header(API_KEY_HEADER));
      const existing = findSubscription(db, req.params.id);
      if (!existing || existing.merchantId !== merchant.id) {
        throw HttpError.notFound("subscription not found");
      }
      const subscription = updateSubscriptionStatus(
        db,
        req.params.id,
        "canceled",
      );
      res.json({ subscription });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function parseFutureIso(value: string): string {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) {
    throw HttpError.badRequest(
      'Field "nextChargeAt" must be a valid ISO-8601 timestamp',
    );
  }
  return new Date(ts).toISOString();
}
