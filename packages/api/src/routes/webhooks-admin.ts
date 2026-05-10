import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { appendAudit } from "../db/audit_journal.js";
import {
  countWebhookEventsByStatus,
  getWebhookEventByEventId,
  listAllWebhookEvents,
  resetWebhookEventForRetry,
  type WebhookStatus,
} from "../db/webhook_events.js";
import { findMerchantByApiKey } from "../db/merchants.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import { adminAuth } from "../middleware/admin-auth.js";
import { dispatchAndPersistWebhook } from "../services/webhook_dispatcher.js";

const ALLOWED_STATUSES: ReadonlySet<WebhookStatus> = new Set<WebhookStatus>([
  "pending",
  "sent",
  "failed",
  "dead",
]);

export interface WebhooksAdminRouterOptions {
  /** Shared admin key — must be >=24 chars, otherwise the routes hard-fail
   *  with config_error. Premissa #21: never expose service-grade access
   *  through a default. */
  adminKey: string | null | undefined;
  /**
   * Test seam for `/admin/webhooks/events/:id/retry` and `/replay`. Defaults
   * to `dispatchAndPersistWebhook`. The replay path passes a fresh event_id;
   * retry preserves the original.
   */
  redispatch?: typeof dispatchAndPersistWebhook;
}

interface WebhookEventLike {
  url: string;
  payload: unknown;
}

/**
 * Admin-scoped webhook events stream (Z10.5 — webhook reliability).
 *
 * Surfaces every event row across every merchant URL with retry + replay so
 * an operator can drain the dead-letter queue from the dashboard. Auth is a
 * separate `ZETTAPAY_ADMIN_KEY` (NOT a merchant API key). Sensitive actions
 * are appended to the audit journal so the actor + reason are recoverable.
 *
 *  - GET  /admin/webhooks/events                — paginated list + filters
 *  - GET  /admin/webhooks/events/summary        — counts by status
 *  - GET  /admin/webhooks/events/:eventId       — single event detail
 *  - POST /admin/webhooks/events/:eventId/retry — reset+redispatch same event
 *  - POST /admin/webhooks/events/:eventId/replay — fresh event_id, same body
 */
export function webhooksAdminRouter(
  db: Db,
  options: WebhooksAdminRouterOptions,
): Router {
  const router = Router();
  const auth = adminAuth({ adminKey: options.adminKey });
  const redispatch = options.redispatch ?? dispatchAndPersistWebhook;

  router.get("/admin/webhooks/events", auth, (req, res, next) => {
    try {
      const limit = parseLimit(req.query.limit, 500);
      const offset = parseOffset(req.query.offset);
      const status = parseStatus(req.query.status);
      const url = parseOptionalString(req.query.url, "url", 2048);
      const eventId = parseOptionalString(req.query.eventId, "eventId", 256);
      const result = listAllWebhookEvents(db, {
        limit,
        offset,
        ...(status ? { status } : {}),
        ...(url ? { url } : {}),
        ...(eventId ? { eventId } : {}),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/webhooks/events/summary", auth, (_req, res, next) => {
    try {
      res.json({ counts: countWebhookEventsByStatus(db) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/webhooks/events/:eventId", auth, (req, res, next) => {
    try {
      const eventId = String(req.params.eventId ?? "").trim();
      if (!eventId) throw HttpError.badRequest("Event id is required");
      const event = getWebhookEventByEventId(db, eventId);
      if (!event) throw HttpError.notFound(`Webhook event ${eventId} not found`);
      res.json({ event });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/admin/webhooks/events/:eventId/retry",
    auth,
    async (req, res, next) => {
      try {
        const eventId = requireEventId(req.params.eventId);
        const existing = getWebhookEventByEventId(db, eventId);
        if (!existing) {
          throw HttpError.notFound(`Webhook event ${eventId} not found`);
        }
        if (existing.status === "pending") {
          throw HttpError.conflict(
            `Webhook event ${eventId} is already pending — wait for the worker before retrying.`,
          );
        }
        resetWebhookEventForRetry(db, eventId);
        const secret = lookupSecret(db, existing);

        const result = await redispatch(db, {
          eventId,
          url: existing.url,
          payload: existing.payload,
          ...(secret ? { secret } : {}),
          maxAttempts: 1,
          retryDelaysMs: [],
        });
        const refreshed = getWebhookEventByEventId(db, eventId);

        appendAudit(db, {
          actor: req.admin?.adminActor ?? "admin",
          event: "webhook.retry",
          entityType: "webhook_event",
          entityId: eventId,
          payload: {
            url: existing.url,
            previousStatus: existing.status,
            outcome: result.delivered
              ? "delivered"
              : result.deadLettered
              ? "dead"
              : "failed",
          },
        });

        res.status(202).json({
          event: refreshed,
          delivered: result.delivered,
          deadLettered: result.deadLettered,
          attempts: result.attempts,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/admin/webhooks/events/:eventId/replay",
    auth,
    async (req, res, next) => {
      try {
        const eventId = requireEventId(req.params.eventId);
        const existing = getWebhookEventByEventId(db, eventId);
        if (!existing) {
          throw HttpError.notFound(`Webhook event ${eventId} not found`);
        }
        const replayEventId = newId("evt_replay");
        const secret = lookupSecret(db, existing);

        const result = await redispatch(db, {
          eventId: replayEventId,
          url: existing.url,
          payload: existing.payload,
          ...(secret ? { secret } : {}),
          maxAttempts: 1,
          retryDelaysMs: [],
        });
        const replayed = getWebhookEventByEventId(db, replayEventId);

        appendAudit(db, {
          actor: req.admin?.adminActor ?? "admin",
          event: "webhook.replay",
          entityType: "webhook_event",
          entityId: replayEventId,
          payload: {
            sourceEventId: eventId,
            url: existing.url,
            outcome: result.delivered
              ? "delivered"
              : result.deadLettered
              ? "dead"
              : "failed",
          },
        });

        res.status(202).json({
          source: existing,
          event: replayed,
          delivered: result.delivered,
          deadLettered: result.deadLettered,
          attempts: result.attempts,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

function requireEventId(raw: unknown): string {
  const eventId = String(raw ?? "").trim();
  if (!eventId) throw HttpError.badRequest("Event id is required");
  return eventId;
}

function parseLimit(raw: unknown, max: number): number {
  if (raw === undefined || raw === null || raw === "") return 100;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw HttpError.badRequest('"limit" must be a positive integer');
  }
  return Math.min(Math.floor(n), max);
}

function parseOffset(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw HttpError.badRequest('"offset" must be a non-negative integer');
  }
  return Math.floor(n);
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

function parseOptionalString(
  raw: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = String(raw).trim();
  if (!value) return undefined;
  if (value.length > maxLength) {
    throw HttpError.badRequest(
      `"${field}" must be at most ${maxLength} characters`,
    );
  }
  return value;
}

/**
 * Webhook events don't carry the merchant_id directly — match the destination
 * URL back to a merchant so we can sign the redispatched body with the same
 * secret the original delivery used. If no merchant matches (legacy event,
 * URL since changed), we send unsigned and the merchant's verifier will
 * reject — that's the right failure mode for an admin replay.
 */
function lookupSecret(db: Db, event: WebhookEventLike): string | null {
  const row = db
    .prepare<[string]>(
      "SELECT api_key FROM merchants WHERE webhook_url = ? LIMIT 1",
    )
    .get(event.url) as { api_key: string } | undefined;
  if (!row) return null;
  const merchant = findMerchantByApiKey(db, row.api_key);
  return merchant?.webhookSecret ?? null;
}
