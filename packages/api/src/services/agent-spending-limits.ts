import type { Database as Db } from "better-sqlite3";
import { findAgentSpendingLimit } from "../db/agent_spending_limits.js";
import { sumPaymentAmountByAgentSince } from "../db/payments.js";
import { HttpError } from "../lib/errors.js";

const ONE_DAY_MS = 24 * 60 * 60_000;

export interface AgentSpendingCheckInput {
  merchantId: string;
  agentIdentityId: string;
  amount: number;
  /** Optional clock override for deterministic tests. */
  now?: Date;
}

export interface AgentSpendingCheckTelemetry {
  spentInWindow: number;
  maxPerRequest: number | null;
  dailyCap: number | null;
  frozen: boolean;
}

/**
 * Z20.3 per-agent fraud gate. When a merchant has configured limits for the
 * (merchant_id, agent_identity_id) tuple, this enforces:
 *
 *  - frozen flag → 403 (panic button: kill all spend from a compromised agent)
 *  - max_per_request → 429 (single payment ceiling)
 *  - daily_cap → 429 (rolling 24h spend ceiling)
 *
 * Missing config is permissive — agents without explicit limits fall through
 * to the merchant-level velocity caps (Z13.1). Setting either cap to `null`
 * disables that specific check, but the row still gates the freeze flag.
 */
export function enforceAgentSpendingLimits(
  db: Db,
  input: AgentSpendingCheckInput,
): AgentSpendingCheckTelemetry {
  const limit = findAgentSpendingLimit(
    db,
    input.merchantId,
    input.agentIdentityId,
  );
  if (!limit) {
    return {
      spentInWindow: 0,
      maxPerRequest: null,
      dailyCap: null,
      frozen: false,
    };
  }

  if (limit.frozen) {
    throw new HttpError(
      403,
      "unauthorized",
      "Agent is frozen by merchant — payments suspended",
      {
        scope: "agent_spending_limits:frozen",
        merchantId: input.merchantId,
        agentIdentityId: input.agentIdentityId,
      },
    );
  }

  if (limit.maxPerRequest !== null && input.amount > limit.maxPerRequest) {
    throw HttpError.rateLimited(
      `Payment amount ${input.amount} exceeds agent max_per_request ${limit.maxPerRequest}`,
      {
        scope: "agent_spending_limits:max_per_request",
        merchantId: input.merchantId,
        agentIdentityId: input.agentIdentityId,
        limit: limit.maxPerRequest,
        attempted: input.amount,
      },
    );
  }

  let spentInWindow = 0;
  if (limit.dailyCap !== null) {
    const now = input.now ?? new Date();
    const windowStart = new Date(now.getTime() - ONE_DAY_MS).toISOString();
    spentInWindow = sumPaymentAmountByAgentSince(
      db,
      input.merchantId,
      input.agentIdentityId,
      windowStart,
    );
    if (spentInWindow + input.amount > limit.dailyCap) {
      throw HttpError.rateLimited(
        `Agent daily cap of ${limit.dailyCap} would be exceeded (already spent ${spentInWindow}, attempted ${input.amount})`,
        {
          scope: "agent_spending_limits:daily_cap",
          merchantId: input.merchantId,
          agentIdentityId: input.agentIdentityId,
          limit: limit.dailyCap,
          observed: spentInWindow,
          attempted: input.amount,
          windowSec: 86400,
        },
      );
    }
  }

  return {
    spentInWindow,
    maxPerRequest: limit.maxPerRequest,
    dailyCap: limit.dailyCap,
    frozen: false,
  };
}
