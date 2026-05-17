// DEPRECATED (Z53): quarantined custodial endpoint. /pay/evm/:merchant was
// backed by EVM_PAYER_PRIVATE_KEY — violates HR-CUSTODY. Do not mount.
import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { idempotency } from "../middleware/idempotency.js";
import { HttpError } from "../lib/errors.js";
import {
  normalizeEvmChain,
  optionalHexAddress,
  requireHexAddress,
  type EvmCurrency,
} from "../lib/chains.js";
import {
  optionalRecord,
  optionalString,
  requirePositiveNumber,
  requireString,
} from "../lib/validate.js";
import { createEvmPayment } from "../services/evm_payments.js";
import type { EvmService } from "../services/evm.js";

const MAX_AMOUNT = 1_000_000;

/**
 * Normalises a merchant slug from the URL — the canonical form is
 * `@merchant_id`, but we accept the bare id too so SDK callers don't have to
 * URL-encode the `@`. Express decodes the path param for us.
 */
function stripAtPrefix(raw: string): string {
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

export function payEvmRouter(db: Db, evm: EvmService): Router {
  const router = Router();

  router.post(
    "/pay/evm/:merchantRef",
    idempotency(db, { scope: "POST /pay/evm" }),
    async (req, res, next) => {
      try {
        const merchantRefParam = req.params.merchantRef ?? "";
        const merchantId = stripAtPrefix(merchantRefParam).trim();
        if (!merchantId) {
          throw HttpError.badRequest(
            `Path param "merchantRef" is required (use "@<merchantId>" or "<merchantId>")`,
          );
        }

        const body = (req.body ?? {}) as Record<string, unknown>;
        const chain = normalizeEvmChain(
          requireString(body, "chain", { maxLength: 32 }),
        );
        const amount = requirePositiveNumber(
          { amount: body.amount ?? body.amountUsdc },
          "amount",
        );
        if (amount > MAX_AMOUNT) {
          throw HttpError.badRequest(
            `Field "amount" cannot exceed ${MAX_AMOUNT}`,
          );
        }
        const recipientWallet = requireHexAddress(body, "recipientWallet");
        const payerWallet = optionalHexAddress(body, "payerWallet");
        const metadata = optionalRecord(body, "metadata");
        const currencyRaw = optionalString(body, "currency", { maxLength: 8 });
        const currency: EvmCurrency = currencyRaw
          ? assertEvmCurrency(currencyRaw)
          : "USDC";

        const result = await createEvmPayment(db, evm, {
          merchantId,
          chain,
          amount,
          recipientWallet,
          payerWallet,
          metadata,
          currency,
        });

        const { payment } = result;
        res.status(201).json({
          payment: {
            id: payment.id,
            merchantId: payment.merchantId,
            amount: payment.amountUsdc,
            amountUsdc: payment.amountUsdc,
            currency: payment.currency,
            chain: payment.chain,
            payerWallet: payment.payerWallet,
            status: payment.status,
            txHash: payment.txSignature,
            txSignature: payment.txSignature,
            metadata: payment.metadata,
            createdAt: payment.createdAt,
            completedAt: payment.completedAt,
          },
          txHash: result.txHash,
          chainId: result.chainId,
          contractAddress: result.contractAddress,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

function assertEvmCurrency(value: string): EvmCurrency {
  const upper = value.toUpperCase();
  if (upper !== "USDC") {
    throw HttpError.badRequest(
      `Unsupported EVM currency "${value}" — only USDC is enabled in this release`,
    );
  }
  return "USDC";
}
