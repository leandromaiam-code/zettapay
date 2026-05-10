import type { Database as Db } from "better-sqlite3";
import { PublicKey } from "@solana/web3.js";
import {
  findPaymentById,
  markPaymentRefunded,
  type Payment,
} from "../db/payments.js";
import {
  findRefundByPaymentId,
  insertRefund,
  markRefundCompleted,
  markRefundFailed,
  markRefundProcessing,
  getRefund,
  type Refund,
} from "../db/refunds.js";
import { findMerchantById } from "../db/merchants.js";
import { appendAudit } from "../db/audit_journal.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import { withSpan } from "../lib/tracer.js";
import { recordPaymentOutcome } from "../lib/metrics.js";
import {
  REFUND_REASON_MAX_LENGTH,
  RefundAuthError,
  verifyRefundIntent,
  type RefundIntent,
} from "../lib/refund-auth.js";
import type { SolanaService } from "./solana.js";

export interface ProcessRefundInput {
  paymentId: string;
  /** API-key-authenticated merchant from the route handler — the wallet
   * embedded in the signed intent must match this merchant's wallet. */
  merchantId: string;
  amount: number;
  reason: string;
  issuedAt: string;
  publicKey: string;
  signature: string;
}

export interface ProcessRefundResult {
  refund: Refund;
  payment: Payment;
}

/**
 * Z13.5 — process a refund for a previously settled payment.
 *
 * Flow:
 *   1. Load payment + merchant; reject unless payment is in `completed` and
 *      already-refunded check is idempotent (returns existing refund row).
 *   2. Verify the merchant's ed25519 signature over the canonical refund
 *      intent. The signing pubkey must equal the merchant's on-chain wallet.
 *   3. Insert a `pending` refund row before any side effect, mark
 *      `processing`, then issue the on-chain reversal — facilitator pushes
 *      USDC back to the original payer's ATA in the same currency.
 *   4. On success: mark refund `completed`, flip payment → `refunded`, audit.
 *   5. On failure: mark refund `failed` with the error, audit, and surface
 *      a payment_failed HTTP error so the merchant can retry.
 *
 * Premissa #14 (no custody): in V1 the facilitator IS the payer for SPL
 * transfers, so the on-chain reversal looks symmetric to the original
 * payment — same signing key, opposite direction. When mainnet flips to
 * pre-signed merchant transactions (Z21), only the SolanaService glue
 * changes; the API contract here stays put.
 */
