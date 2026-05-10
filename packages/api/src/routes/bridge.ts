import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { idempotency } from "../middleware/idempotency.js";
import { HttpError } from "../lib/errors.js";
import { normalizeCurrency } from "../lib/currencies.js";
import {
  optionalRecord,
  optionalString,
  requirePositiveNumber,
  requireSolanaAddress,
  requireString,
} from "../lib/validate.js";
import {
  completeBridgeIntent,
  quoteBridgeIntent,
  recordBridgeSourceTransaction,
  syncBridgeIntent,
} from "../bridge/service.js";
import {
  isSupportedSourceChain,
  normalizeSourceChain,
  SUPPORTED_BRIDGE_CURRENCIES,
  SUPPORTED_SOURCE_CHAINS,
  type SourceChain,
} from "../bridge/chains.js";
import { BRIDGE_FEE_BPS } from "../bridge/fee.js";
import {
  findBridgeIntent,
  listBridgeIntentsByMerchant,
} from "../db/bridge_intents.js";
import type { AttestationClient } from "../bridge/attestation.js";
import type { SolanaService } from "../services/solana.js";

const MAX_AMOUNT = 1_000_000;
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface BridgeRouterDeps {
  attestation: AttestationClient;
  solana: SolanaService;
}

export function bridgeRouter(db: Db, deps: BridgeRouterDeps): Router {
  const router = Router();
  const cluster = deps.solana.getCluster();

  router.get("/bridge/chains", (_req, res) => {
    res.json({
      sourceChains: SUPPORTED_SOURCE_CHAINS,
      currencies: SUPPORTED_BRIDGE_CURRENCIES,
      feeBps: BRIDGE_FEE_BPS,
    });
  });

  router.post(
    "/bridge/quote",
    idempotency(db, { scope: "POST /bridge/quote" }),
    (req, res, next) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const merchantId = requireString(body, "merchantId", { maxLength: 64 });
        const rawChain = requireString(body, "sourceChain", { maxLength: 32 });
        if (!isSupportedSourceChain(rawChain)) {
          throw HttpError.badRequest(
            `Unsupported source chain "${rawChain}". Expected one of: ${SUPPORTED_SOURCE_CHAINS.join(", ")}`,
          );
        }
        const sourceChain: SourceChain = normalizeSourceChain(rawChain);
        const currency = normalizeCurrency(
          optionalString(body, "currency", { maxLength: 8 }) ?? "USDC",
        );
        const amount = requirePositiveNumber(body, "amount");
        if (amount > MAX_AMOUNT) {
          throw HttpError.badRequest(
            `Field "amount" cannot exceed ${MAX_AMOUNT}`,
          );
        }
        const recipientWallet = requireSolanaAddress(body, "recipientWallet");
        const metadata = optionalRecord(body, "metadata");

        const quote = quoteBridgeIntent(
          db,
          {
            merchantId,
            sourceChain,
            sourceCurrency: currency,
            amount,
            recipientWallet,
            metadata,
          },
          cluster,
        );

        res.status(201).json({
          intent: serializeIntent(quote.intent),
          source: quote.source,
          destination: quote.destination,
          mintRecipientBytes32: quote.mintRecipientBytes32,
          estimatedSeconds: quote.estimatedSeconds,
          feeBps: BRIDGE_FEE_BPS,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/bridge/intents/:id/source-tx",
    idempotency(db, { scope: "POST /bridge/intents/:id/source-tx" }),
    (req, res, next) => {
      try {
        const intentId = requireIntentId(req.params.id);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const sourceTxHash = requireString(body, "sourceTxHash", {
          maxLength: 80,
        });
        if (!TX_HASH_PATTERN.test(sourceTxHash)) {
          throw HttpError.badRequest(
            `Field "sourceTxHash" must be a 0x-prefixed 32-byte hex string`,
          );
        }
        const intent = recordBridgeSourceTransaction(
          db,
          intentId,
          sourceTxHash,
        );
        res.status(200).json({ intent: serializeIntent(intent) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/bridge/intents/:id/sync",
    async (req, res, next) => {
      try {
        const intentId = requireIntentId(req.params.id);
        const intent = await syncBridgeIntent(
          db,
          deps.attestation,
          intentId,
        );
        res.status(200).json({ intent: serializeIntent(intent) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/bridge/intents/:id/complete",
    idempotency(db, { scope: "POST /bridge/intents/:id/complete" }),
    (req, res, next) => {
      try {
        const intentId = requireIntentId(req.params.id);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const redemptionSignature = requireString(body, "redemptionSignature", {
          maxLength: 128,
        });
        const paymentId = optionalString(body, "paymentId", { maxLength: 64 });
        const intent = completeBridgeIntent(
          db,
          intentId,
          redemptionSignature,
          paymentId,
        );
        res.status(200).json({ intent: serializeIntent(intent) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/bridge/intents/:id", (req, res, next) => {
    try {
      const intentId = requireIntentId(req.params.id);
      const intent = findBridgeIntent(db, intentId);
      if (!intent) {
        throw HttpError.notFound(`Bridge intent ${intentId} not found`);
      }
      res.json({ intent: serializeIntent(intent) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/merchants/:id/bridge/intents", (req, res, next) => {
    try {
      const merchantId = requireIntentId(req.params.id);
      const intents = listBridgeIntentsByMerchant(db, merchantId);
      res.json({
        merchantId,
        intents: intents.map(serializeIntent),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function requireIntentId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw HttpError.badRequest("Path parameter :id is required");
  }
  if (value.length > 64) {
    throw HttpError.badRequest("Path parameter :id exceeds max length of 64");
  }
  return value;
}

function serializeIntent(intent: ReturnType<typeof findBridgeIntent>) {
  if (!intent) return null;
  return {
    id: intent.id,
    merchantId: intent.merchantId,
    sourceChain: intent.sourceChain,
    sourceNetwork: intent.sourceNetwork,
    sourceCurrency: intent.sourceCurrency,
    destinationCurrency: intent.destinationCurrency,
    recipientWallet: intent.recipientWallet,
    amountUsdc: intent.amountUsdc,
    feeUsdc: intent.feeUsdc,
    netUsdc: intent.netUsdc,
    feeBps: intent.feeBps,
    sourceTxHash: intent.sourceTxHash,
    attestationHash: intent.attestationHash,
    attestationStatus: intent.attestationStatus,
    redemptionSignature: intent.redemptionSignature,
    paymentId: intent.paymentId,
    status: intent.status,
    errorMessage: intent.errorMessage,
    metadata: intent.metadata,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
  };
}
