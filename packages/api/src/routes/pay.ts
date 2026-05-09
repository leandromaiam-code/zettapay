import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { createPayment } from "../services/payments.js";
import {
  optionalRecord,
  optionalString,
  requirePositiveNumber,
  requireSolanaAddress,
  requireString,
} from "../lib/validate.js";
import { HttpError } from "../lib/errors.js";
import type { SolanaService } from "../services/solana.js";
import { PublicKey } from "@solana/web3.js";

const MAX_AMOUNT_USDC = 1_000_000;

export function payRouter(db: Db, solana: SolanaService): Router {
  const router = Router();

  router.post("/pay", async (req, res, next) => {
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
  });

  return router;
}

function optionalSolanaAddress(
  body: Record<string, unknown>,
  field: string,
): string | null {
  const raw = optionalString(body, field, { maxLength: 64 });
  if (!raw) return null;
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    throw HttpError.badRequest(
      `Field "${field}" must be a valid base58-encoded Solana public key`,
    );
  }
}
