import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import {
  disablePixSettlement,
  enablePixSettlement,
  settlePaymentToPix,
} from "../pix/service.js";
import {
  isPixKeyType,
  isPixProvider,
  type PixClient,
  type PixKeyType,
  type PixProvider,
} from "../pix/client.js";
import { PIX_FEE_BPS } from "../pix/fee.js";
import { findMerchantById } from "../db/merchants.js";
import { listPixSettlementsByMerchant } from "../db/pix_settlements.js";
import { idempotency } from "../middleware/idempotency.js";
import { HttpError } from "../lib/errors.js";
import {
  optionalString,
  requireString,
} from "../lib/validate.js";

export type PixClientResolver = (
  provider: PixProvider,
) => PixClient | undefined;

export interface PixRouterDeps {
  /** Resolves a configured PixClient for the requested provider, or `undefined`
   *  when ZettaPay is not running with credentials for that provider. */
  resolveClient: PixClientResolver;
  /** Providers ZettaPay is currently configured to dispatch payouts through. */
  availableProviders: readonly PixProvider[];
}

export function pixRouter(db: Db, deps: PixRouterDeps): Router {
  const router = Router();

  router.post(
    "/merchants/:id/settlement/pix",
    idempotency(db, { scope: "POST /merchants/:id/settlement/pix" }),
    (req, res, next) => {
      try {
        const merchantId = requireMerchantId(req.params.id);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const provider = readPixProvider(body, deps.availableProviders);
        const pixKey = requireString(body, "pixKey", { maxLength: 256 });
        const pixKeyType = readPixKeyType(body);
        const providerMerchantId = optionalString(body, "providerMerchantId", {
          maxLength: 128,
        });
        const autoSettle = readBoolean(body, "autoSettle", true);

        enablePixSettlement(db, merchantId, {
          provider,
          pixKey,
          pixKeyType,
          providerMerchantId,
          autoSettle,
        });

        const merchant = findMerchantById(db, merchantId);
        res.status(200).json({
          merchantId,
          pix: merchant?.pix,
          feeBps: PIX_FEE_BPS,
          availableProviders: deps.availableProviders,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/merchants/:id/settlement/pix", (req, res, next) => {
    try {
      const merchantId = requireMerchantId(req.params.id);
      const merchant = findMerchantById(db, merchantId);
      if (!merchant) {
        throw HttpError.notFound(`Merchant ${merchantId} not found`);
      }
      res.json({
        merchantId,
        pix: merchant.pix,
        feeBps: PIX_FEE_BPS,
        availableProviders: deps.availableProviders,
      });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/merchants/:id/settlement/pix", (req, res, next) => {
    try {
      const merchantId = requireMerchantId(req.params.id);
      disablePixSettlement(db, merchantId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/merchants/:id/settlement/pix/payments/:paymentId",
    idempotency(db, {
      scope: "POST /merchants/:id/settlement/pix/payments/:paymentId",
    }),
    async (req, res, next) => {
      try {
        const merchantId = requireMerchantId(req.params.id);
        const paymentId = requireMerchantId(req.params.paymentId);
        const merchant = findMerchantById(db, merchantId);
        if (!merchant) {
          throw HttpError.notFound(`Merchant ${merchantId} not found`);
        }
        if (!merchant.pix.enabled || !merchant.pix.provider) {
          throw HttpError.badRequest(
            "Merchant has not enabled Pix settlement",
          );
        }
        const client = deps.resolveClient(merchant.pix.provider);
        if (!client) {
          throw HttpError.config(
            `Pix provider "${merchant.pix.provider}" is not configured on this server`,
          );
        }
        const settlement = await settlePaymentToPix(db, client, {
          merchantId,
          paymentId,
        });
        res.status(201).json({ settlement });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/merchants/:id/pix-settlements", (req, res, next) => {
    try {
      const merchantId = requireMerchantId(req.params.id);
      const settlements = listPixSettlementsByMerchant(db, merchantId);
      res.json({ settlements, feeBps: PIX_FEE_BPS });
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

function readPixProvider(
  body: Record<string, unknown>,
  available: readonly PixProvider[],
): PixProvider {
  const raw = body.provider;
  if (!isPixProvider(raw)) {
    throw HttpError.badRequest(
      `Field "provider" must be one of: bitpreco, transfero`,
    );
  }
  if (!available.includes(raw)) {
    throw HttpError.config(
      `Pix provider "${raw}" is not configured on this server`,
    );
  }
  return raw;
}

function readPixKeyType(body: Record<string, unknown>): PixKeyType {
  const raw = body.pixKeyType;
  if (!isPixKeyType(raw)) {
    throw HttpError.badRequest(
      `Field "pixKeyType" must be one of: cpf, cnpj, email, phone, random`,
    );
  }
  return raw;
}
