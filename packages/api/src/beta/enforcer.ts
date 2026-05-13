import type { Database as Db } from "better-sqlite3";
import type { Merchant } from "../db/merchants.js";
import { sumPaymentAmountByMerchantSince } from "../db/payments.js";
import { HttpError } from "../lib/errors.js";
import {
  betaEndsAt,
  isBetaExpired,
  isMerchantCapUnlimited,
  type BetaLaunchConfig,
} from "./config.js";

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

export interface BetaCheckInput {
  merchant: Merchant;
  amount: number;
  /** Optional clock override for deterministic tests. */
  now?: Date;
}

export interface BetaCheckTelemetry {
  enforced: boolean;
  cumulativeUsd: number;
  capUsd: number;
  remainingUsd: number;
}

/**
 * Enforces the Z22.1 beta launch protocol gates ahead of insertPayment.
 *
 * Three independent gates, each fail-closed:
 *
 *  1. Allowlist — merchant id must appear in `config.allowlist`. Rejected
 *     merchants 403 with `beta:allowlist`. The allowlist is curated and
 *     capped at `maxMerchants` (10) at config load time.
 *  2. Window expiry — once `launchAt + durationDays` has passed, all
 *     payments are 403'd with `beta:window_expired`. Operators flip
 *     `BETA_MODE_ENABLED=false` to graduate to GA.
 *  3. Merchant cap — cumulative non-failed payment volume since `launchAt`
 *     must stay below `merchantCapUsd` ($10k). Crossing the cap returns
 *     429 with `beta:merchant_cap`. Z30.5 introduced the `merchantCapUsd=0`
 *     sentinel which disables this third gate (allowlist + window stay on)
 *     so cap removal is a config flip with no code changes.
 *
 * No-op when `config.enabled=false`, which is the default in dev/test and
 * after the beta period closes.
 */
export function enforceBetaLimits(
  db: Db,
  config: BetaLaunchConfig,
  input: BetaCheckInput,
): BetaCheckTelemetry {
  if (!config.enabled) {
    return {
      enforced: false,
      cumulativeUsd: 0,
      capUsd: config.merchantCapUsd,
      remainingUsd: Number.POSITIVE_INFINITY,
    };
  }

  const { merchant, amount } = input;
  const now = input.now ?? new Date();

  if (!config.allowlist.has(merchant.id)) {
    throw HttpError.forbidden(
      "Merchant is not part of the beta launch cohort",
      {
        scope: "beta:allowlist",
        merchantId: merchant.id,
      },
    );
  }

  if (isBetaExpired(config, now)) {
    throw HttpError.forbidden("Beta launch window has ended", {
      scope: "beta:window_expired",
      merchantId: merchant.id,
      endedAt: betaEndsAt(config),
    });
  }

  const sinceIso = config.launchAt ?? EPOCH_ISO;
  const cumulativeUsd = sumPaymentAmountByMerchantSince(
    db,
    merchant.id,
    sinceIso,
  );
  const capUsd = config.merchantCapUsd;

  if (isMerchantCapUnlimited(config)) {
    return {
      enforced: true,
      cumulativeUsd,
      capUsd,
      remainingUsd: Number.POSITIVE_INFINITY,
    };
  }

  const remainingUsd = capUsd - cumulativeUsd;

  if (cumulativeUsd + amount > capUsd) {
    throw HttpError.rateLimited(
      `Beta merchant cap of $${capUsd} reached`,
      {
        scope: "beta:merchant_cap",
        merchantId: merchant.id,
        capUsd,
        cumulativeUsd,
        attempted: amount,
      },
    );
  }

  return {
    enforced: true,
    cumulativeUsd,
    capUsd,
    remainingUsd,
  };
}
