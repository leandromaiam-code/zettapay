import { Router, type RequestHandler } from "express";
import type { Database as Db } from "better-sqlite3";
import {
  findSubscription,
  updateSubscriptionStatus,
  type Subscription,
  type SubscriptionStatus,
} from "../db/subscriptions.js";
import { HttpError } from "../lib/errors.js";
import { requireString } from "../lib/validate.js";
import {
  buildManageIntentMessage,
  isSubscriptionManageAction,
  SUBSCRIPTION_MANAGE_ACTIONS,
  SUBSCRIPTION_MANAGE_SCHEMA_VERSION,
  SubscriptionManageAuthError,
  verifySubscriptionManageIntent,
  type SubscriptionManageAction,
} from "../lib/subscription-manage-auth.js";

/** Trim the public surface so the merchant API key, internal failure
 * counters, etc. are never echoed to a customer hitting /sub/manage. */
function toCustomerView(sub: Subscription) {
  return {
    id: sub.id,
    merchantId: sub.merchantId,
    customerWallet: sub.customerWallet,
    amount: sub.amount,
    currency: sub.currency,
    interval: sub.interval,
    status: sub.status,
    nextChargeAt: sub.nextChargeAt,
    lastChargeAt: sub.lastChargeAt,
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
  };
}

function parseAction(raw: unknown): SubscriptionManageAction {
  if (!isSubscriptionManageAction(raw)) {
    throw HttpError.badRequest(
      `action must be one of: ${SUBSCRIPTION_MANAGE_ACTIONS.join(", ")}`,
    );
  }
  return raw;
}

const NEXT_STATUS: Record<SubscriptionManageAction, SubscriptionStatus> = {
  cancel: "canceled",
  pause: "paused",
  resume: "active",
};

/** Status the subscription must be in before a given action is legal. Cancel
 * is allowed from any non-terminal state; pause requires active; resume
 * requires paused. Bouncing through nonsensical transitions returns 409 so
 * the customer dashboard can surface a precise error. */
function assertTransitionAllowed(
  action: SubscriptionManageAction,
  current: SubscriptionStatus,
): void {
  if (action === "cancel") {
    if (current === "canceled") {
      throw HttpError.conflict("subscription is already canceled");
    }
    return;
  }
  if (action === "pause") {
    if (current !== "active") {
      throw HttpError.conflict(
        `cannot pause subscription in status "${current}"`,
      );
    }
    return;
  }
  if (current !== "paused") {
    throw HttpError.conflict(
      `cannot resume subscription in status "${current}"`,
    );
  }
}

export interface SubscriptionManageRouterOptions {
  /** Test seam — pinning the clock makes signed-message TTL assertions
   * deterministic without a fake-timer dance. */
  now?: () => number;
}

export function subscriptionManageRouter(
  db: Db,
  options: SubscriptionManageRouterOptions = {},
): Router {
  const router = Router();
  const now = options.now ?? (() => Date.now());

  /** GET /sub/manage/:id — read-only customer view. The subscription id is
   * a capability shared with the customer by the merchant (e.g. via email
   * link). No PII beyond the wallet the customer already owns is exposed. */
  router.get("/sub/manage/:id", (req, res, next) => {
    try {
      const sub = findSubscription(db, req.params.id);
      if (!sub) {
        throw HttpError.notFound("subscription not found");
      }
      res.json({ subscription: toCustomerView(sub) });
    } catch (err) {
      next(err);
    }
  });

  /** GET /sub/manage/:id/intent-message?action=cancel — returns the
   * canonical bytes the customer wallet must sign. The dashboard displays
   * this string to the user before invoking the wallet adapter so they can
   * audit what they are about to authorize. */
  router.get("/sub/manage/:id/intent-message", (req, res, next) => {
    try {
      const sub = findSubscription(db, req.params.id);
      if (!sub) {
        throw HttpError.notFound("subscription not found");
      }
      const action = parseAction(req.query.action);
      const issuedAt = new Date(now()).toISOString();
      const message = buildManageIntentMessage({
        action,
        subscriptionId: sub.id,
        customerWallet: sub.customerWallet,
        issuedAt,
      });
      res.json({
        schema: SUBSCRIPTION_MANAGE_SCHEMA_VERSION,
        action,
        subscriptionId: sub.id,
        customerWallet: sub.customerWallet,
        issuedAt,
        message: message.toString("utf8"),
        messageBase64: message.toString("base64"),
      });
    } catch (err) {
      next(err);
    }
  });

  function handleManageAction(
    action: SubscriptionManageAction,
  ): RequestHandler<{ id: string }> {
    return (req, res, next) => {
      try {
        const sub = findSubscription(db, req.params.id);
        if (!sub) {
          throw HttpError.notFound("subscription not found");
        }
        assertTransitionAllowed(action, sub.status);

        const body = (req.body ?? {}) as Record<string, unknown>;
        const publicKey = requireString(body, "publicKey", { maxLength: 64 });
        const signature = requireString(body, "signature", { maxLength: 128 });
        const issuedAt = requireString(body, "issuedAt", { maxLength: 32 });

        try {
          verifySubscriptionManageIntent({
            intent: {
              action,
              subscriptionId: sub.id,
              customerWallet: sub.customerWallet,
              issuedAt,
            },
            publicKey,
            signature,
            now: now(),
          });
        } catch (err) {
          if (err instanceof SubscriptionManageAuthError) {
            const status = err.code === "wallet_mismatch" ? 403 : 400;
            throw new HttpError(
              status,
              status === 403 ? "forbidden" : "validation_error",
              err.message,
              { code: err.code },
            );
          }
          throw err;
        }

        const updated = updateSubscriptionStatus(db, sub.id, NEXT_STATUS[action]);
        res.json({ subscription: toCustomerView(updated) });
      } catch (err) {
        next(err);
      }
    };
  }

  router.post("/sub/manage/:id/cancel", handleManageAction("cancel"));
  router.post("/sub/manage/:id/pause", handleManageAction("pause"));
  router.post("/sub/manage/:id/resume", handleManageAction("resume"));

  return router;
}
