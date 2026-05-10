import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { HttpError } from "../lib/errors.js";
import {
  optionalString,
  requirePositiveNumber,
  requireString,
} from "../lib/validate.js";
import { idempotency } from "../middleware/idempotency.js";
import { treasuryAuth } from "../middleware/treasury-auth.js";
import type { TreasuryService } from "../services/treasury.js";
import type {
  TreasuryEntryKind,
  TreasuryEntryReason,
} from "../db/treasury_reserves.js";

const VALID_CREDIT_REASONS = new Set<TreasuryEntryReason>([
  "manual_top_up",
  "rebalance",
]);

const VALID_DEBIT_REASONS = new Set<TreasuryEntryReason>([
  "incident_refund",
  "operational_drawdown",
  "rebalance",
]);

const VALID_LIST_KINDS = new Set<TreasuryEntryKind>(["credit", "debit"]);

const VALID_LIST_REASONS = new Set<TreasuryEntryReason>([
  "tpv_contribution",
  "manual_top_up",
  "incident_refund",
  "operational_drawdown",
  "rebalance",
]);

export interface TreasuryRouterDeps {
  treasury: TreasuryService;
  adminKey: string | null | undefined;
}

export function treasuryRouter(db: Db, deps: TreasuryRouterDeps): Router {
  const router = Router();
  const auth = treasuryAuth({ adminKey: deps.adminKey });

  router.get("/treasury/reserve", auth, (_req, res, next) => {
    try {
      res.json({ reserve: deps.treasury.getSummary() });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/treasury/reserve/credits",
    auth,
    idempotency(db, { scope: "POST /treasury/reserve/credits" }),
    (req, res, next) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const amountUsdc = requirePositiveNumber(body, "amountUsdc");
        const reason = parseReason(body, VALID_CREDIT_REASONS);
        const externalRef = optionalString(body, "externalRef", { maxLength: 256 });
        const memo = optionalString(body, "memo", { maxLength: 512 });
        const merchantId = optionalString(body, "merchantId", { maxLength: 128 });
        const actor = req.treasury?.treasuryActor ?? "treasury-admin";
        const entry = deps.treasury.recordCredit({
          amountUsdc,
          reason,
          externalRef,
          memo,
          merchantId,
          actor,
        });
        res.status(201).json({ entry, reserve: deps.treasury.getSummary() });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/treasury/reserve/debits",
    auth,
    idempotency(db, { scope: "POST /treasury/reserve/debits" }),
    (req, res, next) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const amountUsdc = requirePositiveNumber(body, "amountUsdc");
        const reason = parseReason(body, VALID_DEBIT_REASONS);
        const externalRef = optionalString(body, "externalRef", { maxLength: 256 });
        const memo = optionalString(body, "memo", { maxLength: 512 });
        const merchantId = optionalString(body, "merchantId", { maxLength: 128 });
        const paymentId = optionalString(body, "paymentId", { maxLength: 128 });
        const actor = req.treasury?.treasuryActor ?? "treasury-admin";
        const entry = deps.treasury.recordDebit({
          amountUsdc,
          reason,
          externalRef,
          memo,
          merchantId,
          paymentId,
          actor,
        });
        res.status(201).json({ entry, reserve: deps.treasury.getSummary() });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/treasury/reserve/entries", auth, (req, res, next) => {
    try {
      const kindRaw = typeof req.query.kind === "string" ? req.query.kind : null;
      const reasonRaw =
        typeof req.query.reason === "string" ? req.query.reason : null;
      const limitRaw =
        typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : null;
      if (kindRaw !== null && !VALID_LIST_KINDS.has(kindRaw as TreasuryEntryKind)) {
        throw HttpError.badRequest(
          `query "kind" must be one of: ${[...VALID_LIST_KINDS].join(", ")}`,
        );
      }
      if (
        reasonRaw !== null &&
        !VALID_LIST_REASONS.has(reasonRaw as TreasuryEntryReason)
      ) {
        throw HttpError.badRequest(
          `query "reason" must be one of: ${[...VALID_LIST_REASONS].join(", ")}`,
        );
      }
      if (limitRaw !== null && (!Number.isFinite(limitRaw) || limitRaw <= 0)) {
        throw HttpError.badRequest('query "limit" must be a positive integer');
      }
      const entries = deps.treasury.list({
        ...(kindRaw ? { kind: kindRaw as TreasuryEntryKind } : {}),
        ...(reasonRaw ? { reason: reasonRaw as TreasuryEntryReason } : {}),
        ...(limitRaw ? { limit: limitRaw } : {}),
      });
      res.json({ entries });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function parseReason(
  body: Record<string, unknown>,
  allowed: Set<TreasuryEntryReason>,
): Extract<
  TreasuryEntryReason,
  "manual_top_up" | "incident_refund" | "operational_drawdown" | "rebalance"
> {
  const raw = requireString(body, "reason", { maxLength: 64 });
  if (!allowed.has(raw as TreasuryEntryReason)) {
    throw HttpError.badRequest(
      `Field "reason" must be one of: ${[...allowed].join(", ")}`,
    );
  }
  return raw as Extract<
    TreasuryEntryReason,
    "manual_top_up" | "incident_refund" | "operational_drawdown" | "rebalance"
  >;
}
