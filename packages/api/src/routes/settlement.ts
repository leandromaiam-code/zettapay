import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import {
  disableCoinflowSettlement,
  enableCoinflowSettlement,
  settlePayment,
} from "../coinflow/service.js";
import type { CoinflowClient } from "../coinflow/client.js";
import { COINFLOW_FEE_BPS } from "../coinflow/fee.js";
import { findMerchantById } from "../db/merchants.js";
import { listSettlementsByMerchant } from "../db/coinflow_settlements.js";
import { idempotency } from "../middleware/idempotency.js";
import { HttpError } from "../lib/errors.js";
import { requireString } from "../lib/validate.js";

export function settlementRouter(db: Db, client: CoinflowClient): Router {
  const router = Router();

  router.post(
    "/merchants/:id/settlement/coinflow",
    idempotency(db, { scope: "POST /merchants/:id/settlement/coinflow" }),
    (req, res, next) => {
      try {
        const merchantId = requireMerchantId(req.params.id);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const coinflowMerchantId = requireString(body, "coinflowMerchantId", {
          maxLength: 128,
        });
        const bankAccountId = requireString(body, "bankAccountId", {
          maxLength: 128,
        });
        const autoSettle = readBoolean(body, "autoSettle", true);

        enableCoinflowSettlement(db, merchantId, {
          coinflowMerchantId,
          bankAccountId,
          autoSettle,
        });

        const merchant = findMerchantById(db, merchantId);
        res.status(200).json({
          merchantId,
          coinflow: merchant?.coinflow,
          feeBps: COINFLOW_FEE_BPS,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/merchants/:id/settlement/coinflow", (req, res, next) => {
    try {
      const merchantId = requireMerchantId(req.params.id);
      const merchant = findMerchantById(db, merchantId);
      if (!merchant) {
        throw HttpError.notFound(`Merchant ${merchantId} not found`);
      }
      res.json({
        merchantId,
        coinflow: merchant.coinflow,
        feeBps: COINFLOW_FEE_BPS,
      });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/merchants/:id/settlement/coinflow", (req, res, next) => {
    try {
      const merchantId = requireMerchantId(req.params.id);
      disableCoinflowSettlement(db, merchantId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/merchants/:id/settlement/coinflow/payments/:paymentId",
    idempotency(db, {
      scope: "POST /merchants/:id/settlement/coinflow/payments/:paymentId",
    }),
    async (req, res, next) => {
      try {
        const merchantId = requireMerchantId(req.params.id);
        const paymentId = requireMerchantId(req.params.paymentId);
        const settlement = await settlePayment(db, client, {
          merchantId,
          paymentId,
        });
        res.status(201).json({ settlement });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/merchants/:id/settlements", (req, res, next) => {
    try {
      const merchantId = requireMerchantId(req.params.id);
      const settlements = listSettlementsByMerchant(db, merchantId);
      res.json({ settlements, feeBps: COINFLOW_FEE_BPS });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function requireMerchantId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw HttpError.badRequest("path parameter must be a non-empty string");
  }
  return value.trim();
}

function readBoolean(
  body: Record<string, unknown>,
  field: string,
  fallback: boolean,
): boolean {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  throw HttpError.badRequest(`Field "${field}" must be a boolean when provided`);
}
