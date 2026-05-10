import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { createPayment, type CreatePaymentDeps } from "../services/payments.js";
import { idempotency } from "../middleware/idempotency.js";
import { agentIdentityMiddleware } from "../middleware/agent-identity.js";
import { normalizeCurrency } from "../lib/currencies.js";
import { HttpError } from "../lib/errors.js";
import {
  optionalRecord,
  optionalString,
  requirePositiveNumber,
  requireString,
} from "../lib/validate.js";
import type { SolanaService } from "../services/solana.js";

const MAX_AMOUNT = 1_000_000;

export function payRouter(
  db: Db,
  solana: SolanaService,
  deps: CreatePaymentDeps = {},
): Router {
  const router = Router();

  router.post(
    "/pay",
    idempotency(db, { scope: "POST /pay" }),
    // Optional — when present, the agent proof is verified and per-agent
    // spending limits (Z20.3) are enforced on the resulting payment.
    agentIdentityMiddleware(db, { required: false }),
    async (req, res, next) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const merchantId = requireString(body, "merchantId", { maxLength: 64 });
        // `amount` is the canonical field; `amountUsdc` is the legacy USDC-only alias.
        const amountSource = { amount: body.amount ?? body.amountUsdc };
        const amount = requirePositiveNumber(amountSource, "amount");
        if (amount > MAX_AMOUNT) {
          throw HttpError.badRequest(
            `Field "amount" cannot exceed ${MAX_AMOUNT}`,
          );
        }
        const payerWallet = optionalString(body, "payerWallet", { maxLength: 64 });
        const metadata = optionalRecord(body, "metadata");
        const currency = normalizeCurrency(
          optionalString(body, "currency", { maxLength: 8 }),
        );

        const agentIdentityId = req.agentIdentity?.identity.id ?? null;

        const { payment } = await createPayment(
          db,
          solana,
          {
            merchantId,
            amountUsdc: amount,
            payerWallet,
            metadata,
            currency,
            agentIdentityId,
          },
          deps,
        );

        res.status(201).json({
          payment: {
            id: payment.id,
            merchantId: payment.merchantId,
            amount: payment.amountUsdc,
            amountUsdc: payment.amountUsdc,
            currency: payment.currency,
            payerWallet: payment.payerWallet,
            status: payment.status,
            txSignature: payment.txSignature,
            metadata: payment.metadata,
            agentIdentityId: payment.agentIdentityId,
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
