import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { createPayment } from "../services/payments.js";
import { validate } from "../middleware/validate.js";
import { createPaymentSchema, type CreatePaymentBody } from "../lib/schemas.js";
import type { SolanaService } from "../services/solana.js";

export function payRouter(db: Db, solana: SolanaService): Router {
  const router = Router();

  router.post(
    "/pay",
    validate({ body: createPaymentSchema }),
    async (req, res, next) => {
      try {
        const body = req.body as CreatePaymentBody;
        const { payment } = await createPayment(db, solana, {
          merchantId: body.merchantId,
          amountUsdc: body.amountUsdc,
          payerWallet: body.payerWallet ?? null,
          metadata: (body.metadata as Record<string, unknown> | null) ?? null,
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
