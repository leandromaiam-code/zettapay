import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { findMerchantByApiKey } from "../db/merchants.js";
import { idempotency } from "../middleware/idempotency.js";
import { HttpError } from "../lib/errors.js";
import {
  requirePositiveNumber,
  requireString,
} from "../lib/validate.js";
import { processRefund, type Refund } from "../services/refunds.js";
import { findRefundByPaymentId } from "../db/refunds.js";
import { findPaymentById } from "../db/payments.js";
import { mapToUnified } from "./payment.js";
import {
  REFUND_REASON_MAX_LENGTH,
  REFUND_SCHEMA_VERSION,
} from "../lib/refund-auth.js";
import type { SolanaService } from "../services/solana.js";

const API_KEY_HEADER = "x-zettapay-api-key";
const MAX_ID_LENGTH = 64;
const MAX_PUBKEY_LENGTH = 64;
const MAX_SIGNATURE_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 32;

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

function toRefundView(refund: Refund) {
  return {
    id: refund.id,
    paymentId: refund.paymentId,
    merchantId: refund.merchantId,
    amount: refund.amountUsdc,
    amountUsdc: refund.amountUsdc,
    currency: refund.currency,
    reason: refund.reason,
    status: refund.status,
    txHash: refund.txSignature,
    txSignature: refund.txSignature,
    errorMessage: refund.errorMessage,
    signedBy: refund.signedBy,
    signedAt: refund.signedAt,
    createdAt: refund.createdAt,
    completedAt: refund.completedAt,
  };
}

/**
 * POST /refund/:payment_id  — Z13.5
 *
 * Issues a full refund for a previously settled payment. The merchant must
 * authenticate twice:
 *   1. API key (`x-zettapay-api-key`) — proves the request originates from
 *      the merchant's account.
 *   2. ed25519 signed merchant approval over a canonical refund intent —
 *      proves the request is authorized by the on-chain wallet that owns
 *      the funds. A leaked API key alone is not enough to drain the wallet.
 *
 * Body (JSON):
 *   {
 *     amount: number,         // must equal the original payment amount (V1: full refunds only)
 *     reason: string,         // free-text reason recorded in audit_journal (≤500 chars)
 *     issuedAt: string,       // ISO-8601, must be within ±5 min of server clock
 *     publicKey: string,      // base58 ed25519 pubkey == merchant.walletAddress
 *     signature: string,      // base58 ed25519 sig over the canonical message
 *   }
 *
 * The endpoint is idempotent on `Idempotency-Key`. A second call with the
 * same key replays the original response; a second call WITHOUT the key for
 * an already-completed refund returns the existing refund row.
 */
export function refundRouter(db: Db, solana: SolanaService): Router {
  const router = Router();

  router.post(
    "/refund/:paymentId",
    idempotency(db, { scope: "POST /refund" }),
    async (req, res, next) => {
      try {
        const merchant = authMerchant(db, req.header(API_KEY_HEADER));

        const paymentId = String(req.params.paymentId ?? "").trim();
        if (paymentId.length === 0 || paymentId.length > MAX_ID_LENGTH) {
          throw HttpError.badRequest(
            `Path param "paymentId" must be 1-${MAX_ID_LENGTH} chars`,
          );
        }

        const body = (req.body ?? {}) as Record<string, unknown>;
        const amount = requirePositiveNumber(body, "amount");
        const reason = requireString(body, "reason", {
          maxLength: REFUND_REASON_MAX_LENGTH,
        });
        const issuedAt = requireString(body, "issuedAt", {
          maxLength: MAX_TIMESTAMP_LENGTH,
        });
        const publicKey = requireString(body, "publicKey", {
          maxLength: MAX_PUBKEY_LENGTH,
        });
        const signature = requireString(body, "signature", {
          maxLength: MAX_SIGNATURE_LENGTH,
        });

        const result = await processRefund(db, solana, {
          paymentId,
          merchantId: merchant.id,
          amount,
          reason,
          issuedAt,
          publicKey,
          signature,
        });

        res.status(201).json({
          refund: toRefundView(result.refund),
          payment: mapToUnified(result.payment),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/refund/:paymentId", (req, res, next) => {
    try {
      const merchant = authMerchant(db, req.header(API_KEY_HEADER));
      const paymentId = String(req.params.paymentId ?? "").trim();
      if (paymentId.length === 0 || paymentId.length > MAX_ID_LENGTH) {
        throw HttpError.badRequest(
          `Path param "paymentId" must be 1-${MAX_ID_LENGTH} chars`,
        );
      }
      const payment = findPaymentById(db, paymentId);
      if (!payment || payment.merchantId !== merchant.id) {
        throw HttpError.notFound(`Payment ${paymentId} not found`);
      }
      const refund = findRefundByPaymentId(db, paymentId);
      if (!refund) {
        throw HttpError.notFound(`No refund recorded for payment ${paymentId}`);
      }
      res.json({ refund: toRefundView(refund) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/refund-info", (_req, res) => {
    res.json({
      schemaVersion: REFUND_SCHEMA_VERSION,
      signatureAlgorithm: "ed25519",
      signedString: [
        REFUND_SCHEMA_VERSION,
        "paymentId=<id>",
        "merchantWallet=<base58 ed25519 pubkey>",
        "amount=<fixed-6 decimal>",
        "currency=<currency code>",
        "reason=<JSON-encoded string>",
        "issuedAt=<ISO-8601 timestamp>",
      ].join("\\n"),
      replayWindowSec: 300,
      reasonMaxLength: REFUND_REASON_MAX_LENGTH,
    });
  });

  return router;
}
