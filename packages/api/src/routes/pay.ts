import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { createPayment } from "../services/payments.js";
import { idempotency } from "../middleware/idempotency.js";
import { HttpError } from "../lib/errors.js";
import {
  optionalRecord,
  optionalString,
  requirePositiveNumber,
  requireString,
} from "../lib/validate.js";
import type { SolanaService } from "../services/solana.js";

const MAX_AMOUNT_USDC = 1_000_000;

export function payRouter(db: Db, solana: SolanaService): Router {
  const router = Router();

  router.post(
    "/pay",
    idempotency(db, { scope: "POST /pay" }),
    async (req, res, next) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const merchantId = requireString(body, "merchantId", { maxLength: 64 });
        const amountUsdc = requirePositiveNumber(body, "amountUsdc");
        if (amountUsdc > MAX_AMOUNT_USDC) {
          throw HttpError.badRequest(
            `Field "amountUsdc" cannot exceed ${MAX_AMOUNT_USDC}`,
          );
        }
        const payerWallet = optionalString(body, "payerWallet", { maxLength: 64 });
        const metadata = optionalRecord(body, "metadata");

        const { payment } = await createPayment(db, solana, {
          merchantId,
          amountUsdc,
          payerWallet,
          metadata,
        });

        res.status(201).json({
          payment: {
            id: payment.id,
            merchantId: payment.merchantId,
            amountUsdc: payment.amountUsdc,
            payerWallet: payment.payerWallet,
            status: payment.status,
            txSignature: payment.txSignature,
            metadata: payment.metadata,
            createdAt: payment.createdAt,
            completedAt: payment.completedAt,
          },
          txSignature: payment.txSignature,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
