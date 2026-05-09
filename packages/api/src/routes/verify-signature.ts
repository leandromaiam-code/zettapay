import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { findMerchantByApiKey } from "../db/merchants.js";
import { HttpError } from "../lib/errors.js";
import { requireString } from "../lib/validate.js";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyWebhookSignature,
  type VerifyFailureReason,
} from "../lib/webhook-signature.js";

const API_KEY_HEADER = "x-zettapay-api-key";

/**
 * POST /verify-signature
 *
 * Lets a merchant verify that an incoming webhook delivery was authentically
 * signed by ZettaPay (HMAC-SHA256 over `${timestamp}.${payload}` using their
 * `webhook_secret`). The merchant authenticates with their API key and replays
 * the payload + signature + timestamp from the suspect request.
 *
 * The endpoint never echoes the secret. A constant-time comparison keeps it
 * safe against timing oracles.
 */
export function verifySignatureRouter(db: Db): Router {
  const router = Router();

  router.post("/verify-signature", (req, res, next) => {
    try {
      const apiKey = req.header(API_KEY_HEADER);
      if (!apiKey) {
        throw HttpError.unauthorized(
          `"${API_KEY_HEADER}" header is required`,
        );
      }
      const merchant = findMerchantByApiKey(db, apiKey.trim());
      if (!merchant) {
        throw HttpError.unauthorized("Invalid API key");
      }
      if (!merchant.webhookSecret) {
        throw HttpError.badRequest(
          "Merchant has no webhook signing secret configured",
        );
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const payload = requireString(body, "payload", { maxLength: 1_048_576 });
      const signature = requireString(body, "signature", { maxLength: 256 });
      const timestamp = requireString(body, "timestamp", { maxLength: 32 });

      const result = verifyWebhookSignature({
        secret: merchant.webhookSecret,
        payload,
        timestamp,
        signature,
      });

      if (result.valid) {
        res.json({ valid: true });
        return;
      }
      res.json({
        valid: false,
        reason: result.reason satisfies VerifyFailureReason,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/verify-signature/info", (_req, res) => {
    res.json({
      algorithm: "HMAC-SHA256",
      signatureFormat: "sha256=<hex>",
      signedString: "${timestamp}.${payload}",
      headers: {
        signature: SIGNATURE_HEADER,
        timestamp: TIMESTAMP_HEADER,
      },
      toleranceSec: 300,
    });
  });

  return router;
}
