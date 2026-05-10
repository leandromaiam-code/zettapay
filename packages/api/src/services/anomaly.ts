import type { Database as Db } from "better-sqlite3";
import type { Merchant } from "../db/merchants.js";
import {
  listPayerPaymentHistory,
  type PayerHistoryRow,
} from "../db/payments.js";
import { appendAudit } from "../db/audit_journal.js";
import { HttpError } from "../lib/errors.js";

export type AnomalySignalKind =
  | "ip_geolocation_mismatch"
  | "time_of_day_anomaly"
  | "amount_zscore_anomaly";

export interface AnomalySignal {
  kind: AnomalySignalKind;
  weight: number;
  detail: Record<string, unknown>;
}

export interface AnomalyEvaluation {
  /** 0-100. Sum of fired signal weights, capped at 100. */
  score: number;
  signals: AnomalySignal[];
  /** True when score >= merchant.fraudBlockThreshold (and threshold > 0). */
  blocked: boolean;
  /** Sample size used for z-score / time-of-day baselines. */
  baselineSize: number;
}

export interface AnomalyCheckInput {
  merchant: Merchant;
  payerWallet: string;
  amount: number;
  /** Resolved country code for the incoming payment (null if geo lookup failed
   * or no IP was captured — country mismatch signal cannot fire either way). */
  payerCountry: string | null;
  /** Optional clock override for deterministic tests. */
  now?: Date;
}

// Lookback window for building per-payer baselines. 30 days balances signal
// freshness against data sufficiency for low-frequency payers. Beyond 30 days,
// behavior shifts (laptop swap, travel, new automation) are noise, not signal.
const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60_000;

// Need at least this many prior payments before z-score / time-of-day fire.
// With <5 samples the variance estimate is junk and false-positive rate is
// unacceptable. Country mismatch fires from 1 prior payment — a single known
// country is enough to flag a switch.
const MIN_BASELINE_FOR_DISTRIBUTION = 5;
const MIN_BASELINE_FOR_COUNTRY = 1;

// Z-score threshold. |z| > 3 means the amount is more than 3 standard
// deviations from the wallet's historical mean — a 0.3% probability event
// under a normal distribution. Higher = fewer false positives but missed fraud.
const Z_SCORE_THRESHOLD = 3;

// Per-signal weights — chosen so any single high-confidence signal lands
// below the recommended block threshold (60), but two signals together
// trigger a block. Country mismatch weighted highest because it's the
// least false-positive-prone (a known foreign IP is a strong signal).
const WEIGHT_IP_MISMATCH = 40;
const WEIGHT_TIME_ANOMALY = 25;
const WEIGHT_AMOUNT_ZSCORE = 35;

/** A payer is considered "active" in an hour bucket when at least this share
 * of their historical payments fell in that hour. Below the threshold the
 * hour is treated as off-pattern. 5% is permissive enough that a payer with
 * 20 prior payments needs to have hit a given hour at least once. */
const ACTIVE_HOUR_FREQUENCY = 0.05;

/**
 * Z13.3 anomaly detector. Inspects three independent signals against the
 * payer's recent history and returns a composite risk score. Always audits
 * detected signals (even when below the merchant's block threshold) so
 * security teams can backtest tuning. Throws 429 when score crosses the
 * configured threshold; merchants opt in to blocking by setting it > 0.
 */
