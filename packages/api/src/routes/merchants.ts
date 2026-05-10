import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { registerMerchant } from "../services/merchants.js";
import { idempotency } from "../middleware/idempotency.js";
import {
  optionalString,
  requireSolanaAddress,
  requireString,
} from "../lib/validate.js";
import { HttpError } from "../lib/errors.js";
import {
  findMerchantById,
  updateMerchantVelocity,
} from "../db/merchants.js";
import { appendAudit } from "../db/audit_journal.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https:\/\//i;

// Hard ceilings prevent a misconfigured merchant from disabling velocity
// fraud protection entirely. `0` is a sentinel for "disable this cap" but is
// only acceptable when explicitly opted into via the per-cap field.
const VELOCITY_MAX_PER_MINUTE_CEIL = 1000;
const VELOCITY_MAX_AMOUNT_PER_HOUR_CEIL = 1_000_000;

function requireNonNegativeInteger(
  body: Record<string, unknown>,
  field: string,
  ceiling: number,
): number {
  const value = body[field];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw HttpError.badRequest(
      `Field "${field}" is required and must be a non-negative integer`,
    );
  }
  if (value > ceiling) {
    throw HttpError.badRequest(
      `Field "${field}" cannot exceed ${ceiling}`,
    );
  }
  return value;
}

function requireNonNegativeNumber(
  body: Record<string, unknown>,
  field: string,
  ceiling: number,
): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw HttpError.badRequest(
      `Field "${field}" is required and must be a non-negative number`,
    );
  }
  if (value > ceiling) {
    throw HttpError.badRequest(
      `Field "${field}" cannot exceed ${ceiling}`,
    );
  }
  return value;
}

export function merchantsRouter(db: Db): Router {
  const router = Router();

  router.post(
    "/merchants/register",
    idempotency(db, { scope: "POST /merchants/register" }),
    (req, res, next) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const name = requireString(body, "name", { maxLength: 120 });
        const walletAddress = requireSolanaAddress(body, "walletAddress");
        const email = requireString(body, "email", { maxLength: 254 }).toLowerCase();
        if (!EMAIL_RE.test(email)) {
          throw HttpError.badRequest('Field "email" must be a valid email address');
        }
        const webhookUrl = optionalString(body, "webhookUrl", { maxLength: 2048 });
        if (webhookUrl && !URL_RE.test(webhookUrl)) {
          throw HttpError.badRequest(
            'Field "webhookUrl" must be an https:// URL (TLS required)',
          );
        }

        const merchant = registerMerchant(db, {
          name,
          walletAddress,
          email,
          webhookUrl,
        });
        res.status(201).json({ merchant });
      } catch (err) {
        next(err);
      }
    },
  );

  router.put("/merchants/:id/velocity", (req, res, next) => {
    try {
      const id = req.params.id;
      const merchant = findMerchantById(db, id);
      if (!merchant) {
        throw HttpError.notFound(`Merchant ${id} not found`);
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const maxPaymentsPerMinute = requireNonNegativeInteger(
        body,
        "maxPaymentsPerMinute",
        VELOCITY_MAX_PER_MINUTE_CEIL,
      );
      const maxAmountPerHour = requireNonNegativeNumber(
        body,
        "maxAmountPerHour",
        VELOCITY_MAX_AMOUNT_PER_HOUR_CEIL,
      );
      const updated = updateMerchantVelocity(db, id, {
        maxPaymentsPerMinute,
        maxAmountPerHour,
      });
      appendAudit(db, {
        actor: `merchant:${id}`,
        event: "merchant.velocity.updated",
        entityType: "merchant",
        entityId: id,
        reason: "velocity caps changed via PUT /merchants/:id/velocity",
        payload: {
          before: {
            maxPaymentsPerMinute: merchant.velocity.maxPaymentsPerMinute,
            maxAmountPerHour: merchant.velocity.maxAmountPerHour,
          },
          after: { maxPaymentsPerMinute, maxAmountPerHour },
        },
      });
      res.json({ merchant: updated });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
