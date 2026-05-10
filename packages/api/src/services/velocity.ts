import type { Database as Db } from "better-sqlite3";
import {
  countPaymentsByPayerSince,
  sumPaymentAmountByMerchantSince,
} from "../db/payments.js";
import type { Merchant } from "../db/merchants.js";
import { appendAudit } from "../db/audit_journal.js";
import { HttpError } from "../lib/errors.js";

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * 60_000;

export interface VelocityCheckInput {
  merchant: Merchant;
  payerWallet: string;
  amount: number;
  /** Optional clock override for deterministic tests. */
  now?: Date;
}

export interface VelocityCheckTelemetry {
  payerCountInWindow: number;
  merchantSpendInWindow: number;
  perMinuteLimit: number;
  perHourAmountLimit: number;
}

/**
 * Sliding-window fraud throttle (Z13.1). Two independent caps, both
 * configurable per merchant:
 *
 *  - per-payer-wallet: at most N payments in any 60s window (default 5)
 *  - per-merchant:     at most $X total amount in any 1h window (default $1000)
 *
 * Treats the canonical `amount_usdc` column as USD-equivalent — acceptable
 * for v1 since merchants opting into non-USD-pegged stables will tune
 * `maxAmountPerHour` accordingly. Throws 429 `rate_limited` if either
 * cap would be exceeded by the incoming payment.
 *
 * A `0` value on either limit disables that cap (escape hatch for
 * trusted high-velocity merchants — config_max gate is the merchant
 * config endpoint, not this enforcer).
 */
export function enforceVelocityLimits(
  db: Db,
  input: VelocityCheckInput,
): VelocityCheckTelemetry {
  const { merchant, payerWallet, amount } = input;
  const now = input.now ?? new Date();

  const minuteWindowStart = new Date(now.getTime() - ONE_MINUTE_MS).toISOString();
  const hourWindowStart = new Date(now.getTime() - ONE_HOUR_MS).toISOString();

  const perMinuteLimit = merchant.velocity.maxPaymentsPerMinute;
  const perHourAmountLimit = merchant.velocity.maxAmountPerHour;

  const payerCountInWindow = countPaymentsByPayerSince(
    db,
    merchant.id,
    payerWallet,
    minuteWindowStart,
  );
  const merchantSpendInWindow = sumPaymentAmountByMerchantSince(
    db,
    merchant.id,
    hourWindowStart,
  );

  if (perMinuteLimit > 0 && payerCountInWindow + 1 > perMinuteLimit) {
    appendAudit(db, {
      actor: `payer:${payerWallet}`,
      event: "payment.blocked.velocity",
      entityType: "merchant",
      entityId: merchant.id,
      reason: `per-wallet velocity exceeded (${payerCountInWindow}/${perMinuteLimit} per minute)`,
      payload: { scope: "per_wallet_per_minute", limit: perMinuteLimit, observed: payerCountInWindow, amount },
    });
    throw HttpError.rateLimited(
      `Wallet exceeded velocity limit of ${perMinuteLimit} payments per minute`,
      {
        scope: "velocity:per_wallet_per_minute",
        merchantId: merchant.id,
        payerWallet,
        limit: perMinuteLimit,
        observed: payerCountInWindow,
        windowSec: 60,
      },
    );
  }

  if (
    perHourAmountLimit > 0 &&
    merchantSpendInWindow + amount > perHourAmountLimit
  ) {
    appendAudit(db, {
      actor: `payer:${payerWallet}`,
      event: "payment.blocked.velocity",
      entityType: "merchant",
      entityId: merchant.id,
      reason: `per-merchant amount cap exceeded (${merchantSpendInWindow}+${amount}/${perHourAmountLimit} per hour)`,
      payload: { scope: "per_merchant_per_hour", limit: perHourAmountLimit, observed: merchantSpendInWindow, amount },
    });
    throw HttpError.rateLimited(
      `Merchant exceeded velocity limit of ${perHourAmountLimit} per hour`,
      {
        scope: "velocity:per_merchant_per_hour",
        merchantId: merchant.id,
        limit: perHourAmountLimit,
        observed: merchantSpendInWindow,
        attempted: amount,
        windowSec: 3600,
      },
    );
  }

  return {
    payerCountInWindow,
    merchantSpendInWindow,
    perMinuteLimit,
    perHourAmountLimit,
  };
}