export async function processRefund(
  db: Db,
  solana: SolanaService,
  input: ProcessRefundInput,
): Promise<ProcessRefundResult> {
  if (input.reason.length === 0) {
    throw HttpError.badRequest("reason is required");
  }
  if (input.reason.length > REFUND_REASON_MAX_LENGTH) {
    throw HttpError.badRequest(
      `reason exceeds ${REFUND_REASON_MAX_LENGTH} chars`,
    );
  }

  const payment = findPaymentById(db, input.paymentId);
  if (!payment) {
    throw HttpError.notFound(`Payment ${input.paymentId} not found`);
  }
  if (payment.merchantId !== input.merchantId) {
    // Tenant isolation: API-key-authenticated merchant cannot refund a
    // payment that belongs to another merchant. 404 (not 403) so we don't
    // leak the existence of foreign payments.
    throw HttpError.notFound(`Payment ${input.paymentId} not found`);
  }

  // Idempotency: a second call for an already-completed refund returns the
  // same row instead of failing. A row in `failed` state means the merchant
  // can re-sign and try again — we delete-and-replace is overkill, so we
  // surface a conflict and require explicit retry handling client-side.
  const existing = findRefundByPaymentId(db, input.paymentId);
  if (existing && existing.status === "completed") {
    return { refund: existing, payment };
  }
  if (existing && (existing.status === "pending" || existing.status === "processing")) {
    throw HttpError.conflict(
      `Refund for ${input.paymentId} is already in progress`,
      { refundId: existing.id, status: existing.status },
    );
  }
  if (payment.status === "refunded") {
    // Defensive: payment row is refunded but we have no refund row (legacy
    // data). Don't double-refund.
    throw HttpError.conflict(
      `Payment ${input.paymentId} is already refunded`,
    );
  }
  if (payment.status !== "completed") {
    throw HttpError.conflict(
      `Payment ${input.paymentId} cannot be refunded from status "${payment.status}"`,
      { status: payment.status },
    );
  }

  if (Math.abs(input.amount - payment.amountUsdc) > 1e-9) {
    // V1 ships full refunds only — partial refunds require richer accounting
    // (running balance per payment, multiple refund rows). Reject anything
    // that doesn't match the original amount so the on-chain reversal
    // stays a clean inverse of the original transfer.
    throw HttpError.badRequest(
      `amount must equal the original payment amount of ${payment.amountUsdc}`,
      { originalAmount: payment.amountUsdc, requestedAmount: input.amount },
    );
  }

  const merchant = findMerchantById(db, payment.merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${payment.merchantId} not found`);
  }

  const intent: RefundIntent = {
    paymentId: payment.id,
    merchantWallet: merchant.walletAddress,
    amount: payment.amountUsdc,
    currency: payment.currency,
    reason: input.reason,
    issuedAt: input.issuedAt,
  };

  try {
    verifyRefundIntent({
      intent,
      publicKey: input.publicKey,
      signature: input.signature,
    });
  } catch (err) {
    if (err instanceof RefundAuthError) {
      throw HttpError.unauthorized(err.message, { code: err.code });
    }
    throw err;
  }

  const payerPubkey = parsePayerWallet(payment.payerWallet);

  return withSpan(
    "zettapay.refund.process",
    {
      "zettapay.payment.id": payment.id,
      "zettapay.merchant.id": merchant.id,
      "zettapay.refund.amount": payment.amountUsdc,
      "zettapay.refund.currency": payment.currency,
    },
    async (span) => {
      const refundId = newId("rfd");
      const refund = insertRefund(db, {
        id: refundId,
        paymentId: payment.id,
        merchantId: merchant.id,
        amountUsdc: payment.amountUsdc,
        currency: payment.currency,
        reason: input.reason,
        signedBy: input.publicKey,
        signedAt: input.issuedAt,
        signature: input.signature,
      });
      markRefundProcessing(db, refundId);

      try {
        const result = await solana.transferToken({
          recipientOwner: payerPubkey,
          amount: payment.amountUsdc,
          currency: payment.currency,
        });
        markRefundCompleted(db, refundId, result.signature);
        const updated = markPaymentRefunded(db, payment.id);
        if (updated === 0) {
          // Payment slipped out from under us between the status check and
          // the on-chain transfer (race or external mutation). The reversal
          // already happened — we keep the refund row `completed` so the
          // operator has a paper trail, but raise so the caller knows the
          // payment row didn't flip.
          throw HttpError.conflict(
            `Payment ${payment.id} was no longer in completed status when refund finalized`,
            { paymentId: payment.id, refundId, txSignature: result.signature },
          );
        }
        span.setAttribute("zettapay.refund.tx_signature", result.signature);
        span.setAttribute("zettapay.refund.status", "completed");
        recordPaymentOutcome("refunded", payment.currency, payment.amountUsdc);

        appendAudit(db, {
          actor: `merchant:${merchant.id}`,
          event: "payment.refunded",
          entityType: "payment",
          entityId: payment.id,
          reason: input.reason,
          payload: {
            refundId,
            amountUsdc: payment.amountUsdc,
            currency: payment.currency,
            txSignature: result.signature,
            payerWallet: payment.payerWallet,
            signedBy: input.publicKey,
            signedAt: input.issuedAt,
          },
        });

        return {
          refund: getRefund(db, refundId),
          payment: findPaymentById(db, payment.id) ?? payment,
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "unknown refund transfer error";
        markRefundFailed(db, refundId, message);
        span.setAttribute("zettapay.refund.status", "failed");
        appendAudit(db, {
          actor: `merchant:${merchant.id}`,
          event: "payment.refund_failed",
          entityType: "payment",
          entityId: payment.id,
          reason: message,
          payload: {
            refundId,
            amountUsdc: payment.amountUsdc,
            currency: payment.currency,
          },
        });
        if (err instanceof HttpError) throw err;
        throw HttpError.paymentFailed(
          `${payment.currency} refund failed: ${message}`,
        );
      }
    },
  );
}

function parsePayerWallet(wallet: string): PublicKey {
  try {
    return new PublicKey(wallet);
  } catch {
    throw HttpError.badRequest(
      `Original payer wallet "${wallet}" is not a valid Solana address`,
    );
  }
}

export type { Refund } from "../db/refunds.js";
