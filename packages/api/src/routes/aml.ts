import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { Database as Db } from "better-sqlite3";
import { findMerchantByApiKey } from "../db/merchants.js";
import {
  fileSar,
  generateSar,
  getAlert,
  getSar,
  listAlerts,
  listSars,
  reviewAlert,
} from "../services/aml.js";
import type { AmlAlertStatus, AmlSarStatus } from "../db/aml.js";
import { idempotency } from "../middleware/idempotency.js";
import { HttpError } from "../lib/errors.js";
import { optionalString, requireString } from "../lib/validate.js";

const API_KEY_HEADER = "x-zettapay-api-key";
const VALID_REVIEW_STATUSES: ReadonlySet<AmlAlertStatus> = new Set([
  "reviewed",
  "dismissed",
  "escalated",
]);
const VALID_LIST_STATUSES: ReadonlySet<AmlAlertStatus> = new Set([
  "open",
  "reviewed",
  "dismissed",
  "escalated",
]);
const VALID_SAR_STATUSES: ReadonlySet<AmlSarStatus> = new Set([
  "draft",
  "filed",
  "closed",
]);

function authMerchantParam(db: Db, req: Request): { merchantId: string } {
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
    throw HttpError.notFound(`Merchant ${id} not found`);
  }
  return { merchantId: merchant.id };
}

function optionalLimit(query: Record<string, unknown>): number | undefined {
  const raw = query["limit"];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw HttpError.badRequest("limit must be a positive integer");
  }
  return Math.min(500, Math.floor(parsed));
}

function requireStringArray(
  body: Record<string, unknown>,
  field: string,
  opts: { maxLength: number },
): string[] {
  const value = body[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw HttpError.badRequest(
      `Field "${field}" is required and must be a non-empty array of strings`,
    );
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw HttpError.badRequest(
        `Field "${field}" must contain non-empty strings`,
      );
    }
    if (entry.length > opts.maxLength) {
      throw HttpError.badRequest(
        `Field "${field}" entries must be at most ${opts.maxLength} chars`,
      );
    }
    out.push(entry.trim());
  }
  return out;
}

function handle<
  T extends (req: Request, res: Response) => unknown | Promise<unknown>,
>(fn: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

export function amlRouter(db: Db): Router {
  const router = Router();

  router.get(
    "/merchants/:id/aml/alerts",
    handle((req, res) => {
      const { merchantId } = authMerchantParam(db, req);
      const query = req.query as Record<string, unknown>;

      const statusRaw = optionalString(query, "status", { maxLength: 32 });
      let status: AmlAlertStatus | undefined;
      if (statusRaw) {
        if (!VALID_LIST_STATUSES.has(statusRaw as AmlAlertStatus)) {
          throw HttpError.badRequest(
            `status must be one of ${Array.from(VALID_LIST_STATUSES).join(",")}`,
          );
        }
        status = statusRaw as AmlAlertStatus;
      }
      const payerWallet = optionalString(query, "payerWallet", {
        maxLength: 64,
      });
      const paymentId = optionalString(query, "paymentId", { maxLength: 64 });
      const limit = optionalLimit(query);

      const alerts = listAlerts(db, {
        merchantId,
        ...(status ? { status } : {}),
        ...(payerWallet ? { payerWallet } : {}),
        ...(paymentId ? { paymentId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      res.json({ alerts });
    }),
  );

  router.get(
    "/merchants/:id/aml/alerts/:alertId",
    handle((req, res) => {
      const { merchantId } = authMerchantParam(db, req);
      const alertId = String(req.params.alertId ?? "").trim();
      if (!alertId) {
        throw HttpError.badRequest("alertId is required");
      }
      const alert = getAlert(db, merchantId, alertId);
      res.json({ alert });
    }),
  );

  router.post(
    "/merchants/:id/aml/alerts/:alertId/review",
    idempotency(db, { scope: "POST /merchants/:id/aml/alerts/:alertId/review" }),
    handle((req, res) => {
      const { merchantId } = authMerchantParam(db, req);
      const alertId = String(req.params.alertId ?? "").trim();
      if (!alertId) {
        throw HttpError.badRequest("alertId is required");
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const status = requireString(body, "status", { maxLength: 32 });
      if (!VALID_REVIEW_STATUSES.has(status as AmlAlertStatus)) {
        throw HttpError.badRequest(
          `status must be one of ${Array.from(VALID_REVIEW_STATUSES).join(",")}`,
        );
      }
      const reviewedBy = requireString(body, "reviewedBy", { maxLength: 128 });
      const notes = optionalString(body, "notes", { maxLength: 2_000 });
      const alert = reviewAlert(db, {
        alertId,
        merchantId,
        status: status as AmlAlertStatus,
        reviewedBy,
        notes,
      });
      res.status(200).json({ alert });
    }),
  );

  router.post(
    "/merchants/:id/aml/sars",
    idempotency(db, { scope: "POST /merchants/:id/aml/sars" }),
    handle((req, res) => {
      const { merchantId } = authMerchantParam(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const alertIds = requireStringArray(body, "alertIds", { maxLength: 64 });
      const narrative = requireString(body, "narrative", { maxLength: 8_000 });
      const filedBy = requireString(body, "filedBy", { maxLength: 128 });
      const subjectWallet = optionalString(body, "subjectWallet", {
        maxLength: 64,
      });
      const subjectSummary = optionalString(body, "subjectSummary", {
        maxLength: 2_000,
      });
      const sar = generateSar(db, {
        merchantId,
        alertIds,
        narrative,
        filedBy,
        subjectWallet,
        subjectSummary,
      });
      res.status(201).json({ sar });
    }),
  );

  router.get(
    "/merchants/:id/aml/sars",
    handle((req, res) => {
      const { merchantId } = authMerchantParam(db, req);
      const query = req.query as Record<string, unknown>;
      const statusRaw = optionalString(query, "status", { maxLength: 32 });
      let status: AmlSarStatus | undefined;
      if (statusRaw) {
        if (!VALID_SAR_STATUSES.has(statusRaw as AmlSarStatus)) {
          throw HttpError.badRequest(
            `status must be one of ${Array.from(VALID_SAR_STATUSES).join(",")}`,
          );
        }
        status = statusRaw as AmlSarStatus;
      }
      const limit = optionalLimit(query);
      const sars = listSars(db, {
        merchantId,
        ...(status ? { status } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      res.json({ sars });
    }),
  );

  router.get(
    "/merchants/:id/aml/sars/:sarId",
    handle((req, res) => {
      const { merchantId } = authMerchantParam(db, req);
      const sarId = String(req.params.sarId ?? "").trim();
      if (!sarId) {
        throw HttpError.badRequest("sarId is required");
      }
      const sar = getSar(db, merchantId, sarId);
      res.json({ sar });
    }),
  );

  router.post(
    "/merchants/:id/aml/sars/:sarId/file",
    idempotency(db, {
      scope: "POST /merchants/:id/aml/sars/:sarId/file",
    }),
    handle((req, res) => {
      const { merchantId } = authMerchantParam(db, req);
      const sarId = String(req.params.sarId ?? "").trim();
      if (!sarId) {
        throw HttpError.badRequest("sarId is required");
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const filedBy = requireString(body, "filedBy", { maxLength: 128 });
      const externalFilingId = optionalString(body, "externalFilingId", {
        maxLength: 256,
      });
      const sar = fileSar(db, {
        merchantId,
        sarId,
        filedBy,
        externalFilingId,
      });
      res.status(200).json({ sar });
    }),
  );

  return router;
}
