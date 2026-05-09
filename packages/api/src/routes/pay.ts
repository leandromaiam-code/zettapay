import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { createPayment } from "../services/payments.js";
import { validate } from "../middleware/validate.js";
import { createPaymentSchema, type CreatePaymentBody } from "../lib/schemas.js";
import type { SolanaService } from "../services/solana.js";
=======
import { PublicKey } from "@solana/web3.js";
import { idempotency } from "../middleware/idempotency.js";

const MAX_AMOUNT_USDC = 1_000_000;
>>>>>>> 8b8227a (feat(api): idempotency keys on POST /pay and /merchants/register)

export function payRouter(db: Db, solana: SolanaService): Router {
  const router = Router();

<<<<<<< HEAD
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
  router.post("/", idempotency(db, { scope: "POST /pay" }), async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const merchantId = requireString(body, "merchantId", { maxLength: 64 });
      const amountUsdc = requirePositiveNumber(body, "amountUsdc");
      if (amountUsdc > MAX_AMOUNT_USDC) {
        throw HttpError.badRequest(
          `amountUsdc cannot exceed ${MAX_AMOUNT_USDC}`,
        );
      }
      const payerWallet = optionalSolanaAddress(body, "payerWallet");
      const metadata = optionalRecord(body, "metadata");

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
