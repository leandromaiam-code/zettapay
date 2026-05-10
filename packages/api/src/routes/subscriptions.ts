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
  setSubscriptionAuthorization,
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
import {
  buildAuthorizationMessage,
  SubscriptionAuthError,
  verifySubscriptionAuthorization,
} from "../lib/subscription-auth.js";

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

  /**
   * GET /subscriptions/:id/authorization-message — returns the canonical
   * payload the customer must sign with their Solana wallet to grant the
   * cron worker permanent authorization to charge this subscription. The
   * client signs the bytes verbatim; tampering with the binding fields
   * post-sign invalidates the resulting signature.
   */
  router.get("/subscriptions/:id/authorization-message", (req, res, next) => {
    try {
      const merchant = authMerchant(db, req.header(API_KEY_HEADER));
      const subscription = findSubscription(db, req.params.id);
      if (!subscription || subscription.merchantId !== merchant.id) {
        throw HttpError.notFound("subscription not found");
      }
      const message = buildAuthorizationMessage({
        subscriptionId: subscription.id,
        merchantId: subscription.merchantId,
        customerWallet: subscription.customerWallet,
        amount: subscription.amount,
        currency: subscription.currency,
        interval: subscription.interval,
      });
      res.json({
        schema: "ZETTAPAY-SUBSCRIPTION-AUTH-V1",
        message: message.toString("utf8"),
        messageBase64: message.toString("base64"),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /subscriptions/:id/authorize — attach a customer-signed permanent
   * authorization to the subscription. The signature is verified server-side
   * before persistence; the cron worker re-verifies on every charge cycle.
   */
  router.post("/subscriptions/:id/authorize", (req, res, next) => {
    try {
      const merchant = authMerchant(db, req.header(API_KEY_HEADER));
      const subscription = findSubscription(db, req.params.id);
      if (!subscription || subscription.merchantId !== merchant.id) {
        throw HttpError.notFound("subscription not found");
      }
      if (subscription.status !== "active") {
        throw HttpError.badRequest(
          "Cannot authorize a subscription that is not active",
        );
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const signature = requireString(body, "signature", { maxLength: 128 });
      const publicKey = requireString(body, "publicKey", { maxLength: 64 });

      try {
        verifySubscriptionAuthorization({
          binding: {
            subscriptionId: subscription.id,
            merchantId: subscription.merchantId,
            customerWallet: subscription.customerWallet,
            amount: subscription.amount,
            currency: subscription.currency,
            interval: subscription.interval,
          },
          publicKey,
          signature,
        });
      } catch (err) {
        if (err instanceof SubscriptionAuthError) {
          throw HttpError.badRequest(err.message, { code: err.code });
        }
        throw err;
      }

      const updated = setSubscriptionAuthorization(db, subscription.id, {
        signature,
        publicKey,
      });
      res.status(200).json({ subscription: updated });
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
