import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import {
  findMerchantById,
  updateMerchantFraudThreshold,
} from "../db/merchants.js";
import {
  findRiskAssessment,
  listReviewQueue,
  updateReviewStatus,
  type RiskReviewStatus,
} from "../db/risk_assessments.js";
import { appendAudit } from "../db/audit_journal.js";
import { HttpError } from "../lib/errors.js";
import { optionalString } from "../lib/validate.js";

const THRESHOLD_MIN = 0;
const THRESHOLD_MAX = 100;

function requireThreshold(body: Record<string, unknown>): number {
  const value = body["threshold"];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < THRESHOLD_MIN ||
    value > THRESHOLD_MAX
  ) {
    throw HttpError.badRequest(
      `Field "threshold" is required and must be an integer in [${THRESHOLD_MIN}, ${THRESHOLD_MAX}]`,
    );
  }
  return value;
}

function parseStatusQuery(raw: unknown): RiskReviewStatus {
  if (raw === undefined || raw === null || raw === "") return "pending";
  if (raw === "pending" || raw === "approved" || raw === "rejected") return raw;
  throw HttpError.badRequest(
    `Query "status" must be one of pending|approved|rejected`,
  );
}

function requireDecision(
  body: Record<string, unknown>,
): "approved" | "rejected" {
  const value = body["decision"];
  if (value !== "approved" && value !== "rejected") {
    throw HttpError.badRequest(
      `Field "decision" must be "approved" or "rejected"`,
    );
  }
  return value;
}

export function riskRouter(db: Db): Router {
  const router = Router();

  // Z13.4: tune the merchant's review threshold. 0 = every payment hits the
  // queue (paranoid); 100 = effectively disabled (no payment can score above
  // the cap). Default is 70.
  router.put("/merchants/:id/fraud-threshold", (req, res, next) => {
    try {
      const id = req.params.id;
      const merchant = findMerchantById(db, id);
      if (!merchant) {
        throw HttpError.notFound(`Merchant ${id} not found`);
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const threshold = requireThreshold(body);
      const updated = updateMerchantFraudThreshold(db, id, threshold);
      appendAudit(db, {
        actor: `merchant:${id}`,
        event: "merchant.fraud_threshold.updated",
        entityType: "merchant",
        entityId: id,
        reason: `fraud review threshold changed`,
        payload: {
          before: merchant.fraudReviewThreshold,
          after: threshold,
        },
      });
      res.json({
        merchant: {
          id: updated.id,
          fraudReviewThreshold: updated.fraudReviewThreshold,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // List the review queue for a merchant. Defaults to status=pending; pass
  // ?status=approved or ?status=rejected to view historical decisions.
  router.get("/merchants/:id/risk/queue", (req, res, next) => {
    try {
      const id = req.params.id;
      const merchant = findMerchantById(db, id);
      if (!merchant) {
        throw HttpError.notFound(`Merchant ${id} not found`);
      }
      const status = parseStatusQuery(req.query.status);
      const limitRaw = req.query.limit;
      let limit: number | undefined;
      if (typeof limitRaw === "string" && limitRaw.length > 0) {
        const parsed = Number.parseInt(limitRaw, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw HttpError.badRequest(`Query "limit" must be a positive integer`);
        }
        limit = parsed;
      }
      const items = listReviewQueue(db, {
        merchantId: id,
        status,
        ...(limit !== undefined ? { limit } : {}),
      });
      res.json({ items, count: items.length, status });
    } catch (err) {
      next(err);
    }
  });

  // Resolve a queued review. Marks the assessment approved/rejected with the
  // reviewing actor and an optional reason. The original payment was already
  // rejected at /pay time — approving here only clears the queue entry; the
  // customer must retry the payment for funds to actually move.
  router.patch("/risk/:id/review", (req, res, next) => {
    try {
      const id = req.params.id;
      const assessment = findRiskAssessment(db, id);
      if (!assessment) {
        throw HttpError.notFound(`risk assessment ${id} not found`);
      }
      if (assessment.decision !== "review") {
        throw HttpError.conflict(
          `risk assessment ${id} was auto-allowed and is not in the review queue`,
        );
      }
      if (assessment.reviewStatus !== "pending") {
        throw HttpError.conflict(
          `risk assessment ${id} already resolved as ${assessment.reviewStatus}`,
        );
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const decision = requireDecision(body);
      const reason = optionalString(body, "reason", { maxLength: 500 });
      const reviewedBy =
        optionalString(body, "reviewedBy", { maxLength: 128 }) ?? "admin";
      const updated = updateReviewStatus(db, id, {
        reviewStatus: decision,
        reviewedBy,
        reviewReason: reason,
      });
      appendAudit(db, {
        actor: reviewedBy,
        event:
          decision === "approved"
            ? "risk.review.approved"
            : "risk.review.rejected",
        entityType: "merchant",
        entityId: assessment.merchantId,
        reason: reason ?? `manual review ${decision}`,
        payload: {
          riskAssessmentId: id,
          score: assessment.score,
          threshold: assessment.threshold,
          payerWallet: assessment.payerWallet,
          amount: assessment.amountUsdc,
        },
      });
      res.json({ assessment: updated });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
