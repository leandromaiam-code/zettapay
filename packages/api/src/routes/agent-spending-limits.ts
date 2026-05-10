import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { findMerchantById } from "../db/merchants.js";
import { findAgentIdentityById } from "../db/agent_identities.js";
import {
  findAgentSpendingLimit,
  listAgentSpendingLimits,
  setAgentSpendingLimitFrozen,
  upsertAgentSpendingLimit,
  type AgentSpendingLimit,
} from "../db/agent_spending_limits.js";
import { appendAudit } from "../db/audit_journal.js";
import { HttpError } from "../lib/errors.js";

// Hard ceilings: a misconfigured value of `1e18` would silently disable the
// cap. Forces merchants to think in real USDC. Override only if Z11+ raises
// the per-merchant velocity ceiling first.
const MAX_PER_REQUEST_CEIL = 1_000_000;
const DAILY_CAP_CEIL = 10_000_000;

function publicView(limit: AgentSpendingLimit) {
  return {
    id: limit.id,
    merchantId: limit.merchantId,
    agentIdentityId: limit.agentIdentityId,
    maxPerRequest: limit.maxPerRequest,
    dailyCap: limit.dailyCap,
    frozen: limit.frozen,
    createdAt: limit.createdAt,
    updatedAt: limit.updatedAt,
  };
}

function readOptionalCap(
  body: Record<string, unknown>,
  field: string,
  ceiling: number,
): number | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw HttpError.badRequest(
      `Field "${field}" must be a non-negative number or null`,
    );
  }
  if (value > ceiling) {
    throw HttpError.badRequest(
      `Field "${field}" cannot exceed ${ceiling}`,
    );
  }
  return value;
}

function ensureMerchantAndAgent(
  db: Db,
  merchantId: string,
  agentIdentityId: string,
): void {
  const merchant = findMerchantById(db, merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${merchantId} not found`);
  }
  const identity = findAgentIdentityById(db, agentIdentityId);
  if (!identity) {
    throw HttpError.notFound(`Agent identity ${agentIdentityId} not found`);
  }
}

export function agentSpendingLimitsRouter(db: Db): Router {
  const router = Router();

  router.get("/merchants/:id/agents/limits", (req, res, next) => {
    try {
      const merchantId = req.params.id;
      const merchant = findMerchantById(db, merchantId);
      if (!merchant) {
        throw HttpError.notFound(`Merchant ${merchantId} not found`);
      }
      const limits = listAgentSpendingLimits(db, merchantId);
      res.json({ limits: limits.map(publicView) });
    } catch (err) {
      next(err);
    }
  });

  router.get(
    "/merchants/:id/agents/:agentIdentityId/limits",
    (req, res, next) => {
      try {
        const { id: merchantId, agentIdentityId } = req.params;
        ensureMerchantAndAgent(db, merchantId, agentIdentityId);
        const limit = findAgentSpendingLimit(db, merchantId, agentIdentityId);
        if (!limit) {
          throw HttpError.notFound(
            `No spending limit configured for agent ${agentIdentityId}`,
          );
        }
        res.json({ limit: publicView(limit) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.put(
    "/merchants/:id/agents/:agentIdentityId/limits",
    (req, res, next) => {
      try {
        const { id: merchantId, agentIdentityId } = req.params;
        ensureMerchantAndAgent(db, merchantId, agentIdentityId);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const maxPerRequest = readOptionalCap(
          body,
          "maxPerRequest",
          MAX_PER_REQUEST_CEIL,
        );
        const dailyCap = readOptionalCap(body, "dailyCap", DAILY_CAP_CEIL);
        const limit = upsertAgentSpendingLimit(db, {
          merchantId,
          agentIdentityId,
          maxPerRequest,
          dailyCap,
        });
        appendAudit(db, {
          actor: `merchant:${merchantId}`,
          event: "agent_spending_limit.upserted",
          entityType: "agent_identity",
          entityId: agentIdentityId,
          reason: "merchant configured per-agent spending caps",
          payload: { merchantId, maxPerRequest, dailyCap },
        });
        res.json({ limit: publicView(limit) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/merchants/:id/agents/:agentIdentityId/freeze",
    (req, res, next) => {
      try {
        const { id: merchantId, agentIdentityId } = req.params;
        ensureMerchantAndAgent(db, merchantId, agentIdentityId);
        const limit = setAgentSpendingLimitFrozen(
          db,
          merchantId,
          agentIdentityId,
          true,
        );
        if (!limit) {
          throw HttpError.notFound(
            `Failed to freeze agent ${agentIdentityId}`,
          );
        }
        appendAudit(db, {
          actor: `merchant:${merchantId}`,
          event: "agent_identity.frozen",
          entityType: "agent_identity",
          entityId: agentIdentityId,
          reason: "merchant pressed freeze button — payments suspended",
          payload: { merchantId },
        });
        res.json({ limit: publicView(limit) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/merchants/:id/agents/:agentIdentityId/unfreeze",
    (req, res, next) => {
      try {
        const { id: merchantId, agentIdentityId } = req.params;
        ensureMerchantAndAgent(db, merchantId, agentIdentityId);
        const limit = setAgentSpendingLimitFrozen(
          db,
          merchantId,
          agentIdentityId,
          false,
        );
        if (!limit) {
          // No row + unfreeze is a no-op — return an empty default.
          res.json({ limit: null });
          return;
        }
        appendAudit(db, {
          actor: `merchant:${merchantId}`,
          event: "agent_identity.unfrozen",
          entityType: "agent_identity",
          entityId: agentIdentityId,
          reason: "merchant unfroze agent — payments resumed",
          payload: { merchantId },
        });
        res.json({ limit: publicView(limit) });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
