import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { findMerchantByApiKey } from "../db/merchants.js";
import {
  getWebhookEventByEventId,
  listWebhookEventsByUrl,
  resetWebhookEventForRetry,
  type WebhookStatus,
} from "../db/webhook_events.js";
import { HttpError } from "../lib/errors.js";
import { dispatchAndPersistWebhook } from "../services/webhook_dispatcher.js";

const API_KEY_HEADER = "x-zettapay-api-key";
const ALLOWED_STATUSES: ReadonlySet<WebhookStatus> = new Set<WebhookStatus>([
  "pending",
  "sent",
  "failed",
  "dead",
]);

export interface WebhooksRouterOptions {
  /**
   * Test seam — replaces the synchronous re-dispatch on `/webhooks/events/:id/retry`.
   * Default delegates to `dispatchAndPersistWebhook` with a single-attempt budget,
   * so the HTTP response surfaces the immediate outcome instead of holding open
   * for the full 24h retry curve (which the dispatcher would otherwise honor).
   */
  redispatch?: typeof dispatchAndPersistWebhook;
}

/**
 * Merchant-scoped read + retry surface for the webhook delivery log.
 *
 * `webhook_events` is keyed by the destination URL (no merchant_id column),
 * so we authorize the caller via `x-zettapay-api-key`, look up their
 * `webhookUrl`, and only return rows whose `url` matches. A merchant who has
 * not configured a webhook URL gets an empty list rather than a 404 — the UI
 * surfaces the empty-state hint.
 */
export function webhooksRouter(
  db: Db,
  options: WebhooksRouterOptions = {},
): Router {
  const router = Router();
  const redispatch = options.redispatch ?? dispatchAndPersistWebhook;

  router.get("/webhooks/events", (req, res, next) => {
    try {
      const merchant = authMerchant(db, req.header(API_KEY_HEADER));
      if (!merchant.webhookUrl) {
        res.json({ events: [], webhookUrl: null });
        return;
      }
      const limit = parseLimit(req.query.limit);
      const status = parseStatus(req.query.status);
      const events = listWebhookEventsByUrl(db, merchant.webhookUrl, {
        limit,
        ...(status ? { status } : {}),
      });
      res.json({ events, webhookUrl: merchant.webhookUrl });
    } catch (err) {
      next(err);
    }
  });

  router.post("/webhooks/events/:eventId/retry", async (req, res, next) => {
    try {
      const merchant = authMerchant(db, req.header(API_KEY_HEADER));
      if (!merchant.webhookUrl) {
        throw HttpError.badRequest(
          "Merchant has no webhook URL configured — set one before retrying.",
        );
      }
      const eventId = String(req.params.eventId ?? "").trim();
      if (!eventId) {
        throw HttpError.badRequest("Event id is required");
      }
      const existing = getWebhookEventByEventId(db, eventId);
      if (!existing) {
        throw HttpError.notFound(`Webhook event ${eventId} not found`);
      }
      if (existing.url !== merchant.webhookUrl) {
        // Don't leak existence of another merchant's event — same shape as a miss.
        throw HttpError.notFound(`Webhook event ${eventId} not found`);
      }
      if (existing.status === "pending") {
        throw HttpError.conflict(
          `Webhook event ${eventId} is already pending — wait for the worker to drain it before retrying.`,
        );
      }

      resetWebhookEventForRetry(db, eventId);

      // Single immediate attempt: the merchant clicked "retry" and expects the
      // outcome inline. If they want the full Stripe-grade curve, they retry again.
      const result = await redispatch(db, {
        eventId,
        url: existing.url,
        payload: existing.payload,
        ...(merchant.webhookSecret ? { secret: merchant.webhookSecret } : {}),
        maxAttempts: 1,
        retryDelaysMs: [],
      });

      const refreshed = getWebhookEventByEventId(db, eventId);
      res.status(202).json({
        event: refreshed,
        delivered: result.delivered,
        deadLettered: result.deadLettered,
        attempts: result.attempts,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function authMerchant(db: Db, headerValue: string | undefined) {
  if (!headerValue) {
    throw HttpError.unauthorized(`"${API_KEY_HEADER}" header is required`);
  }
  const merchant = findMerchantByApiKey(db, headerValue.trim());
  if (!merchant) {
    throw HttpError.unauthorized("Invalid API key");
  }
  return merchant;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 100;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw HttpError.badRequest('"limit" must be a positive integer');
  }
  return Math.min(Math.floor(n), 500);
}

function parseStatus(raw: unknown): WebhookStatus | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = String(raw);
  if (!ALLOWED_STATUSES.has(value as WebhookStatus)) {
    throw HttpError.badRequest(
      `"status" must be one of ${[...ALLOWED_STATUSES].join(", ")}`,
    );
  }
  return value as WebhookStatus;
}
