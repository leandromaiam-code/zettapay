import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { findMerchantById } from "../db/merchants.js";
import {
  recordFunnelEvent,
  type FunnelEventType,
} from "../db/funnel_events.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import {
  optionalRecord,
  optionalString,
  requireString,
} from "../lib/validate.js";

const ALLOWED_EVENTS: ReadonlySet<FunnelEventType> = new Set<FunnelEventType>([
  "view",
  "checkout",
  "completed",
]);

/**
 * Public funnel tracking endpoint. Front-end checkout pages POST a beacon
 * here when the shopper hits each step. Endpoint is intentionally
 * unauthenticated — it would be unusable from a static checkout page
 * otherwise — and the (merchant_id, session_id, event_type) unique
 * constraint dedupes refresh spam at the DB layer.
 */
export function funnelRouter(db: Db): Router {
  const router = Router();

  router.post("/funnel/track", (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const merchantId = requireString(body, "merchantId", { maxLength: 64 });
      const sessionId = requireString(body, "sessionId", { maxLength: 128 });
      const eventTypeRaw = requireString(body, "eventType", { maxLength: 16 });

      if (!ALLOWED_EVENTS.has(eventTypeRaw as FunnelEventType)) {
        throw HttpError.badRequest(
          `Field "eventType" must be one of view, checkout, completed`,
        );
      }
      const eventType = eventTypeRaw as FunnelEventType;

      const merchant = findMerchantById(db, merchantId);
      if (!merchant) {
        throw HttpError.notFound(`Merchant ${merchantId} not found`);
      }

      const paymentId = optionalString(body, "paymentId", { maxLength: 64 });
      const metadata = optionalRecord(body, "metadata");

      const event = recordFunnelEvent(db, {
        id: newId("fnl"),
        merchantId: merchant.id,
        sessionId,
        eventType,
        paymentId,
        metadata,
      });

      res.status(201).json({
        event: {
          id: event.id,
          merchantId: event.merchantId,
          sessionId: event.sessionId,
          eventType: event.eventType,
          paymentId: event.paymentId,
          createdAt: event.createdAt,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
