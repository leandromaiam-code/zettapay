import type { Database as Db } from "better-sqlite3";
import { sumPaymentAmountByMerchantSince } from "../db/payments.js";
import {
  betaEndsAt,
  isBetaExpired,
  isMerchantCapUnlimited,
  type BetaLaunchConfig,
} from "./config.js";

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

export interface MerchantBetaUtilization {
  merchantId: string;
  cumulativeUsd: number;
  capUsd: number;
  utilizationPct: number;
  remainingUsd: number;
  exhausted: boolean;
}

export interface BetaStatusSnapshot {
  enabled: boolean;
  launchAt: string | null;
  endsAt: string | null;
  durationDays: number;
  daysRemaining: number | null;
  expired: boolean;
  capUsd: number;
  maxMerchants: number;
  allowlistSize: number;
  utilization: MerchantBetaUtilization[];
  totals: {
    cumulativeUsd: number;
    capUsd: number;
    utilizationPct: number;
    merchantsExhausted: number;
  };
  generatedAt: string;
}

function computeDaysRemaining(
  endsAt: string | null,
  now: Date,
): number | null {
  if (!endsAt) return null;
  const ms = Date.parse(endsAt) - now.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60_000));
}

function utilizationPct(used: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(100, Math.round((used / cap) * 1000) / 10);
}

function remainingForMerchant(cap: number, cumulative: number): number {
  if (cap <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, cap - cumulative);
}

/**
 * Computes a snapshot of beta-launch utilization for the operator console
 * and Prometheus exporter. Cheap to call (single SUM per allowlisted
 * merchant against an indexed (merchant_id, created_at) range).
 */
export function betaStatusSnapshot(
  db: Db,
  config: BetaLaunchConfig,
  now: Date = new Date(),
): BetaStatusSnapshot {
  const sinceIso = config.launchAt ?? EPOCH_ISO;
  const endsAt = betaEndsAt(config);
  const allowlistIds = Array.from(config.allowlist);
  const capRemoved = isMerchantCapUnlimited(config);

  const utilization: MerchantBetaUtilization[] = allowlistIds.map(
    (merchantId) => {
      const cumulativeUsd = sumPaymentAmountByMerchantSince(
        db,
        merchantId,
        sinceIso,
      );
      return {
        merchantId,
        cumulativeUsd,
        capUsd: config.merchantCapUsd,
        utilizationPct: utilizationPct(cumulativeUsd, config.merchantCapUsd),
        remainingUsd: remainingForMerchant(config.merchantCapUsd, cumulativeUsd),
        exhausted: capRemoved ? false : cumulativeUsd >= config.merchantCapUsd,
      };
    },
  );

  const cumulativeTotal = utilization.reduce(
    (acc, m) => acc + m.cumulativeUsd,
    0,
  );
  const capTotal = config.merchantCapUsd * utilization.length;
  const merchantsExhausted = utilization.filter((m) => m.exhausted).length;

  return {
    enabled: config.enabled,
    launchAt: config.launchAt,
    endsAt,
    durationDays: config.durationDays,
    daysRemaining: computeDaysRemaining(endsAt, now),
    expired: isBetaExpired(config, now),
    capUsd: config.merchantCapUsd,
    maxMerchants: config.maxMerchants,
    allowlistSize: allowlistIds.length,
    utilization,
    totals: {
      cumulativeUsd: cumulativeTotal,
      capUsd: capTotal,
      utilizationPct: utilizationPct(cumulativeTotal, capTotal),
      merchantsExhausted,
    },
    generatedAt: now.toISOString(),
  };
}
