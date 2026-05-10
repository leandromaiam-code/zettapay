import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { findPaymentById, type Payment, type PaymentStatus } from "../db/payments.js";
import { HttpError } from "../lib/errors.js";
import type { Currency } from "../lib/currencies.js";

/**
 * Unified payment status query (Z11.5).
 *
 * Returns a chain-agnostic representation of a payment so the same response
 * shape is served regardless of which chain settled it. V1 ships Solana-only
 * (Premise §1) — when Z11 adds Base/Polygon/etc. the persistence layer will
 * stamp the originating chain on each row and `mapToUnified` will surface it
 * here without changing the public schema.
 *
 * Naming uses chain-neutral terms: `txHash` instead of `txSignature`, `amount`
 * instead of `amountUsdc`. Legacy aliases are kept for backwards compatibility
 * with existing SDK consumers.
 */
export interface UnifiedPayment {
  id: string;
  merchantId: string;
  chain: "solana";
  currency: Currency;
  amount: number;
  amountUsdc: number;
  status: PaymentStatus;
  payerWallet: string;
  txHash: string | null;
  txSignature: string | null;
  metadata: Record<string, unknown>;
  agentIdentityId: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export function mapToUnified(payment: Payment): UnifiedPayment {
  return {
    id: payment.id,
    merchantId: payment.merchantId,
    chain: "solana",
    currency: payment.currency,
    amount: payment.amountUsdc,
    amountUsdc: payment.amountUsdc,
    status: payment.status,
    payerWallet: payment.payerWallet,
    txHash: payment.txSignature,
    txSignature: payment.txSignature,
    metadata: payment.metadata,
    agentIdentityId: payment.agentIdentityId,
    errorMessage: payment.errorMessage,
    createdAt: payment.createdAt,
    completedAt: payment.completedAt,
  };
}

const MAX_ID_LENGTH = 64;

export function paymentRouter(db: Db): Router {
  const router = Router();

  router.get("/payment/:id", (req, res, next) => {
    try {
      const id = String(req.params.id ?? "").trim();
      if (id.length === 0 || id.length > MAX_ID_LENGTH) {
        throw HttpError.badRequest(
          `Path param "id" must be 1-${MAX_ID_LENGTH} chars`,
        );
      }
      const payment = findPaymentById(db, id);
      if (!payment) {
        throw HttpError.notFound(`Payment ${id} not found`);
      }
      res.json({ payment: mapToUnified(payment) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