export function evaluatePaymentAnomalies(
  db: Db,
  input: AnomalyCheckInput,
): AnomalyEvaluation {
  const { merchant, payerWallet, amount, payerCountry } = input;
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - HISTORY_WINDOW_MS).toISOString();

  // Cap at 200 — enough for a tight z-score on a high-volume wallet without
  // unbounded growth in row scan cost on hot payers.
  const history = listPayerPaymentHistory(db, merchant.id, payerWallet, since, 200);
  const signals: AnomalySignal[] = [];

  const countryMismatch = detectCountryMismatch(history, payerCountry);
  if (countryMismatch) signals.push(countryMismatch);

  const timeAnomaly = detectTimeOfDayAnomaly(history, now);
  if (timeAnomaly) signals.push(timeAnomaly);

  const zScoreAnomaly = detectAmountZScoreAnomaly(history, amount);
  if (zScoreAnomaly) signals.push(zScoreAnomaly);

  const score = Math.min(
    100,
    signals.reduce((acc, s) => acc + s.weight, 0),
  );

  const threshold = merchant.fraudBlockThreshold;
  const blocked = threshold > 0 && score >= threshold;

  if (signals.length > 0) {
    appendAudit(db, {
      actor: `payer:${payerWallet}`,
      event: blocked
        ? "payment.blocked.anomaly"
        : "payment.anomaly_detected",
      entityType: "merchant",
      entityId: merchant.id,
      reason: `anomaly score ${score} (threshold ${threshold}) — ${signals
        .map((s) => s.kind)
        .join(",")}`,
      payload: {
        score,
        threshold,
        blocked,
        baselineSize: history.length,
        amount,
        payerCountry,
        signals,
      },
    });
  }

  if (blocked) {
    throw HttpError.rateLimited(
      `Payment blocked: anomaly score ${score} >= threshold ${threshold}`,
      {
        scope: "anomaly:fraud_block_threshold",
        merchantId: merchant.id,
        payerWallet,
        score,
        threshold,
        signals: signals.map((s) => s.kind),
      },
    );
  }

  return { score, signals, blocked, baselineSize: history.length };
}

function detectCountryMismatch(
  history: PayerHistoryRow[],
  payerCountry: string | null,
): AnomalySignal | null {
  if (!payerCountry) return null;
  const known = new Set<string>();
  for (const row of history) {
    if (row.country) known.add(row.country);
  }
  if (known.size < MIN_BASELINE_FOR_COUNTRY) return null;
  if (known.has(payerCountry)) return null;
  return {
    kind: "ip_geolocation_mismatch",
    weight: WEIGHT_IP_MISMATCH,
    detail: {
      currentCountry: payerCountry,
      knownCountries: Array.from(known),
    },
  };
}

function detectTimeOfDayAnomaly(
  history: PayerHistoryRow[],
  now: Date,
): AnomalySignal | null {
  if (history.length < MIN_BASELINE_FOR_DISTRIBUTION) return null;
  const hourCounts = new Array<number>(24).fill(0);
  for (const row of history) {
    const hour = new Date(row.createdAt).getUTCHours();
    if (hour >= 0 && hour < 24) hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;
  }
  const total = history.length;
  const currentHour = now.getUTCHours();
  const currentCount = hourCounts[currentHour] ?? 0;
  const frequency = currentCount / total;
  if (frequency >= ACTIVE_HOUR_FREQUENCY) return null;
  return {
    kind: "time_of_day_anomaly",
    weight: WEIGHT_TIME_ANOMALY,
    detail: {
      hourUtc: currentHour,
      observedCount: currentCount,
      historicalSamples: total,
      activeHourThreshold: ACTIVE_HOUR_FREQUENCY,
    },
  };
}

function detectAmountZScoreAnomaly(
  history: PayerHistoryRow[],
  amount: number,
): AnomalySignal | null {
  if (history.length < MIN_BASELINE_FOR_DISTRIBUTION) return null;
  const amounts = history.map((r) => r.amountUsdc);
  const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const variance =
    amounts.reduce((acc, v) => acc + (v - mean) ** 2, 0) / amounts.length;
  const stddev = Math.sqrt(variance);
  // Stddev=0 means every prior payment was the same amount — anything
  // different is by definition unusual, but we want a numeric ratio. Skip
  // z-score in that case; the count of priors will speak for itself if
  // the amount diverges materially via the time/country signals.
  if (stddev === 0) return null;
  const z = (amount - mean) / stddev;
  if (Math.abs(z) <= Z_SCORE_THRESHOLD) return null;
  return {
    kind: "amount_zscore_anomaly",
    weight: WEIGHT_AMOUNT_ZSCORE,
    detail: {
      amount,
      mean,
      stddev,
      zScore: z,
      threshold: Z_SCORE_THRESHOLD,
      historicalSamples: history.length,
    },
  };
}
