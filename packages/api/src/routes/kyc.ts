import { Router, type Request, type Response, type NextFunction } from "express";
import type { Database as Db } from "better-sqlite3";
import { findMerchantByApiKey } from "../db/merchants.js";
import {
  applyWebhookEvent,
  getKycStatus,
  recordDocument,
  startKyc,
} from "../services/kyc/service.js";
import type { KycProviderClient } from "../services/kyc/provider.js";
import type { SumsubReviewPayload } from "../services/kyc/sumsub.js";
import { idempotency } from "../middleware/idempotency.js";
import { HttpError } from "../lib/errors.js";
import { optionalString, requireString } from "../lib/validate.js";

const API_KEY_HEADER = "x-zettapay-api-key";

export interface KycRouterOptions {
  /**
   * Provider client. When omitted, the start/upload/status endpoints return
   * 503 (kyc_disabled) but the webhook receiver stays mounted so we can route
   * dev/test traffic without provisioning a sandbox tenant. Production must
   * always pass a real client.
   */
  provider?: KycProviderClient;
}

function asyncHandler<
  T extends (req: Request, res: Response, next: NextFunction) => unknown,
>(fn: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function authMerchantParam(
  db: Db,
  req: Request,
): { merchantId: string } {
  const id = String(req.params.id ?? "").trim();
  if (!id) {
    throw HttpError.badRequest("Merchant id is required");
  }
  const headerValue = req.header(API_KEY_HEADER);
  if (!headerValue) {
    throw HttpError.unauthorized(`"${API_KEY_HEADER}" header is required`);
  }
  const merchant = findMerchantByApiKey(db, headerValue.trim());
  if (!merchant) {
    throw HttpError.unauthorized("Invalid API key");
  }
  if (merchant.id !== id) {
    // Treat as not-found to avoid disclosing existence of other merchants.
    throw HttpError.notFound(`Merchant ${id} not found`);
  }
  return { merchantId: merchant.id };
}

function requireProvider(
  provider: KycProviderClient | undefined,
): KycProviderClient {
  if (!provider) {
    throw new HttpError(
      503,
      "config_error",
      "KYC provider not configured — set SUMSUB_APP_TOKEN and SUMSUB_SECRET_KEY",
    );
  }
  return provider;
}

export function kycRouter(db: Db, options: KycRouterOptions = {}): Router {
  const router = Router();

  router.post(
    "/merchants/:id/kyc/start",
    idempotency(db, { scope: "POST /merchants/:id/kyc/start" }),
    asyncHandler(async (req, res) => {
      const { merchantId } = authMerchantParam(db, req);
      const provider = requireProvider(options.provider);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const levelName = optionalString(body, "levelName", { maxLength: 128 });
      const result = await startKyc(db, provider, {
        merchantId,
        ...(levelName ? { levelName } : {}),
      });
      res.status(201).json(result);
    }),
  );

  router.post("/merchants/:id/kyc/documents", (req, res, next) => {
    try {
      const { merchantId } = authMerchantParam(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const docType = requireString(body, "docType", { maxLength: 64 });
      const docSubtype = optionalString(body, "docSubtype", { maxLength: 64 });
      const fileName = optionalString(body, "fileName", { maxLength: 256 });
      const mimeType = optionalString(body, "mimeType", { maxLength: 128 });
      const externalRef = optionalString(body, "externalRef", { maxLength: 256 });
      const sizeBytesRaw = body["sizeBytes"];
      const sizeBytes =
        sizeBytesRaw === undefined || sizeBytesRaw === null
          ? null
          : (sizeBytesRaw as number);

      const result = recordDocument(db, {
        merchantId,
        docType,
        docSubtype,
        fileName,
        mimeType,
        externalRef,
        sizeBytes,
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/merchants/:id/kyc/status", (req, res, next) => {
    try {
      const { merchantId } = authMerchantParam(db, req);
      const view = getKycStatus(db, merchantId);
      if (!view) {
        res.json({
          verification: null,
          documents: [],
        });
        return;
      }
      res.json(view);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Webhook receiver. Sumsub signs the raw body — `app.ts` configures
   * `express.json` with a `verify` callback that stashes the original bytes on
   * `req.rawBody`. Re-serializing the parsed object will not match the digest,
   * so we always verify against the original buffer.
   */
  router.post("/webhooks/sumsub", (req, res, next) => {
    try {
      const provider = options.provider;
      if (!provider) {
        res.status(503).json({
          error: {
            code: "kyc_disabled",
            message: "KYC provider not configured",
          },
        });
        return;
      }
      if (provider.name !== "sumsub") {
        res.status(503).json({
          error: {
            code: "kyc_disabled",
            message: "Sumsub webhook received but provider is not Sumsub",
          },
        });
        return;
      }

      const reqWithRaw = req as Request & { rawBody?: Buffer };
      const rawBody = reqWithRaw.rawBody ?? Buffer.alloc(0);

      const verification = provider.verifyWebhook({
        rawBody,
        headers: req.headers as Record<
          string,
          string | string[] | undefined
        >,
      });
      if (!verification.valid) {
        res.status(401).json({
          error: {
            code: "invalid_signature",
            message: `webhook signature rejected: ${verification.reason}`,
          },
        });
        return;
      }

      // Prefer the already-parsed body from express.json. Falling back to the
      // raw bytes covers the edge case where rawBody is present but the JSON
      // middleware skipped parsing (e.g. unsupported content-type).
      let payload: SumsubReviewPayload | null = null;
      if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
        payload = req.body as SumsubReviewPayload;
      } else if (rawBody.length > 0) {
        try {
          payload = JSON.parse(rawBody.toString("utf8")) as SumsubReviewPayload;
        } catch {
          res.status(400).json({
            error: {
              code: "invalid_json",
              message: "webhook body is not valid JSON",
            },
          });
          return;
        }
      }
      if (!payload || typeof payload !== "object") {
        res.status(400).json({
          error: {
            code: "invalid_payload",
            message: "webhook payload must be a JSON object",
          },
        });
        return;
      }

      const result = applyWebhookEvent(db, {
        provider: "sumsub",
        payload,
      });

      // Always 200 once signature is valid — Sumsub stops retrying on 2xx.
      res.status(200).json({
        accepted: true,
        changed: result.changed,
        verificationId: result.verification?.id ?? null,
        status: result.verification?.status ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
